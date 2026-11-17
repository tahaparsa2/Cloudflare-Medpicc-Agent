/**
 * The audit log: an append-only SQLite table with a hash chain.
 *
 * Ported from GTM OS module 2.1 (design, not the code):
 *   - each row stores the hash of the row before it, computed over a canonical
 *     serialization of every column except `hash`, so an edited, deleted or
 *     reordered row breaks the chain;
 *   - SQLite triggers refuse UPDATE and DELETE, so ordinary code cannot change
 *     a row;
 *   - the newest row's sequence number and hash are also kept outside the
 *     table (the stored head), so rows deleted from the end are caught too.
 *
 * GTM OS keeps the head in a file beside the database. Here it lives in the
 * Durable Object's key-value store, which SQL statements cannot reach.
 */

import { canonical, sha256Hex } from "./canonical";

export const GENESIS_HASH = "0".repeat(64);

/** Columns covered by the hash, in table order. `seq` is included so reordering shows. */
export const HASHED_COLUMNS = [
  "seq",
  "time",
  "actor",
  "action",
  "opportunity_id",
  "field",
  "value_before",
  "value_after",
  "proposal_id",
  "transcript_hash",
  "model_id",
  "context_hash",
  "policy_hash",
  "outcome",
  "reason",
  "detail",
  "prev_hash",
] as const;

export type AuditAction = "read" | "propose" | "drop" | "approve" | "edit" | "reject" | "write" | "refuse";

/**
 * allowed: a read that was served.   recorded: an event noted, nothing written.
 * applied: a write that reached Salesforce.   refused: policy said no.
 * failed:  policy said yes and Salesforce did not accept it.
 */
export type AuditOutcome = "allowed" | "recorded" | "applied" | "refused" | "failed";

/** What a caller supplies for one row. Sequence, time and hashes are added on append. */
export interface AuditEntry {
  actor: string;
  action: AuditAction;
  outcome: AuditOutcome;
  opportunityId?: string | null;
  field?: string | null;
  valueBefore?: string | null;
  valueAfter?: string | null;
  proposalId?: string | null;
  transcriptHash?: string | null;
  modelId?: string | null;
  contextHash?: string | null;
  policyHash?: string | null;
  reason?: string | null;
  /** Extra facts, such as the rule that decided a refusal. Stored as canonical JSON. */
  detail?: Record<string, unknown> | null;
}

export type AuditRow = {
  seq: number;
  time: string;
  actor: string;
  action: string;
  opportunity_id: string | null;
  field: string | null;
  value_before: string | null;
  value_after: string | null;
  proposal_id: string | null;
  transcript_hash: string | null;
  model_id: string | null;
  context_hash: string | null;
  policy_hash: string | null;
  outcome: string;
  reason: string | null;
  detail: string | null;
  prev_hash: string;
  hash: string;
};

export interface VerifyResult {
  /** True when the chain is intact. Otherwise `badSeq` is the first row at fault. */
  ok: boolean;
  rowsChecked: number;
  badSeq: number | null;
  problem: string | null;
}

/** The log no longer matches its stored head, so appending to it would hide the damage. */
export class AuditTamperedError extends Error {}

export function rowHash(row: Omit<AuditRow, "hash">): string {
  const hashed: Record<string, unknown> = {};
  for (const column of HASHED_COLUMNS) hashed[column] = row[column];
  return sha256Hex(canonical(hashed));
}

/** Walk rows oldest first and recompute the chain. */
export function checkChain(rows: Iterable<AuditRow>): VerifyResult {
  let expectedPrev = GENESIS_HASH;
  let expectedSeq = 1;
  let checked = 0;
  const bad = (seq: number, problem: string): VerifyResult => ({
    ok: false,
    rowsChecked: checked,
    badSeq: seq,
    problem,
  });
  for (const row of rows) {
    checked += 1;
    if (row.seq !== expectedSeq) return bad(row.seq, `expected row ${expectedSeq}, found row ${row.seq}`);
    if (row.prev_hash !== expectedPrev) return bad(row.seq, "previous-row hash does not match");
    if (rowHash(row) !== row.hash) return bad(row.seq, "row content does not match its hash");
    expectedPrev = row.hash;
    expectedSeq += 1;
  }
  return { ok: true, rowsChecked: checked, badSeq: null, problem: null };
}

interface StoredHead {
  seq: number;
  hash: string;
}

