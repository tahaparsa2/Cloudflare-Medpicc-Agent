import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { identifyCaller } from "../src/identity";
import { POLICY } from "../src/salesforce";
import type { AuditRow, Caller, PersonEvidence } from "../src/types";
import { FakeSalesforce, LOGIN_URL, OPP, OTHER_OPP } from "./fake-salesforce";

const AGENT: Caller = { kind: "agent", id: "meddpicc-agent/test" };
const REP: PersonEvidence = { kind: "dev" };
const REP_LABEL = "dev:rep@example.test";

let salesforce: FakeSalesforce;
let gatekeeper: ReturnType<typeof env.GATEKEEPER.getByName>;

beforeEach(() => {
  salesforce = new FakeSalesforce();
  vi.stubGlobal("fetch", salesforce.fetch);
  // A fresh gatekeeper, with its own storage, for every test.
  gatekeeper = env.GATEKEEPER.getByName(`test-${crypto.randomUUID()}`);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Read, then record an approval for each field. Returns what an apply call needs. */
async function draftAndApprove(fields: Record<string, string>, proposalId = "p1") {
  const read = await gatekeeper.readOpportunity({ opportunityId: OPP, actor: AGENT });
  if (!read.ok) throw new Error(read.reason);
  for (const [field, value] of Object.entries(fields)) {
    const decision = await gatekeeper.recordDecision({ opportunityId: OPP, proposalId, field, decision: "approve", value, approver: REP });
    if (!decision.ok) throw new Error(decision.reason);
  }
  return {
    opportunityId: OPP,
    proposalId,
    snapshotId: read.snapshotId,
    fields: Object.entries(fields).map(([field, value]) => ({ field, value })),
    actor: AGENT,
  };
}

const audit = (): Promise<AuditRow[]> => gatekeeper.listAudit();
const summary = (rows: AuditRow[]) => rows.map((r) => `${r.action}:${r.outcome}${r.field ? `:${r.field}` : ""}`);

describe("test setup", () => {
  it("points at the fake Salesforce, whatever a local .dev.vars holds", () => {
    expect(env.SF_LOGIN_URL).toBe(LOGIN_URL);
    expect(env.SF_CONSUMER_KEY).toBe("test-consumer-key");
    expect(env.SF_CONSUMER_SECRET).toBe("test-consumer-secret");
  });

  it("has no HTTP surface", async () => {
    const response = await SELF.fetch("https://gatekeeper.test/anything");
    expect(response.status).toBe(404);
  });
});

describe("identifyCaller", () => {
  it.each<[string, unknown, string | undefined, object]>([
    ["an agent", { kind: "agent", id: "meddpicc-agent/006x" }, undefined, { ok: true, label: "agent:meddpicc-agent/006x", person: false }],
    ["an agent with no id", { kind: "agent" }, undefined, { ok: false }],
    ["an agent with a malformed id", { kind: "agent", id: "a b\nc" }, undefined, { ok: false }],
    ["an agent calling itself a user", { kind: "agent", id: "user:boss" }, undefined, { ok: true, label: "agent:user:boss", person: false }],
    ["an agent using an email address as its id", { kind: "agent", id: "boss@example.test" }, undefined, { ok: false }],
    ["the dev identity where it is enabled", { kind: "dev" }, "rep@example.test", { ok: true, label: "dev:rep@example.test", person: true }],
    ["the dev identity where it is not set", { kind: "dev" }, undefined, { ok: false }],
    ["the dev identity where it is blank", { kind: "dev" }, "  ", { ok: false }],
    ["a dev caller that brings its own name", { kind: "dev", email: "boss@example.test" }, "rep@example.test", { ok: true, label: "dev:rep@example.test", person: true }],
    ["an Access token, which this function never accepts unverified", { kind: "access_jwt", token: "x.y.z" }, "rep@example.test", { ok: false }],
    ["an unknown kind", { kind: "person", email: "boss@example.test" }, "rep@example.test", { ok: false }],
    ["nothing", undefined, "rep@example.test", { ok: false }],
  ])("%s", (_label, caller, devIdentity, expected) => {
    expect(identifyCaller(caller as Caller, devIdentity)).toMatchObject(expected);
  });
});

describe("readOpportunity", () => {
  it("returns the policy-readable fields and logs the read", async () => {
    const result = await gatekeeper.readOpportunity({ opportunityId: OPP, actor: AGENT });
    expect(result).toMatchObject({ ok: true, opportunityId: OPP });
    if (!result.ok) return;
    expect(result.fields).toMatchObject({
      Name: "Tessaline Freight - New Business",
      "Account.Name": "Tessaline Freight",
      CloseDate: "2026-12-18",
      Amount: "84000",
      StageName: "Qualification",
      Champion__c: null,
    });
    expect(Object.keys(result.fields)).toHaveLength(14);
    expect(result.snapshotId).toMatch(/^[0-9a-f-]{36}$/);

    const rows = await audit();
    expect(summary(rows)).toEqual(["read:allowed"]);
    expect(rows[0]).toMatchObject({ actor: "agent:meddpicc-agent/test", opportunity_id: OPP, policy_hash: POLICY.hash });
    expect(JSON.parse(rows[0]!.detail!)).toMatchObject({ snapshot_id: result.snapshotId });
  });

  it("signs in once with the client credentials flow and reuses the token", async () => {
    await gatekeeper.readOpportunity({ opportunityId: OPP, actor: AGENT });
    await gatekeeper.readOpportunity({ opportunityId: OPP, actor: AGENT });
    expect(salesforce.tokensIssued).toBe(1);
    expect(salesforce.reads.map((r) => r.authorization)).toEqual(["Bearer token-1", "Bearer token-1"]);
  });

  it("signs in again, once, when Salesforce says the token expired", async () => {
    await gatekeeper.readOpportunity({ opportunityId: OPP, actor: AGENT });
    salesforce.expireTokenOnce = true;
    const result = await gatekeeper.readOpportunity({ opportunityId: OPP, actor: AGENT });
    expect(result.ok).toBe(true);
    expect(salesforce.tokensIssued).toBe(2);
  });

  it.each(["", "001000000000001AAA", "006000000000001AAA' OR Name != '", "006"])(
    "refuses the id %j without calling Salesforce",
    async (opportunityId) => {
      const result = await gatekeeper.readOpportunity({ opportunityId, actor: AGENT });
      expect(result).toMatchObject({ ok: false, reason: "that is not an Opportunity id" });
      expect(salesforce.requests).toHaveLength(0);
      expect(summary(await audit())).toEqual(["read:refused"]);
    },
  );

  it("refuses a caller that does not say who it is", async () => {
    const result = await gatekeeper.readOpportunity({ opportunityId: OPP, actor: undefined as unknown as Caller });
    expect(result.ok).toBe(false);
    expect(salesforce.requests).toHaveLength(0);
    expect((await audit())[0]).toMatchObject({ actor: "unidentified", outcome: "refused" });
  });

  it("reports an opportunity that does not exist, and logs the failure", async () => {
    const result = await gatekeeper.readOpportunity({ opportunityId: "006000000000009AAA", actor: AGENT });
    expect(result).toMatchObject({ ok: false });
    expect(summary(await audit())).toEqual(["read:failed"]);
  });

  it("reports a failed sign-in without leaking the secret", async () => {
    salesforce.failSignIn = true;
    const result = await gatekeeper.readOpportunity({ opportunityId: OPP, actor: AGENT });
    expect(result).toMatchObject({ ok: false, reason: "Salesforce sign-in failed: invalid client credentials" });
    expect(JSON.stringify(await audit())).not.toContain("test-consumer-secret");
  });
});

describe("recordDecision", () => {
  const decide = (extra: object = {}) =>
    gatekeeper.recordDecision({
      opportunityId: OPP,
      proposalId: "p1",
      field: "Champion__c",
      decision: "approve",
      value: "Priya Raman",
      approver: REP,
      ...extra,
    });

  it("records a person's approval under their identity", async () => {
    expect(await decide()).toMatchObject({ ok: true, approver: REP_LABEL });
    const rows = await audit();
    expect(summary(rows)).toEqual(["approve:recorded:Champion__c"]);
    expect(rows[0]).toMatchObject({ actor: REP_LABEL, proposal_id: "p1", value_after: "Priya Raman" });
  });

  it("records an edit with the value the agent proposed", async () => {
    expect(await decide({ decision: "edit", value: "Priya Raman, VP Ops", proposedValue: "Priya" })).toMatchObject({ ok: true });
    const [row] = await audit();
    expect(row).toMatchObject({ action: "edit", value_after: "Priya Raman, VP Ops" });
    expect(JSON.parse(row!.detail!)).toEqual({ proposed_value: "Priya" });
  });

  it("records a rejection with no value", async () => {
    expect(await decide({ decision: "reject", value: "ignored" })).toMatchObject({ ok: true });
    expect((await audit())[0]).toMatchObject({ action: "reject", outcome: "recorded", value_after: null });
  });

  it.each<[string, object, string]>([
    ["an agent", { approver: AGENT }, "not_a_person"],
    ["an agent that names a person", { approver: { kind: "agent", id: "user:rep@example.test" } }, "not_a_person"],
    ["an Access token before milestone 4", { approver: { kind: "access_jwt", token: "x.y.z" } }, "not_a_person"],
    ["no approver", { approver: undefined }, "not_a_person"],
    ["a forecast field", { field: "CloseDate", value: "2027-01-15" }, "needs_manager_approval"],
    ["a field no rule names", { field: "OwnerId", value: "005000000000001" }, "field_denied"],
    ["an empty value", { value: "  " }, "invalid_value"],
    ["a missing value", { value: null }, "invalid_value"],
    ["an unknown decision", { decision: "auto" }, "invalid_request"],
    ["a malformed proposal id", { proposalId: "p 1; --" }, "invalid_request"],
    ["a malformed opportunity id", { opportunityId: "nope" }, "invalid_request"],
  ])("refuses %s, stores no approval and logs the refusal", async (_label, change, code) => {
    expect(await decide(change)).toMatchObject({ ok: false, code });
    expect((await audit()).map((r) => `${r.action}:${r.outcome}`)).toEqual(["refuse:refused"]);

    // Nothing was stored: an apply for the same field still finds no approval.
    const read = await gatekeeper.readOpportunity({ opportunityId: OPP, actor: AGENT });
    if (!read.ok) throw new Error(read.reason);
    const [result] = await gatekeeper.applyApprovedUpdate({
      opportunityId: OPP,
      proposalId: "p1",
      snapshotId: read.snapshotId,
      fields: [{ field: "Champion__c", value: "Priya Raman" }],
      actor: AGENT,
    });
    expect(result).toMatchObject({ outcome: "refused", code: "needs_rep_approval" });
    expect(salesforce.writes).toHaveLength(0);
  });
});

describe("applyApprovedUpdate", () => {
  it("writes an approved field and logs every step", async () => {
    const request = await draftAndApprove({ Champion__c: "Priya Raman" });
    const results = await gatekeeper.applyApprovedUpdate(request);

    expect(results).toEqual([
      expect.objectContaining({ field: "Champion__c", outcome: "written", code: "approved", rule: "rules.rep_approval" }),
    ]);
    expect(salesforce.writes).toEqual([
      expect.objectContaining({ path: `/sobjects/Opportunity/${OPP}`, body: { Champion__c: "Priya Raman" } }),
    ]);
    expect(salesforce.records.get(OPP)!.Champion__c).toBe("Priya Raman");

    const rows = await audit();
    expect(summary(rows)).toEqual(["read:allowed", "approve:recorded:Champion__c", "read:allowed", "write:applied:Champion__c"]);
    expect(rows[3]).toMatchObject({
      actor: "agent:meddpicc-agent/test",
      value_before: null,
      value_after: "Priya Raman",
      proposal_id: "p1",
      reason: `approved by ${REP_LABEL}`,
    });
    expect(rows.every((r) => r.policy_hash === POLICY.hash)).toBe(true);
    expect(await gatekeeper.verifyAudit()).toEqual({ ok: true, rowsChecked: 4, badSeq: null, problem: null });
  });

  it("writes the edited value, not the proposed one", async () => {
    const read = await gatekeeper.readOpportunity({ opportunityId: OPP, actor: AGENT });
    if (!read.ok) throw new Error(read.reason);
    await gatekeeper.recordDecision({ opportunityId: OPP, proposalId: "p1", field: "Metrics__c", decision: "edit", value: "Cut dispatch time 30%", proposedValue: "Cut dispatch time", approver: REP });
    const base = { opportunityId: OPP, proposalId: "p1", snapshotId: read.snapshotId, actor: AGENT };

    const [proposed] = await gatekeeper.applyApprovedUpdate({ ...base, fields: [{ field: "Metrics__c", value: "Cut dispatch time" }] });
    expect(proposed).toMatchObject({ outcome: "refused", code: "approval_mismatch" });

    const [edited] = await gatekeeper.applyApprovedUpdate({ ...base, fields: [{ field: "Metrics__c", value: "Cut dispatch time 30%" }] });
    expect(edited).toMatchObject({ outcome: "written" });
    expect(salesforce.records.get(OPP)!.Metrics__c).toBe("Cut dispatch time 30%");
  });

  it("refuses a field with no approval, without calling Salesforce again", async () => {
    const read = await gatekeeper.readOpportunity({ opportunityId: OPP, actor: AGENT });
    if (!read.ok) throw new Error(read.reason);
    const before = salesforce.requests.length;
    const [result] = await gatekeeper.applyApprovedUpdate({
      opportunityId: OPP,
      proposalId: "p1",
      snapshotId: read.snapshotId,
      fields: [{ field: "Champion__c", value: "Priya Raman" }],
      actor: AGENT,
    });
    expect(result).toMatchObject({ outcome: "refused", code: "needs_rep_approval", rule: "rules.rep_approval" });
    expect(salesforce.requests).toHaveLength(before);
  });

  it("refuses a rejected field", async () => {
    const request = await draftAndApprove({ Champion__c: "Priya Raman" });
    await gatekeeper.recordDecision({ opportunityId: OPP, proposalId: "p1", field: "Champion__c", decision: "reject", value: null, approver: REP });
    const [result] = await gatekeeper.applyApprovedUpdate(request);
    expect(result).toMatchObject({ outcome: "refused", code: "rejected_by_rep" });
    expect(salesforce.writes).toHaveLength(0);
  });

  it("refuses a value other than the one approved", async () => {
    const request = await draftAndApprove({ Champion__c: "Priya Raman" });
    const [result] = await gatekeeper.applyApprovedUpdate({ ...request, fields: [{ field: "Champion__c", value: "Someone Else" }] });
    expect(result).toMatchObject({ outcome: "refused", code: "approval_mismatch" });
    expect(salesforce.writes).toHaveLength(0);
  });

  it("refuses an approval made for another proposal", async () => {
    const request = await draftAndApprove({ Champion__c: "Priya Raman" }, "p1");
    const [result] = await gatekeeper.applyApprovedUpdate({ ...request, proposalId: "p2" });
    expect(result).toMatchObject({ outcome: "refused", code: "needs_rep_approval" });
  });

  it("refuses an approval made for another opportunity", async () => {
    const request = await draftAndApprove({ Champion__c: "Priya Raman" });
    const other = await gatekeeper.readOpportunity({ opportunityId: OTHER_OPP, actor: AGENT });
    if (!other.ok) throw new Error(other.reason);
    const [result] = await gatekeeper.applyApprovedUpdate({ ...request, opportunityId: OTHER_OPP, snapshotId: other.snapshotId });
    expect(result).toMatchObject({ outcome: "refused", code: "needs_rep_approval" });
    expect(salesforce.records.get(OTHER_OPP)!.Champion__c).toBeNull();
  });

  it.each(["CloseDate", "Amount", "StageName", "ForecastCategoryName"])(
    "refuses the forecast field %s and says it needs a manager",
    async (field) => {
      const request = await draftAndApprove({ Champion__c: "Priya Raman" });
      const [result] = await gatekeeper.applyApprovedUpdate({ ...request, fields: [{ field, value: "2027-01-15" }] });
      expect(result).toMatchObject({ outcome: "refused", code: "needs_manager_approval", rule: "rules.manager_approval" });
      expect(result!.reason).toContain("needs manager approval");
      expect(salesforce.writes).toHaveLength(0);
    },
  );

  it("refuses a field no rule names", async () => {
    const request = await draftAndApprove({ Champion__c: "Priya Raman" });
    const [result] = await gatekeeper.applyApprovedUpdate({ ...request, fields: [{ field: "OwnerId", value: "005000000000001" }] });
    expect(result).toMatchObject({ outcome: "refused", code: "field_denied", rule: "default.deny" });
  });

  it("refuses a stale write when a person edited the field after the proposal", async () => {
    const request = await draftAndApprove({ Champion__c: "Priya Raman" });
    salesforce.records.get(OPP)!.Champion__c = "Typed in by the rep";

    const [result] = await gatekeeper.applyApprovedUpdate(request);
    expect(result).toMatchObject({ outcome: "refused", code: "stale", rule: "rules.rep_approval" });
    expect(salesforce.writes).toHaveLength(0);
    expect(salesforce.records.get(OPP)!.Champion__c).toBe("Typed in by the rep");

    const row = (await audit()).at(-1)!;
    expect(row).toMatchObject({ action: "refuse", outcome: "refused", value_before: "Typed in by the rep", value_after: "Priya Raman" });
  });

  it("is stale only for the field that changed", async () => {
    const request = await draftAndApprove({ Champion__c: "Priya Raman", Metrics__c: "Cut dispatch time 30%" });
    salesforce.records.get(OPP)!.Champion__c = "Typed in by the rep";

    const results = await gatekeeper.applyApprovedUpdate(request);
    expect(results.map((r) => `${r.field}:${r.outcome}:${r.code}`)).toEqual(["Champion__c:refused:stale", "Metrics__c:written:approved"]);
    expect(salesforce.writes.map((w) => w.body)).toEqual([{ Metrics__c: "Cut dispatch time 30%" }]);
  });

  it("refuses when the snapshot is unknown or belongs to another opportunity", async () => {
    const request = await draftAndApprove({ Champion__c: "Priya Raman" });
    const other = await gatekeeper.readOpportunity({ opportunityId: OTHER_OPP, actor: AGENT });
    if (!other.ok) throw new Error(other.reason);

    for (const snapshotId of ["no-such-snapshot", other.snapshotId, undefined as unknown as string]) {
      const [result] = await gatekeeper.applyApprovedUpdate({ ...request, snapshotId });
      expect(result).toMatchObject({ outcome: "refused", code: "before_unknown" });
    }
    expect(salesforce.writes).toHaveLength(0);
  });

  it("refuses when the current value cannot be read", async () => {
    const request = await draftAndApprove({ Champion__c: "Priya Raman" });
    salesforce.failNextRead = true;
    const [result] = await gatekeeper.applyApprovedUpdate(request);
    expect(result).toMatchObject({ outcome: "refused", code: "current_unknown" });
    expect(result!.reason).toContain("The service is down");
    expect(salesforce.writes).toHaveLength(0);
    expect(summary(await audit()).slice(-2)).toEqual(["read:failed", "refuse:refused:Champion__c"]);
  });

  it("reports and logs a write that Salesforce did not accept", async () => {
    const request = await draftAndApprove({ Champion__c: "Priya Raman" });
    salesforce.failNextWrite = true;
    const [result] = await gatekeeper.applyApprovedUpdate(request);
    expect(result).toMatchObject({ outcome: "failed", code: "salesforce_error" });
    expect(result!.reason).toContain("Unable to lock row");
    expect(salesforce.records.get(OPP)!.Champion__c).toBeNull();
    expect((await audit()).at(-1)).toMatchObject({ action: "write", outcome: "failed" });
  });

  it("writes the allowed fields of a mixed request in one call and refuses the rest", async () => {
    const request = await draftAndApprove({ Champion__c: "Priya Raman", Identified_Pain__c: "Manual dispatch" });
    const results = await gatekeeper.applyApprovedUpdate({
      ...request,
      fields: [...request.fields, { field: "CloseDate", value: "2027-01-15" }, { field: "Competition__c", value: "Incumbent" }],
    });
    expect(results.map((r) => `${r.field}:${r.outcome}:${r.code}`)).toEqual([
      "Champion__c:written:approved",
      "Identified_Pain__c:written:approved",
      "CloseDate:refused:needs_manager_approval",
      "Competition__c:refused:needs_rep_approval",
    ]);
    expect(salesforce.writes.map((w) => w.body)).toEqual([{ Champion__c: "Priya Raman", Identified_Pain__c: "Manual dispatch" }]);
    expect(salesforce.records.get(OPP)!.CloseDate).toBe("2026-12-18");
  });

  it("refuses the second copy of a field listed twice", async () => {
    const request = await draftAndApprove({ Champion__c: "Priya Raman" });
    const results = await gatekeeper.applyApprovedUpdate({ ...request, fields: [...request.fields, ...request.fields] });
    expect(results.map((r) => `${r.outcome}:${r.code}`)).toEqual(["written:approved", "refused:duplicate_field"]);
  });

  it("does not write the same proposal twice", async () => {
    const request = await draftAndApprove({ Champion__c: "Priya Raman" });
    await gatekeeper.applyApprovedUpdate(request);
    const [again] = await gatekeeper.applyApprovedUpdate(request);
    expect(again).toMatchObject({ outcome: "refused", code: "stale" });
    expect(salesforce.writes).toHaveLength(1);
  });

  it("runs two applies one after the other, so only one passes the stale check", async () => {
    const first = await draftAndApprove({ Champion__c: "Priya Raman" }, "p1");
    const second = await draftAndApprove({ Champion__c: "Dana Okafor" }, "p2");
    // Slow Salesforce down so that, without the lock, both would read before either writes.
    salesforce.delayMs = 20;
    const results = await Promise.all([gatekeeper.applyApprovedUpdate(first), gatekeeper.applyApprovedUpdate(second)]);
    expect(results.flat().map((r) => r.outcome).sort()).toEqual(["refused", "written"]);
    expect(salesforce.writes).toHaveLength(1);
  });

  it.each<[string, object]>([
    ["no caller", { actor: undefined }],
    ["a malformed opportunity id", { opportunityId: "nope" }],
    ["a malformed proposal id", { proposalId: "" }],
    ["an empty field list", { fields: [] }],
    ["a field list that is not a list", { fields: "Champion__c" }],
  ])("refuses a request with %s", async (_label, change) => {
    const request = await draftAndApprove({ Champion__c: "Priya Raman" });
    const results = await gatekeeper.applyApprovedUpdate({ ...request, ...change } as typeof request);
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.outcome === "refused")).toBe(true);
    expect(salesforce.writes).toHaveLength(0);
  });
});

