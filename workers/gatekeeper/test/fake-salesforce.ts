/**
 * A stand-in for the three Salesforce endpoints the gatekeeper uses.
 * Install with `vi.stubGlobal("fetch", fake.fetch)`. Any other URL throws,
 * so a test cannot reach the network by accident.
 */

export const LOGIN_URL = "https://salesforce.test";
export const INSTANCE_URL = "https://instance.salesforce.test";
export const OPP = "006000000000001AAA";
export const OTHER_OPP = "006000000000002AAA";

export interface Recorded {
  method: string;
  path: string;
  body: unknown;
  authorization: string | null;
}

export class FakeSalesforce {
  /** Flat records by id. Relationship fields use dotted keys, e.g. "Account.Name". */
  records = new Map<string, Record<string, string | number | null>>();
  requests: Recorded[] = [];
  tokensIssued = 0;
  /** Set to make the next sign-in, read or write fail. */
  failSignIn = false;
  failNextRead = false;
  failNextWrite = false;
  /** Set to make the next API call answer 401 once, as an expired token would. */
  expireTokenOnce = false;
  /** Makes every API call take this long, so concurrent callers really overlap. */
  delayMs = 0;

  constructor() {
    this.records.set(OPP, blankOpportunity("Tessaline Freight - New Business"));
    this.records.set(OTHER_OPP, blankOpportunity("Another Opportunity"));
  }

  get reads(): Recorded[] {
    return this.requests.filter((r) => r.method === "GET");
  }

  get writes(): Recorded[] {
    return this.requests.filter((r) => r.method === "PATCH");
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    // Decoded by hand: the runtime warns when .text() is called on a form-encoded body.
    const text = request.method === "GET" ? "" : new TextDecoder().decode(await request.arrayBuffer());

    if (url.origin === LOGIN_URL && url.pathname === "/services/oauth2/token") {
      const form = new URLSearchParams(text);
      if (
        this.failSignIn ||
        form.get("grant_type") !== "client_credentials" ||
        form.get("client_id") !== "test-consumer-key" ||
        form.get("client_secret") !== "test-consumer-secret"
      ) {
        return Response.json({ error: "invalid_client", error_description: "invalid client credentials" }, { status: 400 });
      }
      this.tokensIssued += 1;
      return Response.json({ access_token: `token-${this.tokensIssued}`, instance_url: INSTANCE_URL });
    }

    if (url.origin !== INSTANCE_URL) throw new Error(`unexpected request to ${request.url}`);

    const path = url.pathname.replace(/^\/services\/data\/v[\d.]+/, "");
    const authorization = request.headers.get("authorization");
    this.requests.push({ method: request.method, path, body: text ? JSON.parse(text) : null, authorization });

    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));

    if (this.expireTokenOnce) {
      this.expireTokenOnce = false;
      return Response.json([{ message: "Session expired or invalid", errorCode: "INVALID_SESSION_ID" }], { status: 401 });
    }
    if (authorization !== `Bearer token-${this.tokensIssued}`) {
      return Response.json([{ message: "Session expired or invalid", errorCode: "INVALID_SESSION_ID" }], { status: 401 });
    }

    if (request.method === "GET" && path === "/query") {
      if (this.failNextRead) {
        this.failNextRead = false;
        return Response.json([{ message: "The service is down", errorCode: "SERVER_UNAVAILABLE" }], { status: 503 });
      }
      const soql = url.searchParams.get("q") ?? "";
      const match = /^SELECT Id, (.+) FROM Opportunity WHERE Id = '(\w+)'$/.exec(soql);
      if (!match) return Response.json([{ message: `bad query: ${soql}`, errorCode: "MALFORMED_QUERY" }], { status: 400 });
      const record = this.records.get(match[2]!);
      if (!record) return Response.json({ totalSize: 0, records: [] });
      const out: Record<string, unknown> = { Id: match[2] };
      for (const field of match[1]!.split(", ")) {
        const [first, second] = field.split(".");
        if (second) out[first!] = { ...(out[first!] as object), [second]: record[field] ?? null };
        else out[field] = record[field] ?? null;
      }
      return Response.json({ totalSize: 1, records: [out] });
    }

    const write = /^\/sobjects\/Opportunity\/(\w+)$/.exec(path);
    if (request.method === "PATCH" && write) {
      if (this.failNextWrite) {
        this.failNextWrite = false;
        return Response.json([{ message: "Unable to lock row", errorCode: "UNABLE_TO_LOCK_ROW" }], { status: 400 });
      }
      const record = this.records.get(write[1]!);
      if (!record) return Response.json([{ message: "not found", errorCode: "NOT_FOUND" }], { status: 404 });
      Object.assign(record, JSON.parse(text));
      return new Response(null, { status: 204 });
    }

    throw new Error(`unexpected Salesforce call: ${request.method} ${path}`);
  };
}

function blankOpportunity(name: string): Record<string, string | number | null> {
  return {
    Name: name,
    "Account.Name": "Tessaline Freight",
    CloseDate: "2026-12-18",
    Amount: 84000,
    StageName: "Qualification",
    ForecastCategoryName: "Pipeline",
    Metrics__c: null,
    Economic_Buyer__c: null,
    Decision_Criteria__c: null,
    Decision_Process__c: null,
    Paper_Process__c: null,
    Identified_Pain__c: null,
    Champion__c: null,
    Competition__c: null,
  };
}