const HEAD_KEY = "audit_head";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS audit_log (
  seq INTEGER PRIMARY KEY,
  time TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  opportunity_id TEXT,
  field TEXT,
  value_before TEXT,
  value_after TEXT,
  proposal_id TEXT,
  transcript_hash TEXT,
  model_id TEXT,
  context_hash TEXT,
  policy_hash TEXT,
  outcome TEXT NOT NULL,
  reason TEXT,
  detail TEXT,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
`;

export class AuditLog {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.storage.sql.exec(SCHEMA);
  }

  /**
   * Add a row and move the stored head, in one transaction.
   * Throws `AuditTamperedError` and writes nothing if the log has lost rows or its head.
   */
  append(entry: AuditEntry): AuditRow {
    return this.storage.transactionSync(() => {
      const last = this.lastRow();
      this.checkHead(last);
      const body: Omit<AuditRow, "hash"> = {
        seq: last ? last.seq + 1 : 1,
        time: this.now().toISOString(),
        actor: entry.actor,
        action: entry.action,
        opportunity_id: entry.opportunityId ?? null,
        field: entry.field ?? null,
        value_before: entry.valueBefore ?? null,
        value_after: entry.valueAfter ?? null,
        proposal_id: entry.proposalId ?? null,
        transcript_hash: entry.transcriptHash ?? null,
        model_id: entry.modelId ?? null,
        context_hash: entry.contextHash ?? null,
        policy_hash: entry.policyHash ?? null,
        outcome: entry.outcome,
        reason: entry.reason ?? null,
        detail: entry.detail ? canonical(entry.detail) : null,
        prev_hash: last ? last.hash : GENESIS_HASH,
      };
      const row: AuditRow = { ...body, hash: rowHash(body) };
      const columns = [...HASHED_COLUMNS, "hash"] as const;
      this.storage.sql.exec(
        `INSERT INTO audit_log (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
        ...columns.map((column) => row[column]),
      );
      this.storage.kv.put(HEAD_KEY, { seq: row.seq, hash: row.hash } satisfies StoredHead);
      return row;
    });
  }

  /** Rows oldest first. With a limit, the newest `limit` rows, still oldest first. */
  rows(filter: { opportunityId?: string; limit?: number } = {}): AuditRow[] {
    const where = filter.opportunityId ? "WHERE opportunity_id = ?" : "";
    const bindings: (string | number)[] = filter.opportunityId ? [filter.opportunityId] : [];
    if (filter.limit === undefined) {
      return this.storage.sql.exec<AuditRow>(`SELECT * FROM audit_log ${where} ORDER BY seq`, ...bindings).toArray();
    }
    return this.storage.sql
      .exec<AuditRow>(`SELECT * FROM audit_log ${where} ORDER BY seq DESC LIMIT ?`, ...bindings, filter.limit)
      .toArray()
      .reverse();
  }

  /**
   * Recompute the chain, then compare its end with the stored head.
   * Catches edited, reordered and deleted rows, including rows deleted from the end.
   */
  verify(): VerifyResult {
    const all = this.rows();
    const chain = checkChain(all);
    if (!chain.ok) return chain;
    const head = this.storage.kv.get<StoredHead>(HEAD_KEY);
    const last = all.at(-1);
    const bad = (badSeq: number | null, problem: string): VerifyResult => ({
      ok: false,
      rowsChecked: chain.rowsChecked,
      badSeq,
      problem,
    });
    if (!head) {
      return last ? bad(null, "the stored head is missing, so deleted rows cannot be ruled out") : chain;
    }
    if (!last || last.seq < head.seq) {
      return bad(head.seq, `rows were deleted: row ${head.seq}, the newest on record, is gone`);
    }
    if (last.seq !== head.seq || last.hash !== head.hash) {
      return bad(Math.min(last.seq, head.seq + 1), "the newest row does not match the stored head");
    }
    return chain;
  }

  private lastRow(): { seq: number; hash: string } | undefined {
    return this.storage.sql
      .exec<{ seq: number; hash: string }>("SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1")
      .toArray()[0];
  }

  /** Refuse to extend a log whose newest row is not the one the stored head names. */
  private checkHead(last: { seq: number; hash: string } | undefined): void {
    const head = this.storage.kv.get<StoredHead>(HEAD_KEY);
    if (!head && !last) return;
    if (!head) throw new AuditTamperedError("the audit log has rows but its stored head is missing");
    if (!last || last.seq !== head.seq || last.hash !== head.hash) {
      throw new AuditTamperedError(`the audit log does not end at row ${head.seq}, which the stored head names`);
    }
  }
}
