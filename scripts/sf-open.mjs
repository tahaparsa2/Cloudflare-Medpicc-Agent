// Opens the seeded opportunity in Salesforce in your browser, signed in
// through your Salesforce CLI session.
//
//   npm run sf:open

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

let seed;
try {
  seed = JSON.parse(readFileSync(new URL("../.seed.local.json", import.meta.url), "utf8"));
} catch {
  console.error("No .seed.local.json. Run: npm run sf:seed");
  process.exit(1);
}
if (!/^006[A-Za-z0-9]{12,15}$/.test(seed.opportunityId ?? "")) {
  console.error(".seed.local.json holds no opportunity id. Run: npm run sf:seed");
  process.exit(1);
}
const org = process.env.SF_ORG ?? seed.org ?? "meddpicc";
execFileSync("npx", ["sf", "org", "open", "-o", org, "-p", `/lightning/r/Opportunity/${seed.opportunityId}/view`], {
  stdio: ["ignore", "ignore", "inherit"],
  env: { ...process.env, SF_DISABLE_TELEMETRY: "true" },
});
console.log(`Opened opportunity ${seed.opportunityId} in Salesforce`);