describe("requestFieldUpdate", () => {
  it("refuses the close date, says why, and never calls Salesforce", async () => {
    const result = await gatekeeper.requestFieldUpdate({ opportunityId: OPP, field: "CloseDate", value: "2027-01-15", actor: AGENT });
    expect(result).toMatchObject({ field: "CloseDate", outcome: "refused", code: "needs_manager_approval", rule: "rules.manager_approval" });
    expect(result.reason).toBe("CloseDate is a forecast field: needs manager approval, which this demo does not build");
    expect(salesforce.requests).toHaveLength(0);
    expect(salesforce.tokensIssued).toBe(0);

    const [row] = await audit();
    expect(row).toMatchObject({
      actor: "agent:meddpicc-agent/test",
      action: "refuse",
      outcome: "refused",
      opportunity_id: OPP,
      field: "CloseDate",
      value_after: "2027-01-15",
      reason: result.reason,
      policy_hash: POLICY.hash,
    });
    expect(JSON.parse(row!.detail!)).toEqual({ code: "needs_manager_approval", rule: "rules.manager_approval" });
  });

  it.each<[string, string, string]>([
    ["Champion__c", "needs_rep_approval", "rules.rep_approval"],
    ["Amount", "needs_manager_approval", "rules.manager_approval"],
    ["OwnerId", "field_denied", "default.deny"],
    ["Champion__c, CloseDate", "invalid_field", "target.invalid"],
  ])("refuses %s with %s", async (field, code, rule) => {
    const result = await gatekeeper.requestFieldUpdate({ opportunityId: OPP, field, value: "x", actor: AGENT });
    expect(result).toMatchObject({ outcome: "refused", code, rule });
    expect(salesforce.requests).toHaveLength(0);
  });

  it("never writes, even for a person and even with an approval on record", async () => {
    await draftAndApprove({ Champion__c: "Priya Raman" });
    const result = await gatekeeper.requestFieldUpdate({ opportunityId: OPP, field: "Champion__c", value: "Priya Raman", actor: REP });
    expect(result).toMatchObject({ outcome: "refused", code: "needs_rep_approval" });
    expect(salesforce.writes).toHaveLength(0);
  });

  describe("with a source", () => {
    const source = { proposalId: "p-call-2", transcriptHash: "a".repeat(64), contextHash: "b".repeat(64), modelId: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", quote: "Signature will slip to January" };
    const request = { opportunityId: OPP, field: "CloseDate", value: "January, after the board meeting", actor: AGENT };

    it("records the proposal, transcript, model and quote behind the refusal", async () => {
      const result = await gatekeeper.requestFieldUpdate({ ...request, source });
      expect(result).toMatchObject({ outcome: "refused", code: "needs_manager_approval", rule: "rules.manager_approval" });
      const [row] = await audit();
      expect(row).toMatchObject({
        action: "refuse",
        field: "CloseDate",
        value_after: "January, after the board meeting",
        proposal_id: "p-call-2",
        transcript_hash: source.transcriptHash,
        context_hash: source.contextHash,
        model_id: source.modelId,
      });
      expect(JSON.parse(row!.detail!)).toEqual({ code: "needs_manager_approval", rule: "rules.manager_approval", quote: "Signature will slip to January" });
      expect(salesforce.requests).toHaveLength(0);
    });

    it("is refused all the same: a source is not an approval", async () => {
      await draftAndApprove({ Champion__c: "Priya Raman" }, "p-call-2");
      const result = await gatekeeper.requestFieldUpdate({ ...request, field: "Champion__c", value: "Priya Raman", source });
      expect(result).toMatchObject({ outcome: "refused", code: "needs_rep_approval" });
      expect(salesforce.writes).toHaveLength(0);
    });

    it.each<[string, object]>([
      ["a proposal id that is not one", { ...source, proposalId: "not a proposal id!" }],
      ["a transcript hash that is not a hash", { ...source, transcriptHash: "abc" }],
      ["a model id with spaces", { ...source, modelId: "some model" }],
      ["a string", "p-call-2" as unknown as object],
    ])("leaves %s off the row and still refuses", async (_label, bad) => {
      const result = await gatekeeper.requestFieldUpdate({ ...request, source: bad as typeof source });
      expect(result).toMatchObject({ outcome: "refused", code: "needs_manager_approval" });
      const [row] = await audit();
      expect(row).toMatchObject({ proposal_id: null, transcript_hash: null, model_id: null, context_hash: null });
      expect(JSON.parse(row!.detail!)).toEqual({ code: "needs_manager_approval", rule: "rules.manager_approval" });
    });
  });

  it("refuses a caller that does not say who it is", async () => {
    const result = await gatekeeper.requestFieldUpdate({ opportunityId: OPP, field: "CloseDate", value: "2027-01-15", actor: undefined as unknown as Caller });
    expect(result).toMatchObject({ outcome: "refused", code: "not_identified" });
    expect((await audit())[0]).toMatchObject({ actor: "unidentified" });
  });
});

describe("logProposal", () => {
  const HASH_T = "a".repeat(64);
  const HASH_C = "b".repeat(64);
  const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

  const logged = async (extra: object = {}) => {
    const read = await gatekeeper.readOpportunity({ opportunityId: OPP, actor: AGENT });
    if (!read.ok) throw new Error(read.reason);
    return gatekeeper.logProposal({
      opportunityId: OPP,
      proposalId: "p1",
      snapshotId: read.snapshotId,
      transcriptHash: HASH_T,
      contextHash: HASH_C,
      modelId: MODEL,
      proposed: [{ field: "Champion__c", value: "Priya Raman", quote: "I am running the evaluation" }],
      dropped: [{ field: "Economic_Buyer__c", value: "The CFO", reason: "quote not found in the transcript" }],
      actor: AGENT,
      ...extra,
    });
  };

  it("adds a propose row and a drop row that name the transcript, context and model", async () => {
    salesforce.records.get(OPP)!.Champion__c = "Old champion";
    expect(await logged()).toMatchObject({ ok: true, auditSeqs: [2, 3] });
    const rows = await audit();
    expect(summary(rows)).toEqual(["read:allowed", "propose:recorded:Champion__c", "drop:recorded:Economic_Buyer__c"]);
    expect(rows[1]).toMatchObject({
      actor: "agent:meddpicc-agent/test",
      proposal_id: "p1",
      value_before: "Old champion",
      value_after: "Priya Raman",
      transcript_hash: HASH_T,
      context_hash: HASH_C,
      model_id: MODEL,
      policy_hash: POLICY.hash,
    });
    expect(JSON.parse(rows[1]!.detail!)).toMatchObject({ quote: "I am running the evaluation" });
    expect(rows[2]).toMatchObject({ value_after: "The CFO", reason: "quote not found in the transcript", transcript_hash: HASH_T });
  });

  it("records an unusable model answer as one drop row with no field", async () => {
    expect(await logged({ proposed: [], dropped: [{ field: null, value: null, reason: "the model answer did not match the schema" }] })).toMatchObject({ ok: true });
    expect((await audit()).at(-1)).toMatchObject({ action: "drop", field: null, reason: "the model answer did not match the schema" });
  });

  it("approves nothing and writes nothing to Salesforce", async () => {
    await logged();
    expect(salesforce.writes).toHaveLength(0);
    const read = await gatekeeper.readOpportunity({ opportunityId: OPP, actor: AGENT });
    if (!read.ok) throw new Error(read.reason);
    const [result] = await gatekeeper.applyApprovedUpdate({
      opportunityId: OPP,
      proposalId: "p1",
      snapshotId: read.snapshotId,
      fields: [{ field: "Champion__c", value: "Priya Raman" }],
      actor: AGENT,
    });
    expect(result).toMatchObject({ outcome: "refused", code: "needs_rep_approval" });
  });

  it.each<[string, object]>([
    ["no caller", { actor: undefined }],
    ["a malformed proposal id", { proposalId: "p 1" }],
    ["a malformed opportunity id", { opportunityId: "nope" }],
    ["a transcript hash that is not a hash", { transcriptHash: "abc" }],
    ["a missing context hash", { contextHash: undefined }],
    ["a malformed model id", { modelId: "model with spaces" }],
    ["a proposed field with no quote", { proposed: [{ field: "Champion__c", value: "Priya Raman", quote: "" }] }],
    ["a proposed field with no value", { proposed: [{ field: "Champion__c", quote: "q" }] }],
    ["a dropped field with no reason", { dropped: [{ field: "Champion__c", value: "x" }] }],
    ["lists that are not lists", { proposed: "Champion__c" }],
    ["too many items", { proposed: Array.from({ length: 33 }, () => ({ field: "Champion__c", value: "v", quote: "q" })) }],
  ])("refuses %s and logs nothing but the refusal", async (_label, change) => {
    expect(await logged(change)).toMatchObject({ ok: false });
    expect(summary(await audit())).toEqual(["read:allowed", "refuse:refused"]);
  });
});

describe("the audit log across operations", () => {
  it("stays intact through a write, a refusal and a failure, and filters by opportunity", async () => {
    const request = await draftAndApprove({ Champion__c: "Priya Raman" });
    await gatekeeper.applyApprovedUpdate(request);
    await gatekeeper.requestFieldUpdate({ opportunityId: OPP, field: "CloseDate", value: "2027-01-15", actor: AGENT });
    await gatekeeper.readOpportunity({ opportunityId: OTHER_OPP, actor: AGENT });
    salesforce.failNextRead = true;
    await gatekeeper.readOpportunity({ opportunityId: OPP, actor: AGENT });

    const all = await audit();
    expect(all.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(await gatekeeper.verifyAudit()).toEqual({ ok: true, rowsChecked: 7, badSeq: null, problem: null });
    expect((await gatekeeper.listAudit({ opportunityId: OTHER_OPP })).map((r) => r.seq)).toEqual([6]);
    expect((await gatekeeper.listAudit({ limit: 2 })).map((r) => r.seq)).toEqual([6, 7]);
  });
});
