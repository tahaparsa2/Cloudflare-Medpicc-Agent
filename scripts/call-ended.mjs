// Sends the simulated "call ended" event to the agent Worker running locally.
//
//   npm run dev                      (in another terminal)
//   npm run call -- call-1
//   AGENT_URL=http://localhost:8787 npm run call -- call-2

import { readFileSync } from "node:fs";

const transcriptId = process.argv[2] ?? "call-1";
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

let response;
try {
  response = await fetch(`${base}/calls`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ opportunityId, transcriptId }),
  });
} catch (error) {
  console.error(`Could not reach ${base}. Is \`npm run dev\` running? (${error.message})`);
  process.exit(1);
}

const body = await response.json();
if (!response.ok) {
  console.error(`The agent answered ${response.status}: ${body.error}`);
  process.exit(1);
}
console.log(`Call ended: ${transcriptId} on opportunity ${opportunityId}`);
console.log(`  proposed (${body.proposed.length}): ${body.proposed.join(", ") || "nothing"}`);
console.log(`  dropped by the checks: ${body.dropped}`);
console.log(`  ask on the next call (${body.askNext.length}): ${body.askNext.join(", ") || "nothing"}`);
for (const item of body.notWritable ?? []) {
  console.log(`  not writable by the agent: ${item.field} ${item.outcome} by the gatekeeper (${item.reason})`);
}
console.log(`\nReview: ${body.reviewUrl}`);
console.log(`Audit:  ${new URL(`/audit?opportunity=${opportunityId}`, base).href}`);
