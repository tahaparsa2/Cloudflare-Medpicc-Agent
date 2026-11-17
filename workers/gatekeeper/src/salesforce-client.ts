/**
 * The only code in the project that talks to Salesforce, and the only place
 * the consumer key and secret are used. OAuth client credentials flow.
 */

export interface SalesforceConfig {
  /** The org's My Domain URL. */
  loginUrl: string;
  consumerKey: string;
  consumerSecret: string;
  /** e.g. "v68.0" */
  apiVersion: string;
}

export class SalesforceError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: string | null,
  ) {
    super(message);
  }
}

/** A 15 or 18 character Opportunity id. Checked before it goes anywhere near a query. */
export const OPPORTUNITY_ID = /^006[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/;

const QUERY_FIELD = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)?$/;

interface Token {
  accessToken: string;
  instanceUrl: string;
}

export class SalesforceClient {
  private token: Token | null = null;

  constructor(private readonly config: SalesforceConfig) {}

  /** Field values as text, null when empty. Keys are the names asked for, e.g. "Account.Name". */
  async readOpportunity(id: string, fields: readonly string[]): Promise<Record<string, string | null>> {
    assertOpportunityId(id);
    for (const field of fields) {
      if (!QUERY_FIELD.test(field)) throw new SalesforceError(`not a field name: ${field}`, null, null);
    }
    const soql = `SELECT Id, ${fields.join(", ")} FROM Opportunity WHERE Id = '${id}'`;
    const response = await this.request("GET", `/query?q=${encodeURIComponent(soql)}`);
    const body = (await response.json()) as { records?: Record<string, unknown>[] };
    const record = body.records?.[0];
    if (!record) throw new SalesforceError(`no opportunity with id ${id}`, 404, "NOT_FOUND");

    const values: Record<string, string | null> = {};
    for (const field of fields) {
      let value: unknown = record;
      for (const part of field.split(".")) {
        value = value !== null && typeof value === "object" ? (value as Record<string, unknown>)[part] : null;
      }
      values[field] = value === null || value === undefined ? null : String(value);
    }
    return values;
  }

  async updateOpportunity(id: string, values: Record<string, string>): Promise<void> {
    assertOpportunityId(id);
    await this.request("PATCH", `/sobjects/Opportunity/${id}`, values);
  }

  private async request(method: string, path: string, body?: unknown, retried = false): Promise<Response> {
    const token = this.token ?? (this.token = await this.fetchToken());
    const response = await fetch(`${token.instanceUrl}/services/data/${this.config.apiVersion}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token.accessToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 401 && !retried) {
      // The cached token expired or was revoked. Get a new one, once.
      this.token = null;
      return this.request(method, path, body, true);
    }
    if (!response.ok) throw await toError(response, `Salesforce ${method} failed`);
    return response;
  }

  private async fetchToken(): Promise<Token> {
    const { loginUrl, consumerKey, consumerSecret } = this.config;
    if (!loginUrl || !consumerKey || !consumerSecret) {
      throw new SalesforceError("the Salesforce credential is not configured", null, "NOT_CONFIGURED");
    }
    const response = await fetch(`${loginUrl.replace(/\/+$/, "")}/services/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: consumerKey,
        client_secret: consumerSecret,
      }),
    });
    if (!response.ok) throw await toError(response, "Salesforce sign-in failed");
    const body = (await response.json()) as { access_token?: string; instance_url?: string };
    if (!body.access_token || !body.instance_url) {
      throw new SalesforceError("Salesforce sign-in returned no token", response.status, null);
    }
    return { accessToken: body.access_token, instanceUrl: body.instance_url };
  }
}

function assertOpportunityId(id: string): void {
  if (!OPPORTUNITY_ID.test(id)) throw new SalesforceError("not an Opportunity id", null, "INVALID_ID");
}

/** Salesforce errors come as `[{ message, errorCode }]` or, from the token endpoint, `{ error, error_description }`. */
async function toError(response: Response, prefix: string): Promise<SalesforceError> {
  let message = `HTTP ${response.status}`;
  let code: string | null = null;
  try {
    const body: unknown = await response.json();
    const first = (Array.isArray(body) ? body[0] : body) as Record<string, unknown> | undefined;
    const text = first?.message ?? first?.error_description;
    if (typeof text === "string") message = text;
    const errorCode = first?.errorCode ?? first?.error;
    if (typeof errorCode === "string") code = errorCode;
  } catch {
    // Not JSON. The status code is all there is.
  }
  return new SalesforceError(`${prefix}: ${message}`, response.status, code);
}
