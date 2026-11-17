import { env } from "cloudflare:test";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWK } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessVerifier, NOT_CONFIGURED, accessConfig, accessSetup } from "../src/access";
import type { AuditRow } from "../src/types";
import { FakeSalesforce, OPP } from "./fake-salesforce";

const TEAM = "https://test-team.cloudflareaccess.com";
const AUD = "a".repeat(64);
const CONFIG = { teamDomain: TEAM, audience: AUD };

let signingKey: CryptoKey;
let otherKey: CryptoKey;
let publicJwk: JWK;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  signingKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: "key-1", alg: "RS256", use: "sig" };
  otherKey = (await generateKeyPair("RS256", { extractable: true })).privateKey;
});

/** A token as Access issues one, with any part changed. */
function token(change: { claims?: Record<string, unknown>; issuer?: string; audience?: string; expires?: string | number; key?: CryptoKey; kid?: string } = {}) {
  return new SignJWT({ email: "taha@example.test", type: "app", ...change.claims })
    .setProtectedHeader({ alg: "RS256", kid: change.kid ?? "key-1" })
    .setIssuer(change.issuer ?? TEAM)
    .setAudience(change.audience ?? AUD)
    .setIssuedAt()
    .setExpirationTime(change.expires ?? "5m")
    .sign(change.key ?? signingKey);
}

describe("accessConfig", () => {
  it.each<[string, string | undefined, string | undefined, object | null]>([
    ["both values", TEAM, AUD, CONFIG],
    ["a trailing slash on the team domain", `${TEAM}/`, AUD, CONFIG],
    ["no team domain", "", AUD, null],
    ["no audience", TEAM, "", null],
    ["nothing", undefined, undefined, null],
    ["a team domain on another host", "https://test-team.example.com", AUD, null],
    ["a team domain over http", "http://test-team.cloudflareaccess.com", AUD, null],
    ["an audience that is not an AUD tag", TEAM, "my-app", null],
  ])("%s", (_label, teamDomain, audience, expected) => {
    expect(accessConfig(teamDomain, audience)).toEqual(expected);
  });
});

describe("accessSetup", () => {
  it("says plainly when nothing is set", () => {
    expect(accessSetup(undefined, "")).toEqual({ ok: false, reason: NOT_CONFIGURED });
  });

  it.each<[string, string, string, string]>([
    ["a team domain without https://", "test-team.cloudflareaccess.com", AUD, "TEAM_DOMAIN is not in the form"],
    ["a team name alone", "test-team", AUD, "TEAM_DOMAIN is not in the form"],
    ["an audience of the wrong length", TEAM, "abc123", "POLICY_AUD is not a 64-character AUD tag"],
    ["only the team domain", TEAM, "", "POLICY_AUD is not set"],
    ["only the audience", "", AUD, "TEAM_DOMAIN is not set"],
  ])("names the value at fault for %s, without repeating it", (_label, teamDomain, audience, expected) => {
    const setup = accessSetup(teamDomain, audience);
    expect(setup).toMatchObject({ ok: false, reason: expect.stringContaining(expected) });
    if (setup.ok) return;
    if (audience && audience !== AUD) expect(setup.reason).not.toContain(audience);
    if (teamDomain && teamDomain !== TEAM) expect(setup.reason).not.toContain(teamDomain);
  });

  it("gives that reason to anyone who then presents a token", async () => {
    const verifier = new AccessVerifier(accessSetup("test-team", AUD));
    expect(await verifier.identify(await token())).toMatchObject({ ok: false, reason: expect.stringContaining("TEAM_DOMAIN is not in the form") });
  });
});

