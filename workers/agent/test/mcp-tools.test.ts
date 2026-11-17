import { beforeEach, describe, expect, it } from "vitest";
import { draftProposal } from "../src/draft";
import { MCP_ACTOR, NO_APPROVAL, TOOL_NAMES, draftMeddpiccUpdate, getOpportunity, getProposalStatus, requestFieldUpdate, type McpDeps } from "../src/mcp-tools";
import { replayModel } from "../src/model";
import { statusOf, type OpportunityAgentState } from "../src/proposal";
import { CALL_2, CONTEXT, FakeGatekeeper, OPP, readFixture, recording } from "./helpers";

let gatekeeper: FakeGatekeeper;
let state: OpportunityAgentState;
let deps: McpDeps;

beforeEach(() => {
  gatekeeper = new FakeGatekeeper();
  state = { status: "none", proposal: null };
  deps = {
    gatekeeper,
    reviewUrl: (id) => `http://localhost:8787/review/${id}`,
    transcripts: ["call-1", "call-2"],
    // Stands in for the OpportunityAgent: it drafts with the real drafting code and remembers the result.
    agentFor: async (opportunityId) => ({
      async draft(transcriptId) {
        const result = await draftProposal(
          { gatekeeper, model: replayModel({ "call-2": recording("call-2") }), context: CONTEXT, newId: () => "p-mcp" },
          { opportunityId, transcriptId, transcript: CALL_2, actor: { kind: "agent", id: `meddpicc-agent/${opportunityId}` } },
        );
        if (!result.ok) return { ok: false as const, status: 502, reason: result.reason };
        state = { status: statusOf(result.proposal), proposal: result.proposal };
        return { ok: true as const, state };
      },
      async view() {
        return state;
      },
    }),
  };
});

describe("the MCP tools", () => {
  it("are the four from the brief, and each is registered once", () => {
    expect(TOOL_NAMES).toEqual(["get_opportunity", "draft_meddpicc_update", "get_proposal_status", "request_field_update"]);
    const registered = [...readFixture("workers/agent/src/mcp.ts").matchAll(/registerTool\(\s*"([a-z_]+)"/g)].map((match) => match[1]);
    expect(registered).toEqual([...TOOL_NAMES]);
  });

  it("have no route to an approval: the MCP code never names the calls that decide or write", () => {
    // Approving, editing, rejecting and writing live in the agent's decide and
    // apply methods and the gatekeeper's recordDecision and applyApprovedUpdate.
    // The MCP code is given none of them and must not mention them.
    for (const file of ["workers/agent/src/mcp.ts", "workers/agent/src/mcp-tools.ts"]) {
      const code = readFixture(file).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      expect(code, file).not.toMatch(/recordDecision|applyApprovedUpdate|\.decide\(|\.apply\(|PersonEvidence|kind:\s*"dev"|access_jwt/);
    }
  });

  it("always act as an agent, never as a person", () => {
    expect(MCP_ACTOR).toEqual({ kind: "agent", id: "mcp-client" });
  });
});

describe("get_opportunity", () => {
  it("reads through the gatekeeper as the MCP client", async () => {
    const result = await getOpportunity(deps, { opportunity_id: OPP });
    expect(result).toMatchObject({ ok: true, opportunity_id: OPP, fields: { CloseDate: "2026-12-18", Name: "Tessaline Freight - New Business" } });
    expect(gatekeeper.reads).toEqual([{ opportunityId: OPP, actor: MCP_ACTOR }]);
  });

  it("passes on the gatekeeper's refusal", async () => {
    gatekeeper.failRead = "that is not an Opportunity id";
    expect(await getOpportunity(deps, { opportunity_id: OPP })).toEqual({ ok: false, error: "that is not an Opportunity id" });
  });

  it("refuses an id that is not an Opportunity id without calling the gatekeeper", async () => {
    expect(await getOpportunity(deps, { opportunity_id: "001000000000001AAA" })).toMatchObject({ ok: false });
    expect(gatekeeper.reads).toEqual([]);
  });
});

describe("draft_meddpicc_update", () => {
  it("returns the proposal, the close-date refusal and the review link, and decides nothing", async () => {
    const result = await draftMeddpiccUpdate(deps, { opportunity_id: OPP, transcript_id: "call-2" });
    expect(result).toMatchObject({ ok: true, status: "drafted", proposal_id: "p-mcp", call: "call-2", review_url: `http://localhost:8787/review/${OPP}`, note: NO_APPROVAL });
    if (!result.ok) return;
    const fields = result.fields as { field: string; decision: string; quotes: string[]; write: unknown }[];
    expect(fields.length).toBeGreaterThan(0);
    for (const field of fields) {
      expect(field).toMatchObject({ decision: "undecided", write: null });
      expect(field.quotes.length).toBeGreaterThan(0);
    }
    expect(result.not_writable_by_the_agent).toMatchObject([{ field: "CloseDate", gatekeeper: { outcome: "refused" } }]);
  });

  it("refuses a transcript it does not have", async () => {
    expect(await draftMeddpiccUpdate(deps, { opportunity_id: OPP, transcript_id: "call-9" })).toEqual({ ok: false, error: "transcript_id must be one of: call-1, call-2" });
    expect(gatekeeper.reads).toEqual([]);
  });
});

describe("get_proposal_status", () => {
  it("says so when no call has been processed", async () => {
    expect(await getProposalStatus(deps, { opportunity_id: OPP })).toMatchObject({ ok: true, status: "none", proposal: null });
  });

  it("reports a person's decision and the write, with who made it", async () => {
    await draftMeddpiccUpdate(deps, { opportunity_id: OPP, transcript_id: "call-2" });
    const first = state.proposal!.fields[0]!;
    // As the review page would leave it after a rep approved the field and the gatekeeper wrote it.
    state = {
      status: "partly_decided",
      proposal: {
        ...state.proposal!,
        fields: state.proposal!.fields.map((f) =>
          f.field === first.field ? { ...f, decision: "approve", decidedValue: f.proposed, decidedBy: "user:rep@example.test", result: { outcome: "written", reason: "approved by user:rep@example.test" } } : f,
        ),
      },
    };
    const result = await getProposalStatus(deps, { opportunity_id: OPP });
    expect(result).toMatchObject({ ok: true, status: "partly_decided" });
    if (!result.ok) return;
    expect((result.fields as object[])[0]).toMatchObject({ field: first.field, decision: "approve", decided_by: "user:rep@example.test", write: { outcome: "written" } });
  });
});

describe("request_field_update", () => {
  it("passes the close date to the gatekeeper as the MCP client and returns its refusal", async () => {
    const result = await requestFieldUpdate(deps, { opportunity_id: OPP, field: "CloseDate", value: "2027-01-21" });
    expect(gatekeeper.requests).toEqual([{ opportunityId: OPP, field: "CloseDate", value: "2027-01-21", actor: MCP_ACTOR }]);
    expect(result).toEqual({
      ok: true,
      field: "CloseDate",
      outcome: "refused",
      reason: "CloseDate is a forecast field: needs manager approval, which this demo does not build",
      code: "needs_manager_approval",
      policy_rule: "rules.manager_approval",
      audit_row: 7,
      review_url: `http://localhost:8787/review/${OPP}`,
      note: NO_APPROVAL,
    });
  });

  it("sends no claim of where the request came from, and no person", async () => {
    await requestFieldUpdate(deps, { opportunity_id: OPP, field: "Champion__c", value: "Priya Raman" });
    expect(Object.keys(gatekeeper.requests[0]!).sort()).toEqual(["actor", "field", "opportunityId", "value"]);
  });
});
