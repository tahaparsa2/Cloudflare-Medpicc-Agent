import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  AuditLog,
  AuditTamperedError,
  GENESIS_HASH,
  HASHED_COLUMNS,
  checkChain,
  rowHash,
  type AuditEntry,
  type AuditRow,
} from "../src/audit";
import { canonical, sha256Hex } from "../src/canonical";

const entry = (n: number, extra: Partial<AuditEntry> = {}): AuditEntry => ({
  actor: "agent:test",
  action: "refuse",
  outcome: "refused",
  opportunityId: "006000000000001AAA",
  field: "CloseDate",
  valueAfter: `value ${n}`,
  reason: "needs manager approval",
  ...extra,
});

/** A valid chain built by hand, with no database. */
function chain(length: number): AuditRow[] {
  const rows: AuditRow[] = [];
  for (let seq = 1; seq <= length; seq += 1) {
    const body: Omit<AuditRow, "hash"> = {
      seq,
      time: `2026-11-14T00:00:0${seq}.000Z`,
      actor: "agent:test",
      action: "refuse",
      opportunity_id: "006000000000001AAA",
      field: "CloseDate",
      value_before: null,
      value_after: `value ${seq}`,
      proposal_id: null,
      transcript_hash: null,
      model_id: null,
      context_hash: null,
      policy_hash: "p".repeat(64),
      outcome: "refused",
      reason: "needs manager approval",
      detail: null,
      prev_hash: rows.at(-1)?.hash ?? GENESIS_HASH,
    };
    rows.push({ ...body, hash: rowHash(body) });
  }
  return rows;
}

/** A fresh Durable Object, and an AuditLog over its storage, per test. */
async function withLog<T>(run: (log: AuditLog, storage: DurableObjectStorage) => T | Promise<T>): Promise<T> {
  const stub = env.GATEKEEPER.getByName(`audit-${crypto.randomUUID()}`);
  return runInDurableObject(stub, (_instance, state) => run(new AuditLog(state.storage), state.storage));
}

