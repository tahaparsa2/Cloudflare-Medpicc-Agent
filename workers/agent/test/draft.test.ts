import { beforeEach, describe, expect, it } from "vitest";
import type { Caller } from "../../gatekeeper/src/types";
import { draftProposal, type DraftDeps } from "../src/draft";
import { FIELD_NAMES } from "../src/fields";
import { sha256Hex } from "../src/hash";
import { replayModel, type ModelClient } from "../src/model";
import { checkQuote } from "../src/quote-check";
import { ALREADY_FILLED } from "../src/extraction";
import { CALL_1, CALL_2, CONTEXT, FakeGatekeeper, OPP, answer, fixedModel, recording } from "./helpers";

const ACTOR: Caller = { kind: "agent", id: `meddpicc-agent/${OPP}` };
const PAIN = "The VPN hardware goes out of support in March.";
const CHAMPION = "I am running the evaluation, and I want this fixed before March.";

let gatekeeper: FakeGatekeeper;

beforeEach(() => {
  gatekeeper = new FakeGatekeeper();
});

const draft = (model: ModelClient, extra: Partial<DraftDeps> = {}) =>
  draftProposal(
    { gatekeeper, model, context: CONTEXT, now: () => new Date("2026-11-14T12:00:00.000Z"), newId: () => "p-test", ...extra },
    { opportunityId: OPP, transcriptId: "call-1", transcript: CALL_1, actor: ACTOR },
  );

describe("draftProposal with the recorded answer for call 1", () => {
  const model = replayModel({ "call-1": recording("call-1") });

  it("drafts a proposal without calling a model", async () => {
    const result = await draft(model);
    if (!result.ok) throw new Error(result.reason);
    const { proposal } = result;

    expect(proposal).toMatchObject({
      id: "p-test",
      opportunityId: OPP,
      opportunityName: "Tessaline Freight - New Business",
      accountName: "Tessaline Freight",
      transcriptId: "call-1",
      transcriptHash: sha256Hex(CALL_1),
      contextHash: sha256Hex(CONTEXT),
      modelId: "replay:@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      snapshotId: "snapshot-1",
      createdAt: "2026-11-14T12:00:00.000Z",
    });
    expect(proposal.fields.length).toBeGreaterThan(0);
    for (const field of proposal.fields) {
      expect(field).toMatchObject({ current: null, decision: null, decidedValue: null, decidedBy: null, result: null });
      expect(field.proposed).not.toBe("");
      for (const quote of field.quotes) expect(checkQuote(quote, CALL_1)).toEqual({ ok: true });
    }
  });

  it("lists every empty field it did not propose under ask-next, and no other", async () => {
    const result = await draft(model);
    if (!result.ok) throw new Error(result.reason);
    const proposed = result.proposal.fields.map((f) => f.field);
    const ask = result.proposal.askNext.map((f) => f.field);
    expect([...proposed, ...ask].sort()).toEqual([...FIELD_NAMES].sort());
    expect(ask.filter((field) => proposed.includes(field))).toEqual([]);
  });

  it("reads through the gatekeeper as the agent, and logs exactly what it proposed and dropped", async () => {
    const result = await draft(model);
    if (!result.ok) throw new Error(result.reason);
    const { proposal } = result;

    expect(gatekeeper.reads).toEqual([{ opportunityId: OPP, actor: ACTOR }]);
    expect(gatekeeper.logs).toHaveLength(1);
    expect(gatekeeper.logs[0]).toMatchObject({
      opportunityId: OPP,
      proposalId: "p-test",
      snapshotId: "snapshot-1",
      transcriptHash: proposal.transcriptHash,
      contextHash: proposal.contextHash,
      modelId: proposal.modelId,
      actor: ACTOR,
    });
    expect(gatekeeper.logs[0]!.proposed.map((p) => p.field)).toEqual(proposal.fields.map((f) => f.field));
    expect(gatekeeper.logs[0]!.dropped.map((d) => d.field)).toEqual(proposal.dropped.map((d) => d.field));
  });
});

