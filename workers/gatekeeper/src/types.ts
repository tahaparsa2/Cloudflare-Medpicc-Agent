/**
 * The API the agent Worker may call on the gatekeeper.
 *
 * Three operations touch Salesforce: readOpportunity, applyApprovedUpdate and
 * requestFieldUpdate. recordDecision stores a signed-in person's decision and
 * needs proof of that person, which no agent has. logProposal only adds audit
 * rows. listAudit, verifyAudit and whoIs only read.
 */

import type { AuditRow, VerifyResult } from "./audit";
import type { DecisionKind, ReasonCode } from "./policy";
import type { SalesforceGatekeeper } from "./salesforce";

export type { AuditRow, VerifyResult } from "./audit";
export type { DecisionKind, ReasonCode } from "./policy";

export interface GatekeeperEnv {
  GATEKEEPER: DurableObjectNamespace<SalesforceGatekeeper>;
  SF_API_VERSION: string;
  SF_LOGIN_URL: string;
  SF_CONSUMER_KEY: string;
  SF_CONSUMER_SECRET: string;
  /**
   * Local development only. When set (in .dev.vars), `{ kind: "dev" }` is
   * accepted as a person and recorded as `dev:<this value>`. It is empty in
   * wrangler.jsonc, so a deployed gatekeeper refuses the dev identity.
   */
  DEV_IDENTITY: string;
  /**
   * Cloudflare Access: the team domain (https://<team>.cloudflareaccess.com)
   * and the AUD tag of the Access application in front of the agent Worker.
   * Neither is a secret, but they are set with `wrangler secret put` so the
   * team name stays out of the repo. Until both are set no token is accepted.
   */
  TEAM_DOMAIN?: string;
  POLICY_AUD?: string;
}

/**
 * Proof of a signed-in person.
 * `access_jwt` is the Cloudflare Access token, which the gatekeeper verifies itself.
 * `dev` carries no name on purpose: the identity comes from the gatekeeper's own config.
 */
export type PersonEvidence = { kind: "access_jwt"; token: string } | { kind: "dev" };

/** Who or what is calling. An agent names itself; a person has to prove it. */
export type Caller = { kind: "agent"; id: string } | PersonEvidence;

export interface ReadRequest {
  opportunityId: string;
  actor: Caller;
}

export type ReadResult =
  | {
      ok: true;
      opportunityId: string;
      /** Names this read. A proposal drafted from it passes the id back on apply. */
      snapshotId: string;
      /** Field values as text, null when empty. */
      fields: Record<string, string | null>;
      auditSeq: number;
    }
  | { ok: false; reason: string; auditSeq: number };

export interface DecisionRequest {
  opportunityId: string;
  proposalId: string;
  field: string;
  decision: DecisionKind;
  /** The exact value approved. For an edit, the edited value. Null for a rejection. */
  value: string | null;
  /** For an edit: what the agent proposed, kept for the audit trail. */
  proposedValue?: string | null;
  approver: PersonEvidence;
}

export type DecisionResult =
  | { ok: true; approver: string; auditSeq: number }
  | { ok: false; code: ReasonCode | "not_a_person" | "invalid_request"; reason: string; auditSeq: number };

export interface ApprovedUpdateRequest {
  opportunityId: string;
  proposalId: string;
  /** From the readOpportunity call the proposal was drafted against. */
  snapshotId: string;
  fields: { field: string; value: string }[];
  actor: Caller;
}

export interface FieldUpdateRequest {
  opportunityId: string;
  field: string;
  value: string;
  actor: Caller;
  /**
   * Where the request came from, when an agent raised it from a call. Recorded
   * on the audit row. It is a description, not an approval: it changes nothing
   * about whether the request is allowed.
   */
  source?: {
    proposalId: string;
    transcriptHash: string;
    contextHash: string;
    modelId: string;
    /** The line from the call behind the request. */
    quote?: string;
  };
}

export interface FieldResult {
  field: string;
  /** written: now in Salesforce. refused: policy said no. failed: Salesforce did not accept it. */
  outcome: "written" | "refused" | "failed";
  code: ReasonCode | "not_identified" | "invalid_request" | "duplicate_field" | "salesforce_error";
  /** The policy rule that decided it, when policy was reached. */
  rule: string | null;
  reason: string;
  auditSeq: number;
}

/** What the agent drafted from one call. Recorded in the audit log; changes nothing else. */
export interface ProposalLogRequest {
  opportunityId: string;
  proposalId: string;
  /** From the readOpportunity call the proposal was drafted against. */
  snapshotId: string;
  /** SHA-256 of the transcript, of the context file, and the model that read them. */
  transcriptHash: string;
  contextHash: string;
  modelId: string;
  /** Proposals whose quote was found in the transcript. */
  proposed: { field: string; value: string; quote: string }[];
  /** Proposals the agent's own checks threw out, and why. A null field means the whole model answer was unusable. */
  dropped: { field: string | null; value: string | null; reason: string }[];
  actor: Caller;
}

export type ProposalLogResult = { ok: true; auditSeqs: number[] } | { ok: false; reason: string; auditSeq: number };

export interface AuditQuery {
  opportunityId?: string;
  /** Newest rows to return. Default 200, at most 1000. */
  limit?: number;
}

/** Who a piece of proof names. `access`: a verified Cloudflare Access sign-in. `dev`: the local dev identity. */
export type WhoResult = { ok: true; label: string; kind: "access" | "dev" } | { ok: false; reason: string };

export interface SalesforceGatekeeperApi {
  /** Check a person's proof and say who it names. Changes nothing and logs nothing. */
  whoIs(evidence: PersonEvidence): Promise<WhoResult>;

  /** Read the opportunity's policy-readable fields and remember them as a snapshot. */
  readOpportunity(request: ReadRequest): Promise<ReadResult>;

  /** Store a person's approve, edit or reject on one field of a proposal. */
  recordDecision(request: DecisionRequest): Promise<DecisionResult>;

  /** Write the fields of a proposal that a person approved, where policy allows. */
  applyApprovedUpdate(request: ApprovedUpdateRequest): Promise<FieldResult[]>;

  /** A direct write request with no approval behind it. Policy decides; in this demo it never writes. */
  requestFieldUpdate(request: FieldUpdateRequest): Promise<FieldResult>;

  /** Audit only: note what the agent proposed and what it dropped. Writes nothing to Salesforce and approves nothing. */
  logProposal(request: ProposalLogRequest): Promise<ProposalLogResult>;

  listAudit(query?: AuditQuery): Promise<AuditRow[]>;

  /** Recompute the audit chain. Intact, or the first broken row. */
  verifyAudit(): Promise<VerifyResult>;
}