describe("canonical", () => {
  it("sorts keys at every depth and writes compact JSON", () => {
    expect(canonical({ b: 1, a: { d: [{ z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[{"y":2,"z":1}]},"b":1}');
  });

  it("refuses NaN and Infinity", () => {
    expect(() => canonical({ n: Number.NaN })).toThrow();
    expect(() => canonical({ n: Number.POSITIVE_INFINITY })).toThrow();
  });

  it("hashes with SHA-256", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("checkChain", () => {
  it("accepts an empty log and an intact chain", () => {
    expect(checkChain([])).toEqual({ ok: true, rowsChecked: 0, badSeq: null, problem: null });
    expect(checkChain(chain(4))).toEqual({ ok: true, rowsChecked: 4, badSeq: null, problem: null });
  });

  it("starts the chain at the genesis hash", () => {
    expect(chain(1)[0]!.prev_hash).toBe("0".repeat(64));
  });

  it.each(HASHED_COLUMNS.filter((column) => column !== "seq" && column !== "prev_hash"))(
    "catches a change to %s",
    (column) => {
      const rows = chain(3);
      (rows[1] as Record<string, unknown>)[column] = "changed";
      expect(checkChain(rows)).toMatchObject({ ok: false, badSeq: 2, problem: "row content does not match its hash" });
    },
  );

  it("catches a row edited and re-hashed, at the row after it", () => {
    const rows = chain(3);
    const { hash: _old, ...body } = { ...rows[1]!, value_after: "forged" };
    rows[1] = { ...body, hash: rowHash(body) };
    expect(checkChain(rows)).toMatchObject({ ok: false, badSeq: 3, problem: "previous-row hash does not match" });
  });

  it("catches a deleted row", () => {
    const rows = chain(4);
    rows.splice(1, 1);
    expect(checkChain(rows)).toMatchObject({ ok: false, badSeq: 3, problem: "expected row 2, found row 3" });
  });

  it("catches a deleted first row", () => {
    expect(checkChain(chain(3).slice(1))).toMatchObject({ ok: false, badSeq: 2 });
  });

  it("catches reordered rows", () => {
    const rows = chain(3);
    [rows[1], rows[2]] = [rows[2]!, rows[1]!];
    expect(checkChain(rows)).toMatchObject({ ok: false, badSeq: 3 });
  });

  it("cannot see rows deleted from the end, which is why the stored head exists", () => {
    expect(checkChain(chain(4).slice(0, 2)).ok).toBe(true);
  });
});

describe("AuditLog in a Durable Object", () => {
  it("appends rows that link to each other and verify", async () => {
    await withLog((log) => {
      expect(log.verify()).toEqual({ ok: true, rowsChecked: 0, badSeq: null, problem: null });
      const first = log.append(entry(1));
      const second = log.append(entry(2));
      expect(first.seq).toBe(1);
      expect(first.prev_hash).toBe(GENESIS_HASH);
      expect(second.seq).toBe(2);
      expect(second.prev_hash).toBe(first.hash);
      expect(second.hash).toBe(rowHash(second));
      expect(log.verify()).toEqual({ ok: true, rowsChecked: 2, badSeq: null, problem: null });
    });
  });

  it("stores every column, and detail as canonical JSON", async () => {
    await withLog((log) => {
      log.append({
        actor: "dev:rep@example.test",
        action: "write",
        outcome: "applied",
        opportunityId: "006000000000001AAA",
        field: "Champion__c",
        valueBefore: null,
        valueAfter: "Priya Raman",
        proposalId: "p1",
        transcriptHash: "t".repeat(64),
        modelId: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        contextHash: "c".repeat(64),
        policyHash: "p".repeat(64),
        reason: "approved",
        detail: { rule: "rules.rep_approval", approved_by: "dev:rep@example.test" },
      });
      const [row] = log.rows();
      expect(row).toMatchObject({
        seq: 1,
        actor: "dev:rep@example.test",
        action: "write",
        outcome: "applied",
        opportunity_id: "006000000000001AAA",
        field: "Champion__c",
        value_before: null,
        value_after: "Priya Raman",
        proposal_id: "p1",
        transcript_hash: "t".repeat(64),
        model_id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        context_hash: "c".repeat(64),
        policy_hash: "p".repeat(64),
        reason: "approved",
        detail: '{"approved_by":"dev:rep@example.test","rule":"rules.rep_approval"}',
      });
      expect(row!.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });
  });

  it("filters by opportunity and returns the newest rows, oldest first", async () => {
    await withLog((log) => {
      for (let n = 1; n <= 5; n += 1) {
        log.append(entry(n, { opportunityId: n % 2 ? "006000000000001AAA" : "006000000000002AAA" }));
      }
      expect(log.rows({ opportunityId: "006000000000002AAA" }).map((r) => r.seq)).toEqual([2, 4]);
      expect(log.rows({ limit: 2 }).map((r) => r.seq)).toEqual([4, 5]);
      expect(log.rows({ opportunityId: "006000000000001AAA", limit: 2 }).map((r) => r.seq)).toEqual([3, 5]);
    });
  });

  it("refuses UPDATE and DELETE on the table", async () => {
    await withLog((log, storage) => {
      log.append(entry(1));
      expect(() => storage.sql.exec("UPDATE audit_log SET reason = 'changed' WHERE seq = 1")).toThrow(/append-only/);
      expect(() => storage.sql.exec("DELETE FROM audit_log WHERE seq = 1")).toThrow(/append-only/);
      expect(log.rows()[0]!.reason).toBe("needs manager approval");
      expect(log.verify().ok).toBe(true);
    });
  });

  it("reports the first broken row when a row is edited behind the triggers", async () => {
    await withLog((log, storage) => {
      for (let n = 1; n <= 4; n += 1) log.append(entry(n));
      storage.sql.exec("DROP TRIGGER audit_log_no_update");
      storage.sql.exec("UPDATE audit_log SET value_after = 'forged' WHERE seq = 2");
      expect(log.verify()).toEqual({
        ok: false,
        rowsChecked: 2,
        badSeq: 2,
        problem: "row content does not match its hash",
      });
    });
  });

  it("reports a row deleted from the middle", async () => {
    await withLog((log, storage) => {
      for (let n = 1; n <= 4; n += 1) log.append(entry(n));
      storage.sql.exec("DROP TRIGGER audit_log_no_delete");
      storage.sql.exec("DELETE FROM audit_log WHERE seq = 2");
      expect(log.verify()).toMatchObject({ ok: false, badSeq: 3, problem: "expected row 2, found row 3" });
    });
  });

  it("reports rows deleted from the end, and refuses to append over the gap", async () => {
    await withLog((log, storage) => {
      for (let n = 1; n <= 4; n += 1) log.append(entry(n));
      storage.sql.exec("DROP TRIGGER audit_log_no_delete");
      storage.sql.exec("DELETE FROM audit_log WHERE seq >= 3");
      expect(log.verify()).toMatchObject({ ok: false, badSeq: 4 });
      expect(log.verify().problem).toMatch(/rows were deleted/);
      expect(() => log.append(entry(5))).toThrow(AuditTamperedError);
      expect(log.rows().map((r) => r.seq)).toEqual([1, 2]);
    });
  });

  it("reports a log that was emptied", async () => {
    await withLog((log, storage) => {
      log.append(entry(1));
      storage.sql.exec("DROP TRIGGER audit_log_no_delete");
      storage.sql.exec("DELETE FROM audit_log");
      expect(log.verify()).toMatchObject({ ok: false, badSeq: 1 });
      expect(() => log.append(entry(2))).toThrow(AuditTamperedError);
    });
  });

  it("reports a row inserted behind the log's back", async () => {
    await withLog((log, storage) => {
      const first = log.append(entry(1));
      const { hash: _hash, ...body } = { ...first, seq: 2, prev_hash: first.hash, value_after: "slipped in" };
      const forged: AuditRow = { ...body, hash: rowHash(body) };
      const columns = [...HASHED_COLUMNS, "hash"] as const;
      storage.sql.exec(
        `INSERT INTO audit_log (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
        ...columns.map((column) => forged[column]),
      );
      // The chain itself is valid, so only the stored head can tell.
      expect(checkChain(log.rows()).ok).toBe(true);
      expect(log.verify()).toMatchObject({ ok: false, badSeq: 2, problem: "the newest row does not match the stored head" });
      expect(() => log.append(entry(3))).toThrow(AuditTamperedError);
    });
  });

  it("keeps the stored head out of reach of SQL", async () => {
    await withLog((log, storage) => {
      log.append(entry(1));
      expect(() => storage.sql.exec("DELETE FROM _cf_KV")).toThrow();
      expect(log.verify().ok).toBe(true);
    });
  });

  it("uses the clock it is given", async () => {
    const stub = env.GATEKEEPER.getByName(`audit-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      const log = new AuditLog(state.storage, () => new Date("2026-11-14T12:00:00.000Z"));
      expect(log.append(entry(1)).time).toBe("2026-11-14T12:00:00.000Z");
    });
  });
});
