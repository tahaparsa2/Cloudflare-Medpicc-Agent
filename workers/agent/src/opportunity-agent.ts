import { Agent } from "agents";
import type { Caller, PersonEvidence } from "../../gatekeeper/src/types";
import { CONTEXT, RECORDINGS, TRANSCRIPTS } from "./bundled";
import { draftProposal } from "./draft";
import { MAX_PROPOSED_LENGTH } from "./extraction";
import { replayModel, workersAiModel, type ModelClient } from "./model";
import { statusOf, type DecisionKind, type OpportunityAgentState, type Proposal } from "./proposal";

export type AgentReply = { ok: true; state: OpportunityAgentState } | { ok: false; status: number; reason: string };

const fail = (status: number, reason: string): AgentReply => ({ ok: false, status, reason });

/**
 * One instance per Salesforce opportunity, named by the opportunity id. It
 * holds the current proposal and where each field stands.
 *
 * It can draft. It cannot approve: `decide` only passes a person's decision,
 * with that person's proof, to the gatekeeper, which is where the approval is
 * stored and checked. Without proof the gatekeeper refuses. This class holds no
 * Salesforce credential and has no route to Salesforce but the gatekeeper.
 */
export class OpportunityAgent extends Agent<Env, OpportunityAgentState> {
  override initialState: OpportunityAgentState = { status: "none", proposal: null };

  private drafting = false;

  override onStart(): void {
    this.sql`CREATE TABLE IF NOT EXISTS proposal_history (id TEXT PRIMARY KEY, replaced_at TEXT NOT NULL, body TEXT NOT NULL)`;
  }

  private get opportunityId(): string {
    return this.name;
  }

  private get actor(): Caller {
    return { kind: "agent", id: `meddpicc-agent/${this.opportunityId}` };
  }

  private get model(): ModelClient {
    return this.env.MODEL_MODE === "replay"
      ? replayModel(RECORDINGS)
      : workersAiModel(this.env.AI, this.env.MODEL_ID, this.env.AI_GATEWAY_ID);
  }

  async view(): Promise<OpportunityAgentState> {
    return this.state;
  }

  /** A call ended: draft a proposal from its transcript. Replaces the current proposal. */
  async draft(transcriptId: string): Promise<AgentReply> {
    const transcript = TRANSCRIPTS[transcriptId];
    if (!transcript) return fail(404, `no transcript named ${JSON.stringify(String(transcriptId).slice(0, 80))}`);
    if (this.drafting) return fail(409, "a proposal is already being drafted for this opportunity");

    this.drafting = true;
    try {
      const result = await draftProposal(
        { gatekeeper: this.env.GATEKEEPER_SALESFORCE, model: this.model, context: CONTEXT },
        { opportunityId: this.opportunityId, transcriptId, transcript, actor: this.actor },
      );
      if (!result.ok) return fail(502, result.reason);

      const previous = this.state.proposal;
      if (previous) {
        this.sql`INSERT OR REPLACE INTO proposal_history (id, replaced_at, body) VALUES (${previous.id}, ${new Date().toISOString()}, ${JSON.stringify(previous)})`;
      }
      return this.save(result.proposal);
    } finally {
      this.drafting = false;
    }
  }

  /** Pass one person's decision on one field to the gatekeeper, and remember its answer. */
  async decide(input: { field: string; decision: DecisionKind; value?: string | null; approver: PersonEvidence }): Promise<AgentReply> {
    const proposal = this.state.proposal;
    if (!proposal) return fail(404, "there is no proposal to decide on");
    const field = proposal.fields.find((f) => f.field === input.field);
    if (!field) return fail(404, "that field is not part of the proposal");
    if (field.result?.outcome === "written") return fail(409, `${field.label} is already written to Salesforce`);
    if (!["approve", "edit", "reject"].includes(input.decision)) return fail(400, "the decision must be approve, edit or reject");

    let decision = input.decision;
    let value: string | null = null;
    if (decision === "approve") value = field.proposed;
    if (decision === "edit") {
      value = typeof input.value === "string" ? input.value.trim() : "";
      if (value === "" || value.length > MAX_PROPOSED_LENGTH) {
        return fail(400, `an edited value must be 1 to ${MAX_PROPOSED_LENGTH} characters`);
      }
      // An edit that changes nothing is an approval.
      if (value === field.proposed) decision = "approve";
    }

    const recorded = await this.env.GATEKEEPER_SALESFORCE.recordDecision({
      opportunityId: this.opportunityId,
      proposalId: proposal.id,
      field: field.field,
      decision,
      value,
      proposedValue: field.proposed,
      approver: input.approver,
    });
    if (!recorded.ok) return fail(403, recorded.reason);

    return this.save({
      ...proposal,
      fields: proposal.fields.map((f) =>
        f.field === field.field ? { ...f, decision, decidedValue: value, decidedBy: recorded.approver, result: null } : f,
      ),
    });
  }

  /** Ask the gatekeeper to write every approved field that is not written yet. */
  async apply(approver: PersonEvidence): Promise<AgentReply> {
    const proposal = this.state.proposal;
    if (!proposal) return fail(404, "there is no proposal to apply");
    const pending = proposal.fields.filter(
      (f) => (f.decision === "approve" || f.decision === "edit") && f.decidedValue !== null && f.result?.outcome !== "written",
    );
    if (pending.length === 0) return fail(409, "no approved field is waiting to be written");

    const results = await this.env.GATEKEEPER_SALESFORCE.applyApprovedUpdate({
      opportunityId: this.opportunityId,
      proposalId: proposal.id,
      snapshotId: proposal.snapshotId,
      fields: pending.map((f) => ({ field: f.field, value: f.decidedValue! })),
      actor: approver,
    });

    return this.save({
      ...proposal,
      fields: proposal.fields.map((f) => {
        const result = results.find((r) => r.field === f.field);
        return result ? { ...f, result: { outcome: result.outcome, reason: result.reason } } : f;
      }),
    });
  }

  private save(proposal: Proposal): AgentReply {
    const state: OpportunityAgentState = { status: statusOf(proposal), proposal };
    this.setState(state);
    return { ok: true, state };
  }
}
