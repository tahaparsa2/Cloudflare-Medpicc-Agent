/** What the agent stores for one call: the proposal and where each field stands. */

export type DecisionKind = "approve" | "edit" | "reject";

export interface ProposedField {
  field: string;
  label: string;
  /** The value in Salesforce when the proposal was drafted. */
  current: string | null;
  proposed: string;
  /** The lines from the call that support it. Each one was found in the transcript, in code. */
  quotes: string[];
  decision: DecisionKind | null;
  /** What the rep approved: the proposal as it was, or their edit. Null if rejected or undecided. */
  decidedValue: string | null;
  decidedBy: string | null;
  /** What the gatekeeper did when asked to write it. */
  result: { outcome: "written" | "refused" | "failed"; reason: string } | null;
}

export interface DroppedField {
  /** Null when the whole model answer was unusable. */
  field: string | null;
  label: string | null;
  value: string | null;
  /** The quote that failed the check, or all the quotes given. */
  quote: string | null;
  reason: string;
}

/**
 * A forecast field the call says has changed. The agent cannot propose it: it
 * asked the gatekeeper, and this is the gatekeeper's answer.
 */
export interface NotWritableField {
  field: string;
  label: string;
  /** The value in Salesforce when the proposal was drafted. */
  current: string | null;
  /** What the call says, in the words of the call. */
  requested: string;
  quotes: string[];
  outcome: "written" | "refused" | "failed";
  /** The gatekeeper's reason code, e.g. needs_manager_approval. */
  code: string;
  /** The policy rule that decided it. */
  rule: string | null;
  reason: string;
  /** The audit row that records the answer. */
  auditSeq: number;
}

export interface Proposal {
  id: string;
  opportunityId: string;
  opportunityName: string | null;
  accountName: string | null;
  transcriptId: string;
  transcriptHash: string;
  contextHash: string;
  /** Prefixed with "replay:" when a recorded answer was used instead of a live model call. */
  modelId: string;
  gatewayLogId: string | null;
  /** The gatekeeper's record of the Salesforce values this proposal was drafted against. */
  snapshotId: string;
  createdAt: string;
  fields: ProposedField[];
  dropped: DroppedField[];
  /** Empty in Salesforce and not supported by this call. */
  askNext: { field: string; label: string }[];
  /** Forecast fields the call says changed, each refused by the gatekeeper. Absent on proposals stored before this existed. */
  notWritable?: NotWritableField[];
}

/** drafted: nothing decided. partly_decided: some decided or some written. applied: every field settled. */
export type ProposalStatus = "none" | "drafted" | "partly_decided" | "applied";

export interface OpportunityAgentState {
  status: ProposalStatus;
  proposal: Proposal | null;
}

/** A field is settled once it is written, or rejected, or the gatekeeper has refused it. */
export function statusOf(proposal: Proposal | null): ProposalStatus {
  if (!proposal) return "none";
  const { fields } = proposal;
  if (fields.every((f) => f.decision === null && f.result === null)) return "drafted";
  const settled = (f: ProposedField) => f.decision === "reject" || f.result?.outcome === "written";
  return fields.every(settled) ? "applied" : "partly_decided";
}
