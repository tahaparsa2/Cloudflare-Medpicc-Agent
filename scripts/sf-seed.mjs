// Seeds one synthetic account and one opportunity in the Salesforce org.
// Safe to run again: it reuses records that already exist with the same name.
//
//   npm run sf:seed            (uses the org alias "meddpicc")
//   SF_ORG=other npm run sf:seed
//
// Writes the record ids to .seed.local.json (git-ignored) for the live scripts.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const org = process.env.SF_ORG ?? "meddpicc";
const seed = JSON.parse(readFileSync(new URL("../salesforce/data/seed.json", import.meta.url), "utf8"));

function sf(args) {
  const out = execFileSync("npx", ["sf", ...args, "-o", org, "--json"], {
    encoding: "utf8",
    env: { ...process.env, SF_DISABLE_TELEMETRY: "true" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(out).result;
}

const soqlString = (value) => `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

function findByName(sobject, name) {
  const { records } = sf(["data", "query", "-q", `SELECT Id FROM ${sobject} WHERE Name = ${soqlString(name)} LIMIT 1`]);
  return records[0]?.Id ?? null;
}

function create(sobject, fields) {
  // The CLI takes values as Field='value' pairs.
  const values = Object.entries(fields)
    .map(([key, value]) => `${key}='${String(value).replace(/'/g, "\\'")}'`)
    .join(" ");
  return sf(["data", "create", "record", "-s", sobject, "-v", values]).id;
}

function ensure(sobject, fields) {
  const existing = findByName(sobject, fields.Name);
  if (existing) return { id: existing, created: false };
  return { id: create(sobject, fields), created: true };
}

const account = ensure("Account", seed.account);
const opportunity = ensure("Opportunity", { ...seed.opportunity, AccountId: account.id });

writeFileSync(
  new URL("../.seed.local.json", import.meta.url),
  JSON.stringify({ org, accountId: account.id, opportunityId: opportunity.id }, null, 2) + "\n",
);

const word = (r) => (r.created ? "created" : "already there");
console.log(`Account      ${account.id}  ${word(account)}  ${seed.account.Name}`);
console.log(`Opportunity  ${opportunity.id}  ${word(opportunity)}  ${seed.opportunity.Name}`);
