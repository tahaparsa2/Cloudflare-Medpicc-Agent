/**
 * Milestone 1, live: one allowed write, one refusal and an intact audit chain,
 * against the real Salesforce org.
 *
 *   npm run m1:live
 *
 * Needs workers/gatekeeper/.dev.vars (see .dev.vars.example) and a seeded org
 * (npm run sf:seed). It writes one MEDDPICC field on the seeded opportunity.
 * `npm run sf:reset` blanks the fields again.
 */

import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import type { AuditRow, Caller } from "../src/types";

const AGENT: Caller = { kind: "agent", id: "m1-live-script" };
const FIELD = "Champion__c";

it("milestone 1: an allowed write, a refusal and an intact chain", async () => {
  const live = env as typeof env & { LIVE_OPPORTUNITY_ID: string };
  const opportunityId = live.LIVE_OPPORTUNITY_ID;
  const missing = [
    !opportunityId && "a seeded opportunity (run: npm run sf:seed)",
    !env.SF_LOGIN_URL && "SF_LOGIN_URL in workers/gatekeeper/.dev.vars",
    !env.SF_CONSUMER_KEY && "SF_CONSUMER_KEY in workers/gatekeeper/.dev.vars",
    !env.SF_CONSUMER_SECRET && "SF_CONSUMER_SECRET in workers/gatekeeper/.dev.vars",
    !env.DEV_IDENTITY && "DEV_IDENTITY in workers/gatekeeper/.dev.vars",
  ].filter(Boolean);
  if (missing.length > 0) throw new Error(`Not ready for the live run. Missing: ${missing.join("; ")}`);

  const out: string[] = [];
  const say = (line = "") => out.push(line);
  const gatekeeper = env.GATEKEEPER.getByName(`m1-live-${crypto.randomUUID()}`);

  try {
    say(`Opportunity ${opportunityId} at ${new URL(env.SF_LOGIN_URL).host}`);

    // 1. Read through the gatekeeper.
    const read = await gatekeeper.readOpportunity({ opportunityId, actor: AGENT });
    if (!read.ok) throw new Error(`read failed: ${read.reason}`);
    say();
    say(`1. READ      ${read.fields.Name} (${read.fields["Account.Name"]})`);
    say(`             stage ${read.fields.StageName}, close date ${read.fields.CloseDate}`);
    say(`             ${FIELD} is ${JSON.stringify(read.fields[FIELD])}`);

    // 2. A person approves a value. Here the local dev identity stands in for the rep.
    const value = `Priya Raman, VP Operations (m1 live run ${new Date().toISOString()})`;
    const approval = await gatekeeper.recordDecision({
      opportunityId,
      proposalId: "m1-live",
      field: FIELD,
      decision: "approve",
      value,
      approver: { kind: "dev" },
    });
    if (!approval.ok) throw new Error(`approval failed: ${approval.reason}`);
    say();
    say(`2. APPROVE   ${FIELD} approved by ${approval.approver}`);

    // 3. The allowed write.
    const [written] = await gatekeeper.applyApprovedUpdate({
      opportunityId,
      proposalId: "m1-live",
      snapshotId: read.snapshotId,
      fields: [{ field: FIELD, value }],
      actor: AGENT,
    });
    say();
    say(`3. WRITE     ${written!.outcome}: ${written!.reason} [${written!.rule}]`);
    expect(written).toMatchObject({ outcome: "written" });

    const after = await gatekeeper.readOpportunity({ opportunityId, actor: AGENT });
    if (!after.ok) throw new Error(`read-back failed: ${after.reason}`);
    say(`             Salesforce now holds: ${JSON.stringify(after.fields[FIELD])}`);
    expect(after.fields[FIELD]).toBe(value);

    // 4. The refusal: an agent asks to move the close date.
    const refused = await gatekeeper.requestFieldUpdate({ opportunityId, field: "CloseDate", value: "2027-01-15", actor: AGENT });
    say();
    say(`4. REFUSE    CloseDate -> 2027-01-15: ${refused.outcome}`);
    say(`             ${refused.reason} [${refused.rule}]`);
    expect(refused).toMatchObject({ outcome: "refused", code: "needs_manager_approval" });
    expect(after.fields.CloseDate).toBe(read.fields.CloseDate);

    // 5. The audit log and its chain.
    const rows: AuditRow[] = await gatekeeper.listAudit();
    say();
    say("5. AUDIT LOG");
    for (const row of rows) {
      const what = [row.action, row.outcome, row.field].filter(Boolean).join(" ");
      say(`   #${row.seq}  ${what.padEnd(28)} ${row.actor.padEnd(28)} ${row.hash.slice(0, 12)}`);
    }
    const verdict = await gatekeeper.verifyAudit();
    say();
    say(`   verify: ${verdict.ok ? `intact, ${verdict.rowsChecked} rows` : `BROKEN at row ${verdict.badSeq}: ${verdict.problem}`}`);
    expect(verdict.ok).toBe(true);
    expect(rows.some((r) => r.action === "write" && r.outcome === "applied")).toBe(true);
    expect(rows.some((r) => r.action === "refuse" && r.field === "CloseDate")).toBe(true);
    say();
    say("To blank the MEDDPICC fields again: npm run sf:reset");
  } finally {
    console.log(`\n${out.join("\n")}\n`);
  }
});