describe("draftProposal", () => {
  it("keeps a proposal with a real quote and drops one with an invented quote", async () => {
    const model = fixedModel(
      answer({
        Identified_Pain__c: { value: "VPN hardware out of support in March.", quotes: [PAIN] },
        Economic_Buyer__c: { value: "Elena Vasquez, CFO", quotes: ["Elena Vasquez signs anything above 50,000 dollars."] },
      }),
    );
    const result = await draft(model);
    if (!result.ok) throw new Error(result.reason);
    expect(result.proposal.fields.map((f) => f.field)).toEqual(["Identified_Pain__c"]);
    expect(result.proposal.dropped).toEqual([
      expect.objectContaining({ field: "Economic_Buyer__c", value: "Elena Vasquez, CFO", reason: "the quote is not in the transcript" }),
    ]);
    // A dropped field is still empty, so it is still something to ask about.
    expect(result.proposal.askNext.map((f) => f.field)).toContain("Economic_Buyer__c");
    expect(gatekeeper.logs[0]!.dropped).toEqual([{ field: "Economic_Buyer__c", value: "Elena Vasquez, CFO", reason: "the quote is not in the transcript" }]);
  });

  it("leaves a field that already has a value alone, and logs the drop", async () => {
    gatekeeper.fields.Identified_Pain__c = "Old pain";
    const result = await draft(fixedModel(answer({ Identified_Pain__c: { value: "VPN hardware out of support in March.", quotes: [PAIN] } })));
    if (!result.ok) throw new Error(result.reason);
    expect(result.proposal.fields).toEqual([]);
    expect(result.proposal.dropped).toEqual([expect.objectContaining({ field: "Identified_Pain__c", reason: ALREADY_FILLED })]);
    expect(result.proposal.askNext.map((f) => f.field)).not.toContain("Identified_Pain__c");
    expect(gatekeeper.logs[0]!.dropped).toEqual([{ field: "Identified_Pain__c", value: "VPN hardware out of support in March.", reason: ALREADY_FILLED }]);
  });

  it("does not ask next call about a field that already has a value", async () => {
    gatekeeper.fields.Champion__c = "Priya Raman";
    const result = await draft(fixedModel(answer({})));
    if (!result.ok) throw new Error(result.reason);
    expect(result.proposal.fields).toEqual([]);
    expect(result.proposal.askNext.map((f) => f.field)).not.toContain("Champion__c");
    expect(result.proposal.askNext).toHaveLength(7);
  });

  it("asks the model the same question whatever Salesforce holds", async () => {
    const seen: string[] = [];
    const model: ModelClient = {
      id: "spy",
      async extract(request) {
        seen.push(JSON.stringify(request.messages));
        return { output: answer({}), modelId: "spy", gatewayLogId: null };
      },
    };
    await draft(model);
    gatekeeper.fields.Champion__c = "Priya Raman";
    await draft(model);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe(seen[0]);
    expect(seen[1]).not.toContain("Priya Raman\"");
  });

  it.each<[string, unknown]>([
    ["an answer that is not JSON", "Sure! Here is the analysis you asked for."],
    ["an answer in the wrong shape", { proposals: [] }],
    ["an answer naming a field it was not asked for", { ...answer({}), Amount: { value: "90000", quotes: ["this is above that"] } }],
  ])("treats %s as no proposal, and logs why", async (_label, output) => {
    const result = await draft(fixedModel(output));
    if (!result.ok) throw new Error(result.reason);
    expect(result.proposal.fields).toEqual([]);
    expect(result.proposal.dropped).toEqual([expect.objectContaining({ field: null, reason: expect.stringContaining("model answer") })]);
    expect(result.proposal.askNext).toHaveLength(8);
    expect(gatekeeper.logs[0]).toMatchObject({ proposed: [], dropped: [{ field: null, value: null }] });
  });

  it("treats a failed model call as no proposal, and logs why", async () => {
    const model: ModelClient = {
      id: "@cf/test/model",
      async extract() {
        throw new Error("JSON Mode couldn't be met");
      },
    };
    const result = await draft(model);
    if (!result.ok) throw new Error(result.reason);
    expect(result.proposal.fields).toEqual([]);
    expect(result.proposal.modelId).toBe("@cf/test/model");
    expect(result.proposal.dropped[0]!.reason).toBe("the model call failed: JSON Mode couldn't be met");
    expect(gatekeeper.logs).toHaveLength(1);
  });

  it("stops before the model when the opportunity cannot be read", async () => {
    gatekeeper.failRead = "Salesforce sign-in failed: invalid client credentials";
    const model = fixedModel(answer({ Champion__c: { value: "Priya Raman", quotes: [CHAMPION] } }));
    expect(await draft(model)).toEqual({ ok: false, stage: "read", reason: "Salesforce sign-in failed: invalid client credentials" });
    expect(model.calls).toBe(0);
    expect(gatekeeper.logs).toEqual([]);
  });

  it("gives no proposal when the audit log refuses to record it", async () => {
    gatekeeper.failLog = "the audit log does not end at row 4, which the stored head names";
    const result = await draft(fixedModel(answer({ Champion__c: { value: "Priya Raman", quotes: [CHAMPION] } })));
    expect(result).toEqual({ ok: false, stage: "log", reason: gatekeeper.failLog });
  });
});

