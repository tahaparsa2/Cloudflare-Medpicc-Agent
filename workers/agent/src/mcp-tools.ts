/**
 * What the four MCP tools do. Plain functions, so they can be tested without
 * an MCP client. The wiring to the MCP SDK is in mcp.ts.
 *
 * An MCP client is an agent. Every call here goes to the gatekeeper as
 * `agent:mcp-client`, never as the person at the keyboard, so nothing a tool
 * does can count as a person's approval. There is no tool that approves,
 * edits, rejects or applies: those exist only as clicks on the review page.
 */

import type { Caller, SalesforceGatekeeperApi } from "../../gatekeeper/src/types";
import type { OpportunityAgentState } from "./proposal";

export const MCP_ACTOR: Caller = { kind: "agent", id: "mcp-client" };

export const TOOL_NAMES = ["get_opportunity", "draft_meddpicc_update", "get_proposal_status", "request_field_update"] as const;

export const NO_APPROVAL = "No tool can approve, edit, reject or write. A signed-in person does that on the review page.";

const OPPORTUNITY_ID = /^006[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/;

type DraftReply = { ok: true; state: OpportunityAgentState } | { ok: false; status: number; reason: string };

export interface McpDeps {
  gatekeeper: Pick<SalesforceGatekeeperApi, "readOpportunity" | "requestFieldUpdate">;
  /** The agent instance for one opportunity. It can draft and report. It has no way to approve. */
  agentFor(opportunityId: string): Promise<{ draft(transcriptId: string): Promise<DraftReply>; view(): Promise<OpportunityAgentState> }>;
  reviewUrl(opportunityId: string): string;
  /** The transcripts a call-ended event can name. */
  transcripts: readonly string[];
}

export type ToolResult = { ok: true; [key: string]: unknown } | { ok: false; error: string };

const badId = (): ToolResult => ({ ok: false, error: "opportunity_id must be a Salesforce Opportunity id (15 or 18 characters, starting 006)" });

function summarize(state: OpportunityAgentState, reviewUrl: string): Record<string, unknown> {
  const proposal = state.proposal;
  if (!proposal) return { status: state.status, proposal: null, review_url: reviewUrl, note: "No call has been processed for this opportunity." };
  return {
    status: state.status,
    proposal_id: proposal.id,
    call: proposal.transcriptId,
    model: proposal.modelId,
    drafted_at: proposal.createdAt,
    fields: proposal.fields.map((f) => ({
      field: f.field,
      label: f.label,
      in_salesforce_when_drafted: f.current,
      proposed: f.proposed,
      quotes: f.quotes,
      decision: f.decision ?? "undecided",
      decided_by: f.decidedBy,
      decided_value: f.decidedValue,
      write: f.result ? { outcome: f.result.outcome, reason: f.result.reason } : null,
    })),
    not_writable_by_the_agent: (proposal.notWritable ?? []).map((f) => ({
      field: f.field,
      in_salesforce: f.current,
      the_call_says: f.requested,
      quotes: f.quotes,
      gatekeeper: { outcome: f.outcome, reason: f.reason, rule: f.rule, audit_row: f.auditSeq },
    })),
    dropped_by_the_checks: proposal.dropped.map((d) => ({ field: d.field, reason: d.reason })),
    ask_on_the_next_call: proposal.askNext.map((f) => f.label),
    review_url: reviewUrl,
    note: NO_APPROVAL,
  };
}

/** The opportunity's policy-readable fields, read through the gatekeeper. */
export async function getOpportunity(deps: McpDeps, input: { opportunity_id: string }): Promise<ToolResult> {
  if (!OPPORTUNITY_ID.test(input.opportunity_id)) return badId();
  const read = await deps.gatekeeper.readOpportunity({ opportunityId: input.opportunity_id, actor: MCP_ACTOR });
  if (!read.ok) return { ok: false, error: read.reason };
  return { ok: true, opportunity_id: read.opportunityId, fields: read.fields, audit_row: read.auditSeq };
}

/** Draft a proposal from a call transcript. Returns it with the link where a person decides. */
export async function draftMeddpiccUpdate(deps: McpDeps, input: { opportunity_id: string; transcript_id: string }): Promise<ToolResult> {
  if (!OPPORTUNITY_ID.test(input.opportunity_id)) return badId();
  if (!deps.transcripts.includes(input.transcript_id)) {
    return { ok: false, error: `transcript_id must be one of: ${deps.transcripts.join(", ")}` };
  }
  const agent = await deps.agentFor(input.opportunity_id);
  const reply = await agent.draft(input.transcript_id);
  if (!reply.ok) return { ok: false, error: reply.reason };
  return { ok: true, ...summarize(reply.state, deps.reviewUrl(input.opportunity_id)) };
}

/** Where the current proposal stands: what was decided, by whom, and what was written. */
export async function getProposalStatus(deps: McpDeps, input: { opportunity_id: string }): Promise<ToolResult> {
  if (!OPPORTUNITY_ID.test(input.opportunity_id)) return badId();
  const agent = await deps.agentFor(input.opportunity_id);
  return { ok: true, ...summarize(await agent.view(), deps.reviewUrl(input.opportunity_id)) };
}

/**
 * Ask the gatekeeper to set a field. There is no approval behind a request
 * made here, so the gatekeeper's policy refuses it, and says why. The answer
 * is the gatekeeper's, passed on unchanged.
 */
export async function requestFieldUpdate(deps: McpDeps, input: { opportunity_id: string; field: string; value: string }): Promise<ToolResult> {
  if (!OPPORTUNITY_ID.test(input.opportunity_id)) return badId();
  const answer = await deps.gatekeeper.requestFieldUpdate({
    opportunityId: input.opportunity_id,
    field: input.field,
    value: input.value,
    actor: MCP_ACTOR,
  });
  return {
    ok: true,
    field: answer.field,
    outcome: answer.outcome,
    reason: answer.reason,
    code: answer.code,
    policy_rule: answer.rule,
    audit_row: answer.auditSeq,
    review_url: deps.reviewUrl(input.opportunity_id),
    note: answer.outcome === "written" ? undefined : NO_APPROVAL,
  };
}
