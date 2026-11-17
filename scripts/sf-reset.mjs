// Blanks the eight MEDDPICC fields on the seeded opportunity, so a demo run
// starts from empty. Uses your Salesforce CLI sign-in, not the gatekeeper.
//
//   npm run sf:reset

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const FIELDS = [
  "Metrics__c",
  "Economic_Buyer__c",
  "Decision_Criteria__c",
  "Decision_Process__c",
  "Paper_Process__c",
  "Identified_Pain__c",
  "Champion__c",
  "Competition__c",
];

let seed;
try {
  seed = JSON.parse(readFileSync(new URL("../.seed.local.json", import.meta.url), "utf8"));
} catch {
  console.error("No .seed.local.json. Run: npm run sf:seed");
  process.exit(1);
}
// OPPORTUNITY_ID points the reset at another opportunity, as it does for `npm run call`.
if (process.env.OPPORTUNITY_ID) seed.opportunityId = process.env.OPPORTUNITY_ID;
if (!/^006[A-Za-z0-9]{12,15}$/.test(seed.opportunityId ?? "")) {
  console.error(".seed.local.json holds no opportunity id. Run: npm run sf:seed");
  process.exit(1);
}

const org = process.env.SF_ORG ?? seed.org ?? "meddpicc";
const body = JSON.stringify(Object.fromEntries(FIELDS.map((field) => [field, null])));

execFileSync(
  "npx",
  ["sf", "api", "request", "rest", `/services/data/v68.0/sobjects/Opportunity/${seed.opportunityId}`, "-X", "PATCH", "-H", "Content-Type:application/json", "-b", body, "-o", org],
  { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, SF_DISABLE_TELEMETRY: "true" } },
);
console.log(`Blanked ${FIELDS.length} MEDDPICC fields on opportunity ${seed.opportunityId}`);