describe("AccessVerifier", () => {
  const verifier = () => new AccessVerifier(CONFIG, createLocalJWKSet({ keys: [publicJwk] }));

  it("names the person a valid token was issued to", async () => {
    expect(await verifier().identify(await token())).toEqual({ ok: true, label: "user:taha@example.test", person: true });
  });

  it("lowercases the email, so one person has one name in the audit log", async () => {
    expect(await verifier().identify(await token({ claims: { email: "Taha@Example.Test" } }))).toMatchObject({ label: "user:taha@example.test" });
  });

  it.each<[string, Parameters<typeof token>[0]]>([
    ["signed with a key Access does not publish", { key: undefined as unknown as CryptoKey }],
    ["issued by another team", { issuer: "https://other-team.cloudflareaccess.com" }],
    ["issued for another application", { audience: "b".repeat(64) }],
    ["that has expired", { expires: Math.floor(Date.now() / 1000) - 60 }],
    ["naming a key id Access does not publish", { kid: "key-9" }],
  ])("refuses a token %s", async (label, change) => {
    const made = await token(label.startsWith("signed with") ? { key: otherKey } : change);
    const result = await verifier().identify(made);
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("did not verify") });
  });

  it.each<[string, Record<string, unknown>]>([
    ["no email, as a service token has", { email: undefined, common_name: "service-token-client-id" }],
    ["an empty email", { email: "" }],
    ["an email that is not text", { email: ["taha@example.test"] }],
    ["an email that could pass for another kind of caller", { email: "agent:robot@example.test" }],
  ])("refuses a valid token with %s", async (_label, claims) => {
    const result = await verifier().identify(await token({ claims }));
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("names no person") });
  });

  it("refuses a token with a tampered payload", async () => {
    const [header, payload, signature] = (await token()).split(".");
    const forged = JSON.parse(atob(payload!.replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, unknown>;
    forged.email = "boss@example.test";
    const body = btoa(JSON.stringify(forged)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(await verifier().identify(`${header}.${body}.${signature}`)).toMatchObject({ ok: false });
  });

  it("refuses an unsigned token that claims alg none", async () => {
    const b64 = (value: object) => btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const unsigned = `${b64({ alg: "none", kid: "key-1" })}.${b64({ email: "boss@example.test", iss: TEAM, aud: AUD, exp: Math.floor(Date.now() / 1000) + 300 })}.`;
    expect(await verifier().identify(unsigned)).toMatchObject({ ok: false });
  });

  it.each<[string, unknown]>([
    ["nothing", undefined],
    ["an empty string", ""],
    ["text that is not a token", "not-a-token"],
    ["a number", 42],
    ["a very long string", "x".repeat(9000)],
  ])("refuses %s", async (_label, value) => {
    expect(await verifier().identify(value)).toMatchObject({ ok: false });
  });

  it("accepts no token at all when Access is not configured", async () => {
    const unconfigured = new AccessVerifier(null);
    expect(await unconfigured.identify(await token())).toEqual({ ok: false, reason: NOT_CONFIGURED });
  });
});

describe("the gatekeeper with a Cloudflare Access token", () => {
  let salesforce: FakeSalesforce;
  let gatekeeper: ReturnType<typeof env.GATEKEEPER.getByName>;
  let certRequests: number;

  beforeEach(() => {
    salesforce = new FakeSalesforce();
    certRequests = 0;
    // Access's published keys, served from the team domain. Everything else is the fake Salesforce.
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === `${TEAM}/cdn-cgi/access/certs`) {
        certRequests += 1;
        return Promise.resolve(Response.json({ keys: [publicJwk] }));
      }
      return salesforce.fetch(input, init);
    });
    gatekeeper = env.GATEKEEPER.getByName(`access-${crypto.randomUUID()}`);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const audit = (): Promise<AuditRow[]> => gatekeeper.listAudit();

  it("says who a valid token names, and who the dev identity is", async () => {
    expect(await gatekeeper.whoIs({ kind: "access_jwt", token: await token() })).toEqual({ ok: true, label: "user:taha@example.test", kind: "access" });
    expect(await gatekeeper.whoIs({ kind: "dev" })).toEqual({ ok: true, label: "dev:rep@example.test", kind: "dev" });
    expect(await audit()).toEqual([]);
  });

  it("does not let an agent pass for a person", async () => {
    const asAgent = { kind: "agent", id: "meddpicc-agent/test" } as unknown as { kind: "dev" };
    expect(await gatekeeper.whoIs(asAgent)).toEqual({ ok: false, reason: "that is not a person" });
  });

  it("records an approval under the person's email, and writes it", async () => {
    const proof = { kind: "access_jwt" as const, token: await token() };
    const read = await gatekeeper.readOpportunity({ opportunityId: OPP, actor: { kind: "agent", id: "meddpicc-agent/test" } });
    if (!read.ok) throw new Error(read.reason);

    const decision = await gatekeeper.recordDecision({ opportunityId: OPP, proposalId: "p1", field: "Champion__c", decision: "approve", value: "Priya Raman", approver: proof });
    expect(decision).toMatchObject({ ok: true, approver: "user:taha@example.test" });

    const [result] = await gatekeeper.applyApprovedUpdate({ opportunityId: OPP, proposalId: "p1", snapshotId: read.snapshotId, fields: [{ field: "Champion__c", value: "Priya Raman" }], actor: proof });
    expect(result).toMatchObject({ outcome: "written", reason: "approved by user:taha@example.test" });
    expect(salesforce.writes).toHaveLength(1);

    const rows = await audit();
    expect(rows.filter((row) => row.action === "approve" || row.action === "write").map((row) => row.actor)).toEqual(["user:taha@example.test", "user:taha@example.test"]);
    expect(certRequests).toBe(1);
  });

  it.each<[string, () => Promise<string>]>([
    ["a token for another application", () => token({ audience: "b".repeat(64) })],
    ["an expired token", () => token({ expires: Math.floor(Date.now() / 1000) - 60 })],
    ["a token signed with another key", () => token({ key: otherKey })],
    ["a service token, which names no person", () => token({ claims: { email: undefined } })],
  ])("refuses an approval that comes with %s, and logs the refusal", async (_label, make) => {
    const decision = await gatekeeper.recordDecision({ opportunityId: OPP, proposalId: "p1", field: "Champion__c", decision: "approve", value: "Priya Raman", approver: { kind: "access_jwt", token: await make() } });
    expect(decision).toMatchObject({ ok: false, code: "not_a_person" });
    const rows = await audit();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: "unidentified", action: "refuse", outcome: "refused", field: "Champion__c" });
    expect(salesforce.writes).toHaveLength(0);
  });
});
