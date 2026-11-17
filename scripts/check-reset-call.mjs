// Checks that a reset followed by call 1 works, twice in a row, against the
// dev server and the real Salesforce org. Run it after anything that touches
// Salesforce setup (the permission set, the integration user, the app's Run As
// user), and before a rehearsal.
//
//   npm run dev:replay       (in another terminal)
//   npm run check:reset
//
// Each round blanks the eight MEDDPICC fields, sends the call-1 event, and
// expects a proposal: the gatekeeper could sign in, read the opportunity and
// its account, and found the fields empty. It writes nothing to Salesforce
// beyond the blanking, but it replaces the proposal on the review page, and
// against `npm run dev` it makes two live model calls.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROUNDS = 2;
const base = process.env.AGENT_URL ?? "http://localhost:8787";

let opportunityId = process.env.OPPORTUNITY_ID;
if (!opportunityId) {
  try {
    opportunityId = JSON.parse(readFileSync(new URL("../.seed.local.json", import.meta.url), "utf8")).opportunityId;
  } catch {
    console.error("No opportunity id. Run `npm run sf:seed` first, or set OPPORTUNITY_ID.");
    process.exit(1);
  }
}

const fail = (round, message) => {
  console.error(`\nFAIL in round ${round}: ${message}`);
  process.exit(1);
};

for (let round = 1; round <= ROUNDS; round += 1) {
  console.log(`\nRound ${round} of ${ROUNDS}`);
  try {
    execFileSync("node", [fileURLToPath(new URL("./sf-reset.mjs", import.meta.url))], { stdio: "inherit" });
  } catch {
    fail(round, "the reset did not run");
  }

  let response;
  try {
    response = await fetch(`${base}/calls`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ opportunityId, transcriptId: "call-1" }),
    });
  } catch (error) {
    fail(round, `could not reach ${base}. Is the dev server running? (${error.message})`);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) fail(round, `the agent answered ${response.status}: ${body.error ?? "no reason given"}`);
  if (!Array.isArray(body.proposed) || body.proposed.length === 0) {
    fail(round, `the call produced no proposals (dropped by the checks: ${body.dropped}). After a reset every field is empty, so call 1 should propose several.`);
  }
  console.log(`  call-1 drafted: ${body.proposed.length} fields proposed, ${body.dropped} dropped, ${body.askNext.length} to ask next call`);
}

console.log(`\nPASS: reset then call 1 worked ${ROUNDS} times in a row.`);