describe("draftProposal and the close date", () => {
  const SLIP = "Signature will slip to January, realistically the week after that board meeting.";
  const BUYER = "I sign any contract above 50,000 dollars, and this is above that.";
  const draftCall2 = (model: ModelClient) =>
    draftProposal(
      { gatekeeper, model, context: CONTEXT, now: () => new Date("2026-11-14T12:00:00.000Z"), newId: () => "p-test" },
      { opportunityId: OPP, transcriptId: "call-2", transcript: CALL_2, actor: ACTOR },
    );
  const slipped = () =>
    fixedModel(
      answer({
        Economic_Buyer__c: { value: "Elena Vasquez, CFO", quotes: [BUYER] },
        CloseDate: { value: "January, the week after the January 14 board meeting", quotes: [SLIP] },
      }),
    );

  it("asks the gatekeeper for the change and shows its refusal, never a proposal", async () => {
    const result = await draftCall2(slipped());
    if (!result.ok) throw new Error(result.reason);
    const { proposal } = result;

    expect(proposal.fields.map((f) => f.field)).toEqual(["Economic_Buyer__c"]);
    expect(proposal.notWritable).toEqual([
      {
        field: "CloseDate",
        label: "Close Date",
        current: "2026-12-18",
        requested: "January, the week after the January 14 board meeting",
        quotes: [SLIP],
        outcome: "refused",
        code: "needs_manager_approval",
        rule: "rules.manager_approval",
        reason: "CloseDate is a forecast field: needs manager approval, which this demo does not build",
        auditSeq: 7,
      },
    ]);
  });

  it("sends the request as the agent, with the proposal, transcript, model and quote behind it", async () => {
    const result = await draftCall2(slipped());
    if (!result.ok) throw new Error(result.reason);
    expect(gatekeeper.requests).toEqual([
      {
        opportunityId: OPP,
        field: "CloseDate",
        value: "January, the week after the January 14 board meeting",
        actor: ACTOR,
        source: { proposalId: "p-test", transcriptHash: sha256Hex(CALL_2), contextHash: sha256Hex(CONTEXT), modelId: "test-model", quote: SLIP },
      },
    ]);
    // The close date is never among what the agent logs as proposed.
    expect(gatekeeper.logs[0]!.proposed.map((p) => p.field)).toEqual(["Economic_Buyer__c"]);
  });

  it("does not ask the gatekeeper when the close-date quote is invented, and logs the drop", async () => {
    const model = fixedModel(answer({ CloseDate: { value: "February", quotes: ["We will sign in February, once the audit is done."] } }));
    const result = await draftCall2(model);
    if (!result.ok) throw new Error(result.reason);
    expect(gatekeeper.requests).toEqual([]);
    expect(result.proposal.notWritable).toEqual([]);
    expect(result.proposal.dropped).toEqual([expect.objectContaining({ field: "CloseDate", reason: "the quote is not in the transcript" })]);
    expect(gatekeeper.logs[0]!.dropped).toEqual([{ field: "CloseDate", value: "February", reason: "the quote is not in the transcript" }]);
  });

  it("does not ask the gatekeeper when the call says nothing about the close date", async () => {
    const result = await draft(fixedModel(answer({ Champion__c: { value: "Priya Raman", quotes: [CHAMPION] } })));
    if (!result.ok) throw new Error(result.reason);
    expect(gatekeeper.requests).toEqual([]);
    expect(result.proposal.notWritable).toEqual([]);
  });

  it("call 2 after call 1: proposes only the fields still empty, and reports the close date", async () => {
    // Salesforce as it stands after the rep approved five fields from call 1 and rejected Competition.
    for (const field of ["Metrics__c", "Decision_Criteria__c", "Decision_Process__c", "Identified_Pain__c", "Champion__c"]) {
      gatekeeper.fields[field] = "Approved after call 1";
    }
    const result = await draftCall2(replayModel({ "call-2": recording("call-2") }));
    if (!result.ok) throw new Error(result.reason);
    const { proposal } = result;

    expect(proposal.fields.map((f) => f.field)).toEqual(["Economic_Buyer__c", "Paper_Process__c"]);
    expect(proposal.notWritable!.map((f) => `${f.field}:${f.outcome}`)).toEqual(["CloseDate:refused"]);
    for (const drop of proposal.dropped) expect(drop.reason).toBe(ALREADY_FILLED);
    expect(proposal.askNext.map((f) => f.field)).toEqual(["Competition__c"]);
  });
});
