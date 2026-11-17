import { DurableObject } from "cloudflare:workers";
import rawPolicy from "../../../policy/opportunity.json";
import { AccessVerifier, accessSetup } from "./access";
import { AuditLog, type AuditEntry, type AuditRow, type VerifyResult } from "./audit";
import { canonical, sha256Hex } from "./canonical";
import { identifyCaller, type Identity } from "./identity";
import {
  MAX_VALUE_LENGTH,
  UNKNOWN,
  evaluateWrite,
  known,
  parsePolicy,
  readableFields,
  ruleFor,
  type ApprovalRecord,
  type DecisionKind,
  type Known,
} from "./policy";
import { OPPORTUNITY_ID, SalesforceClient, SalesforceError } from "./salesforce-client";
import type {
  ApprovedUpdateRequest,
  AuditQuery,
  Caller,
  DecisionRequest,
  DecisionResult,
  FieldResult,
  FieldUpdateRequest,
  GatekeeperEnv,
  ProposalLogRequest,
  ProposalLogResult,
  PersonEvidence,
  ReadRequest,
  ReadResult,
  WhoResult,
} from "./types";

/** Parsed once at load. An invalid policy file stops the Worker from starting. */
export const POLICY = parsePolicy(rawPolicy);

const PROPOSAL_ID = /^[A-Za-z0-9_-]{1,64}$/;
const DECISIONS: readonly DecisionKind[] = ["approve", "edit", "reject"];
const UNIDENTIFIED = "unidentified";
const SHA256_HEX = /^[0-9a-f]{64}$/;
const MODEL_ID = /^[A-Za-z0-9@_.:/-]{1,128}$/;
const MAX_LOGGED_ITEMS = 32;
const MAX_QUOTE_LENGTH = 2_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL,
  time TEXT NOT NULL,
  field_values TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals (
  proposal_id TEXT NOT NULL,
  field TEXT NOT NULL,
  opportunity_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  value TEXT,
  approver TEXT NOT NULL,
  time TEXT NOT NULL,
  audit_seq INTEGER NOT NULL,
  PRIMARY KEY (proposal_id, field)
);
`;

type ApprovalRow = {
  proposal_id: string;
  field: string;
  opportunity_id: string;
  decision: string;
  value: string | null;
  approver: string;
};

/**
 * The gatekeeper singleton. It holds the Salesforce credential, the approval
 * records, the snapshots that the stale check compares against, and the audit
 * log. Whether a write happens is decided by `evaluateWrite`, never by a model.
 *
 * Named to match the `CustomGatekeeper` class in cloudflare-os-starter.
 */
export class SalesforceGatekeeper extends DurableObject<GatekeeperEnv> {
  private readonly audit: AuditLog;
  private readonly salesforce: SalesforceClient;
  private readonly access: AccessVerifier;
  /** Applies run one at a time, so two cannot pass the stale check together. */
  private applying: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: GatekeeperEnv) {
    super(ctx, env);
    ctx.storage.sql.exec(SCHEMA);
    this.audit = new AuditLog(ctx.storage);
    this.salesforce = new SalesforceClient({
      loginUrl: env.SF_LOGIN_URL,
      consumerKey: env.SF_CONSUMER_KEY,
      consumerSecret: env.SF_CONSUMER_SECRET,
      apiVersion: env.SF_API_VERSION,
    });
    this.access = new AccessVerifier(accessSetup(env.TEAM_DOMAIN, env.POLICY_AUD));
  }

  async whoIs(evidence: PersonEvidence): Promise<WhoResult> {
    const who = await this.identify(evidence);
    if (!who.ok) return { ok: false, reason: who.reason };
    if (!who.person) return { ok: false, reason: "that is not a person" };
    return { ok: true, label: who.label, kind: who.label.startsWith("user:") ? "access" : "dev" };
  }

  async readOpportunity(request: ReadRequest): Promise<ReadResult> {
    const who = await this.identify(request?.actor);
    const opportunityId = OPPORTUNITY_ID.test(request?.opportunityId) ? request.opportunityId : null;
    const refuse = (reason: string, outcome: "refused" | "failed"): ReadResult => {
      const row = this.log({ actor: who.ok ? who.label : UNIDENTIFIED, action: "read", outcome, opportunityId, reason });
      return { ok: false, reason, auditSeq: row.seq };
    };
    if (!who.ok) return refuse(who.reason, "refused");
    if (!opportunityId) return refuse("that is not an Opportunity id", "refused");

    let fields: Record<string, string | null>;
    try {
      fields = await this.salesforce.readOpportunity(opportunityId, readableFields(POLICY));
    } catch (error) {
      return refuse(describe(error), "failed");
    }

    const snapshotId = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      "INSERT INTO snapshots (id, opportunity_id, time, field_values) VALUES (?, ?, ?, ?)",
      snapshotId,
      opportunityId,
      new Date().toISOString(),
      JSON.stringify(fields),
    );
    const row = this.log({
      actor: who.label,
      action: "read",
      outcome: "allowed",
      opportunityId,
      detail: { snapshot_id: snapshotId, fields: Object.keys(fields), values_hash: sha256Hex(canonical(fields)) },
    });
    return { ok: true, opportunityId, snapshotId, fields, auditSeq: row.seq };
  }

  async recordDecision(request: DecisionRequest): Promise<DecisionResult> {
    const who = await this.identify(request?.approver);
    const opportunityId = OPPORTUNITY_ID.test(request?.opportunityId) ? request.opportunityId : null;
    const proposalId = PROPOSAL_ID.test(request?.proposalId) ? request.proposalId : null;
    const field = typeof request?.field === "string" ? request.field : null;
    const refuse = (code: Exclude<DecisionResult, { ok: true }>["code"], reason: string, rule?: string): DecisionResult => {
      const row = this.log({
        actor: who.ok ? who.label : UNIDENTIFIED,
        action: "refuse",
        outcome: "refused",
        opportunityId,
        proposalId,
        field,
        reason,
        detail: { attempted: "decision", code, ...(rule ? { rule } : {}) },
      });
      return { ok: false, code, reason, auditSeq: row.seq };
    };

    if (!who.ok) return refuse("not_a_person", who.reason);
    if (!who.person) return refuse("not_a_person", "only a signed-in person can approve, edit or reject");
    if (!opportunityId || !proposalId || !field || !DECISIONS.includes(request.decision)) {
      return refuse("invalid_request", "the decision is missing a valid opportunity, proposal, field or decision");
    }

    const { rule, name } = ruleFor(POLICY, field);
    if (rule === "manager_approval") {
      return refuse("needs_manager_approval", `${field} is a forecast field: a rep cannot approve it`, name);
    }
    if (rule !== "rep_approval") return refuse("field_denied", `${field} is not a field a rep can approve`, name);

    const rejecting = request.decision === "reject";
    const value = rejecting ? null : request.value;
    if (!rejecting && (typeof value !== "string" || value.trim() === "" || value.length > MAX_VALUE_LENGTH)) {
      return refuse("invalid_value", `the value for ${field} must be text of 1 to ${MAX_VALUE_LENGTH} characters`, name);
    }

    const proposed = typeof request.proposedValue === "string" ? request.proposedValue : null;
    return this.ctx.storage.transactionSync(() => {
      const row = this.log({
        actor: who.label,
        action: request.decision,
        outcome: "recorded",
        opportunityId,
        proposalId,
        field,
        valueAfter: value,
        detail: proposed !== null && proposed !== value ? { proposed_value: proposed } : null,
      });
      // The latest decision on a field replaces an earlier one. Every one stays in the audit log.
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO approvals (proposal_id, field, opportunity_id, decision, value, approver, time, audit_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        proposalId,
        field,
        opportunityId,
        request.decision,
        value,
        who.label,
        row.time,
        row.seq,
      );
      return { ok: true, approver: who.label, auditSeq: row.seq };
    });
  }

  async applyApprovedUpdate(request: ApprovedUpdateRequest): Promise<FieldResult[]> {
    const run = this.applying.then(() => this.apply(request));
    this.applying = run.catch(() => undefined);
    return run;
  }

  private async apply(request: ApprovedUpdateRequest): Promise<FieldResult[]> {
    const who = await this.identify(request?.actor);
    const actor = who.ok ? who.label : UNIDENTIFIED;
    const opportunityId = OPPORTUNITY_ID.test(request?.opportunityId) ? request.opportunityId : null;
    const proposalId = PROPOSAL_ID.test(request?.proposalId) ? request.proposalId : null;
    const items = Array.isArray(request?.fields) ? request.fields : [];

    const refuseAll = (code: FieldResult["code"], reason: string): FieldResult[] =>
      (items.length > 0 ? items : [{ field: "", value: "" }]).map((item) =>
        this.refuse({ actor, opportunityId, proposalId, field: String(item?.field ?? ""), value: item?.value, code, rule: null, reason }),
      );
    if (!who.ok) return refuseAll("not_identified", who.reason);
    if (!opportunityId || !proposalId || items.length === 0) {
      return refuseAll("invalid_request", "the update is missing a valid opportunity, proposal or field list");
    }

    const before = this.snapshot(request.snapshotId, opportunityId);

    // First pass with the current value assumed equal to the snapshot. A field
    // that fails here fails on policy or approval, and needs no Salesforce call.
    const seen = new Set<string>();
    const results = new Map<number, FieldResult>();
    const candidates: { index: number; field: string; value: string; approval: ApprovalRecord }[] = [];
    items.forEach((item, index) => {
      const field = String(item?.field ?? "");
      const base = { actor, opportunityId, proposalId, field, value: item?.value };
      if (seen.has(field)) {
        results.set(index, this.refuse({ ...base, code: "duplicate_field", rule: null, reason: `${field} is listed twice` }));
        return;
      }
      seen.add(field);
      const approval = this.approval(proposalId, field, opportunityId);
      const fieldBefore = valueOf(before, field);
      const decision = evaluateWrite(POLICY, { proposalId, field, value: item?.value, approval, before: fieldBefore, current: fieldBefore });
      if (!decision.allowed) {
        results.set(index, this.refuse({ ...base, code: decision.code, rule: decision.rule, reason: decision.reason }));
        return;
      }
      candidates.push({ index, field, value: item.value, approval: approval! });
    });

    if (candidates.length > 0) {
      // Second pass, against what Salesforce holds right now.
      let current: Known<Record<string, string | null>>;
      let readProblem = "";
      try {
        current = known(await this.salesforce.readOpportunity(opportunityId, candidates.map((c) => c.field)));
        this.log({ actor, action: "read", outcome: "allowed", opportunityId, proposalId, reason: "stale check before write" });
      } catch (error) {
        current = UNKNOWN;
        readProblem = describe(error);
        this.log({ actor, action: "read", outcome: "failed", opportunityId, proposalId, reason: readProblem });
      }

      const writes: typeof candidates = [];
      for (const candidate of candidates) {
        const { index, field, value, approval } = candidate;
        const decision = evaluateWrite(POLICY, {
          proposalId,
          field,
          value,
          approval,
          before: valueOf(before, field),
          current: valueOf(current, field),
        });
        if (decision.allowed) {
          writes.push(candidate);
          continue;
        }
        const reason = decision.code === "current_unknown" && readProblem ? `${decision.reason} (${readProblem})` : decision.reason;
        results.set(index, this.refuse({ actor, opportunityId, proposalId, field, value, code: decision.code, rule: decision.rule, reason, valueBefore: valueOf(current, field) }));
      }

      if (writes.length > 0) {
        let failure: string | null = null;
        try {
          await this.salesforce.updateOpportunity(opportunityId, Object.fromEntries(writes.map((w) => [w.field, w.value])));
        } catch (error) {
          failure = describe(error);
        }
        for (const { index, field, value, approval } of writes) {
          const valueBefore = valueOf(current, field);
          const row = this.log({
            actor,
            action: "write",
            outcome: failure ? "failed" : "applied",
            opportunityId,
            proposalId,
            field,
            valueBefore: valueBefore.known ? valueBefore.value : null,
            valueAfter: value,
            reason: failure ?? `approved by ${approval.approver}`,
            detail: { rule: ruleFor(POLICY, field).name, approved_by: approval.approver },
          });
          results.set(index, {
            field,
            outcome: failure ? "failed" : "written",
            code: failure ? "salesforce_error" : "approved",
            rule: ruleFor(POLICY, field).name,
            reason: failure ?? `approved by ${approval.approver}`,
            auditSeq: row.seq,
          });
        }
      }
    }

    return items.map((_, index) => results.get(index)!);
  }

  async requestFieldUpdate(request: FieldUpdateRequest): Promise<FieldResult> {
    const who = await this.identify(request?.actor);
    const actor = who.ok ? who.label : UNIDENTIFIED;
    const opportunityId = OPPORTUNITY_ID.test(request?.opportunityId) ? request.opportunityId : null;
    const field = String(request?.field ?? "");
    const base = { actor, opportunityId, proposalId: null, field, value: request?.value, source: sourceOf(request?.source) };
    if (!who.ok) return this.refuse({ ...base, code: "not_identified", rule: null, reason: who.reason });
    if (!opportunityId) {
      return this.refuse({ ...base, code: "invalid_request", rule: null, reason: "that is not an Opportunity id" });
    }
    // No approval record is passed, so no rule can allow this. The evaluator
    // still runs, to name the rule and the reason. Salesforce is not called.
    const decision = evaluateWrite(POLICY, {
      proposalId: null,
      field,
      value: request.value,
      approval: null,
      before: UNKNOWN,
      current: UNKNOWN,
    });
    return this.refuse({ ...base, code: decision.allowed ? "needs_rep_approval" : decision.code, rule: decision.rule, reason: decision.reason });
  }

  async logProposal(request: ProposalLogRequest): Promise<ProposalLogResult> {
    const who = await this.identify(request?.actor);
    const opportunityId = OPPORTUNITY_ID.test(request?.opportunityId) ? request.opportunityId : null;
    const proposalId = PROPOSAL_ID.test(request?.proposalId) ? request.proposalId : null;
    const refuse = (reason: string): ProposalLogResult => {
      const row = this.log({ actor: who.ok ? who.label : UNIDENTIFIED, action: "refuse", outcome: "refused", opportunityId, proposalId, reason, detail: { attempted: "log_proposal" } });
      return { ok: false, reason, auditSeq: row.seq };
    };
    if (!who.ok) return refuse(who.reason);
    if (!opportunityId || !proposalId) return refuse("the proposal is missing a valid opportunity or proposal id");

    const { transcriptHash, contextHash, modelId } = request;
    if (!SHA256_HEX.test(transcriptHash) || !SHA256_HEX.test(contextHash) || !MODEL_ID.test(modelId)) {
      return refuse("the proposal is missing a valid transcript hash, context hash or model id");
    }
    const proposed = Array.isArray(request.proposed) ? request.proposed : null;
    const dropped = Array.isArray(request.dropped) ? request.dropped : null;
    if (!proposed || !dropped || proposed.length + dropped.length > MAX_LOGGED_ITEMS) {
      return refuse("the proposal's field lists are missing or too long");
    }
    const text = (value: unknown, max: number): string | null => (typeof value === "string" ? value.slice(0, max) : null);
    if (proposed.some((item) => !text(item?.field, 80) || !text(item?.value, MAX_VALUE_LENGTH) || !text(item?.quote, MAX_QUOTE_LENGTH))) {
      return refuse("a proposed field is missing its name, value or quote");
    }
    if (dropped.some((item) => !text(item?.reason, 500))) return refuse("a dropped field is missing its reason");

    const before = this.snapshot(request.snapshotId, opportunityId);
    const source = { opportunityId, proposalId, transcriptHash, contextHash, modelId };
    return this.ctx.storage.transactionSync(() => {
      const auditSeqs: number[] = [];
      for (const item of proposed) {
        const valueBefore = valueOf(before, item.field);
        auditSeqs.push(
          this.log({
            ...source,
            actor: who.label,
            action: "propose",
            outcome: "recorded",
            field: text(item.field, 80),
            valueBefore: valueBefore.known ? valueBefore.value : null,
            valueAfter: text(item.value, MAX_VALUE_LENGTH),
            detail: { quote: text(item.quote, MAX_QUOTE_LENGTH), snapshot_id: text(request.snapshotId, 64) },
          }).seq,
        );
      }
      for (const item of dropped) {
        auditSeqs.push(
          this.log({
            ...source,
            actor: who.label,
            action: "drop",
            outcome: "recorded",
            field: text(item.field, 80),
            valueAfter: text(item.value, MAX_VALUE_LENGTH),
            reason: text(item.reason, 500),
          }).seq,
        );
      }
      return { ok: true, auditSeqs };
    });
  }

  async listAudit(query: AuditQuery = {}): Promise<AuditRow[]> {
    const limit = Math.min(Math.max(Math.trunc(query?.limit ?? 200), 1), 1000);
    const opportunityId = OPPORTUNITY_ID.test(query?.opportunityId ?? "") ? query.opportunityId : undefined;
    return this.audit.rows({ opportunityId, limit });
  }

  async verifyAudit(): Promise<VerifyResult> {
    return this.audit.verify();
  }

  /** Every audit row carries the hash of the policy in force. */
  private log(entry: AuditEntry): AuditRow {
    return this.audit.append({ ...entry, policyHash: POLICY.hash });
  }

  private refuse(input: {
    actor: string;
    opportunityId: string | null;
    proposalId: string | null;
    field: string;
    value: unknown;
    code: FieldResult["code"];
    rule: string | null;
    reason: string;
    valueBefore?: Known<string | null>;
    source?: RequestSource | null;
  }): FieldResult {
    const source = input.source ?? null;
    const row = this.log({
      actor: input.actor,
      action: "refuse",
      outcome: "refused",
      opportunityId: input.opportunityId,
      proposalId: source?.proposalId ?? input.proposalId,
      transcriptHash: source?.transcriptHash,
      contextHash: source?.contextHash,
      modelId: source?.modelId,
      field: input.field || null,
      valueBefore: input.valueBefore?.known ? input.valueBefore.value : null,
      // Keep what was asked for, cut to the field's own limit.
      valueAfter: typeof input.value === "string" ? input.value.slice(0, MAX_VALUE_LENGTH) : null,
      reason: input.reason,
      detail: { code: input.code, ...(input.rule ? { rule: input.rule } : {}), ...(source?.quote ? { quote: source.quote } : {}) },
    });
    return { field: input.field, outcome: "refused", code: input.code, rule: input.rule, reason: input.reason, auditSeq: row.seq };
  }

  /** An Access token is verified against Access's public keys. Anything else is settled without the network. */
  private async identify(caller: Caller | undefined): Promise<Identity> {
    if (caller?.kind === "access_jwt") return this.access.identify(caller.token);
    return identifyCaller(caller, this.env.DEV_IDENTITY);
  }

  /** The values captured by the read a proposal was drafted against, if that read is on record. */
  private snapshot(snapshotId: unknown, opportunityId: string): Known<Record<string, string | null>> {
    if (typeof snapshotId !== "string") return UNKNOWN;
    const row = this.ctx.storage.sql
      .exec<{ field_values: string }>("SELECT field_values FROM snapshots WHERE id = ? AND opportunity_id = ?", snapshotId, opportunityId)
      .toArray()[0];
    return row ? known(JSON.parse(row.field_values) as Record<string, string | null>) : UNKNOWN;
  }

  private approval(proposalId: string, field: string, opportunityId: string): ApprovalRecord | null {
    const row = this.ctx.storage.sql
      .exec<ApprovalRow>("SELECT * FROM approvals WHERE proposal_id = ? AND field = ? AND opportunity_id = ?", proposalId, field, opportunityId)
      .toArray()[0];
    if (!row) return null;
    return { proposalId: row.proposal_id, field: row.field, decision: row.decision as DecisionKind, value: row.value, approver: row.approver };
  }
}

interface RequestSource {
  proposalId: string;
  transcriptHash: string;
  contextHash: string;
  modelId: string;
  quote: string | null;
}

/**
 * Where a direct request says it came from, kept only when every part is well
 * formed. A malformed source is left off the row; the request is judged the same either way.
 */
function sourceOf(source: FieldUpdateRequest["source"]): RequestSource | null {
  if (typeof source !== "object" || source === null) return null;
  const { proposalId, transcriptHash, contextHash, modelId, quote } = source;
  if (typeof proposalId !== "string" || !PROPOSAL_ID.test(proposalId)) return null;
  if (typeof transcriptHash !== "string" || !SHA256_HEX.test(transcriptHash)) return null;
  if (typeof contextHash !== "string" || !SHA256_HEX.test(contextHash)) return null;
  if (typeof modelId !== "string" || !MODEL_ID.test(modelId)) return null;
  return { proposalId, transcriptHash, contextHash, modelId, quote: typeof quote === "string" ? quote.slice(0, MAX_QUOTE_LENGTH) : null };
}

/** One field out of a set of values. Unknown when the set is unknown or does not hold the field. */
function valueOf(values: Known<Record<string, string | null>>, field: string): Known<string | null> {
  if (!values.known || !Object.hasOwn(values.value, field)) return UNKNOWN;
  return known(values.value[field] ?? null);
}

function describe(error: unknown): string {
  if (error instanceof SalesforceError) return error.message;
  return `unexpected error: ${error instanceof Error ? error.message : String(error)}`;
}
