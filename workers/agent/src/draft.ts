/**
 * Drafting a proposal from one call. Plain code around one model call:
 * read the opportunity through the gatekeeper, ask the model, check its answer
 * against the schema and the transcript, and log what was proposed and dropped.
 */

import type { Caller, SalesforceGatekeeperApi } from "../../gatekeeper/src/types";
import { buildMessages, parseModelOutput, verifyProposals, type RawProposal } from "./extraction";
import { MEDDPICC_FIELDS, labelFor } from "./fields";
import { sha256Hex } from "./hash";
import type { ModelClient } from "./model";
import type { DroppedField, NotWritableField, Proposal } from "./proposal";

export interface DraftDeps {
  gatekeeper: Pick<SalesforceGatekeeperApi, "readOpportunity" | "logProposal" | "requestFieldUpdate">;
  model: ModelClient;
  /** The text of context/meddpicc.md. */
  context: string;
  now?: () => Date;
  newId?: () => string;
}

export interface DraftInput {
  opportunityId: string;
  transcriptId: string;
  transcript: string;
  actor: Caller;
}

export type DraftResult =
  | { ok: true; proposal: Proposal }
  | { ok: false; stage: "read" | "log"; reason: string };

export async function draftProposal(deps: DraftDeps, input: DraftInput): Promise<DraftResult> {
  const { opportunityId, transcriptId, transcript, actor } = input;
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => `p-${crypto.randomUUID()}`);

  // 1. The opportunity as Salesforce holds it now. The gatekeeper keeps a
  //    snapshot, which the stale check compares against at write time.
  const read = await deps.gatekeeper.readOpportunity({ opportunityId, actor });
  if (!read.ok) return { ok: false, stage: "read", reason: read.reason };
  const current = read.fields;

  // 2. The one model call. A failure here is "no proposal", not an error page.
  //    The model is not told what Salesforce holds: step 3 decides that in code.
  const messages = buildMessages({ context: deps.context, transcript });
  let modelId = deps.model.id;
  let gatewayLogId: string | null = null;
  let accepted: RawProposal[] = [];
  let signals: RawProposal[] = [];
  let dropped: DroppedField[] = [];
  try {
    const answer = await deps.model.extract({
      messages,
      transcriptId,
      metadata: { opportunity: opportunityId, transcript: transcriptId },
    });
    modelId = answer.modelId;
    gatewayLogId = answer.gatewayLogId;

    // 3. The schema check, then the quote check, then the empty-only rule: a
    //    field that already has a value is left alone. All in code. A forecast
    //    signal gets the same quote check.
    const parsed = parseModelOutput(answer.output);
    if (parsed.ok) {
      ({ accepted, dropped } = verifyProposals(parsed.proposals, transcript, current));
      const checked = verifyProposals(parsed.signals, transcript);
      signals = checked.accepted;
      dropped = [...dropped, ...checked.dropped];
    } else {
      dropped = [{ field: null, label: null, value: null, quote: null, reason: parsed.reason }];
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dropped = [{ field: null, label: null, value: null, quote: null, reason: `the model call failed: ${message}`.slice(0, 500) }];
  }

  const id = newId();
  const transcriptHash = sha256Hex(transcript);
  const contextHash = sha256Hex(deps.context);

  // 4. A forecast field the call says has changed. The agent cannot propose
  //    it, so it asks the gatekeeper, which answers from the policy file. The
  //    refusal on the review page is the gatekeeper's own, and it is logged there.
  const notWritable: NotWritableField[] = [];
  for (const signal of signals) {
    const answer = await deps.gatekeeper.requestFieldUpdate({
      opportunityId,
      field: signal.field,
      value: signal.value,
      actor,
      source: { proposalId: id, transcriptHash, contextHash, modelId, quote: signal.quotes.join("\n") },
    });
    notWritable.push({
      field: signal.field,
      label: labelFor(signal.field),
      current: current[signal.field] ?? null,
      requested: signal.value,
      quotes: signal.quotes,
      outcome: answer.outcome,
      code: answer.code,
      rule: answer.rule,
      reason: answer.reason,
      auditSeq: answer.auditSeq,
    });
  }

  const proposal: Proposal = {
    id,
    opportunityId,
    opportunityName: current.Name ?? null,
    accountName: current["Account.Name"] ?? null,
    transcriptId,
    transcriptHash,
    contextHash,
    modelId,
    gatewayLogId,
    snapshotId: read.snapshotId,
    createdAt: now().toISOString(),
    fields: accepted.map((item) => ({
      field: item.field,
      label: labelFor(item.field),
      current: current[item.field] ?? null,
      proposed: item.value,
      quotes: item.quotes,
      decision: null,
      decidedValue: null,
      decidedBy: null,
      result: null,
    })),
    dropped,
    askNext: MEDDPICC_FIELDS.filter(
      (f) => !(current[f.field] ?? "").trim() && !accepted.some((item) => item.field === f.field),
    ).map((f) => ({ field: f.field, label: f.label })),
    notWritable,
  };

  // 5. Tell the audit log what was proposed and what was dropped.
  const logged = await deps.gatekeeper.logProposal({
    opportunityId,
    proposalId: proposal.id,
    snapshotId: proposal.snapshotId,
    transcriptHash: proposal.transcriptHash,
    contextHash: proposal.contextHash,
    modelId: proposal.modelId,
    proposed: proposal.fields.map((f) => ({ field: f.field, value: f.proposed, quote: f.quotes.join("\n") })),
    dropped: proposal.dropped.map((d) => ({ field: d.field, value: d.value, reason: d.reason })),
    actor,
  });
  if (!logged.ok) return { ok: false, stage: "log", reason: logged.reason };

  return { ok: true, proposal };
}
