// Sets up a dedicated integration user for the gatekeeper, and points the
// External Client App's client credentials flow at it. Uses your Salesforce
// CLI sign-in. Safe to run twice. It never touches the consumer key or secret.
//
//   npm run sf:integration-user              create the user if needed, then run the app as it
//   npm run sf:integration-user -- --revert  run the app as your own (admin) user again
//
// The user gets the Salesforce Integration licence, the API-only profile, the
// Salesforce API Integration permission set licence, and the
// MEDDPICC_Gatekeeper permission set. Nothing else.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const org = process.env.SF_ORG ?? "meddpicc";
const revert = process.argv.includes("--revert");
const APP = "Medpicc_Gatekeeper";
const ALIAS = "mgate";
const PROFILE = "Minimum Access - API Only Integrations";
const PSL = "SalesforceAPIIntegrationPsl";
const PERMISSION_SET = "MEDDPICC_Gatekeeper";

function sf(args) {
  const out = execFileSync("npx", ["sf", ...args, "-o", org, "--json"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, SF_DISABLE_TELEMETRY: "true" },
    maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(out.toString()).result;
}

/**
 * POST a record through the REST API. `sf api request rest` prints Salesforce's
 * own answer: `{ id, success }`, or a list of `{ message, errorCode }`.
 */
function create(sobject, values) {
  let text;
  try {
    text = execFileSync(
      "npx",
      ["sf", "api", "request", "rest", `/services/data/v68.0/sobjects/${sobject}`, "-X", "POST", "-H", "Content-Type:application/json", "-b", JSON.stringify(values), "-o", org],
      { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, SF_DISABLE_TELEMETRY: "true" } },
    ).toString();
  } catch (error) {
    text = `${error.stdout ?? ""}`;
  }
  let answer;
  try {
    answer = JSON.parse(text);
  } catch {
    return { ok: false, message: "Salesforce gave no readable answer" };
  }
  if (answer?.success && answer.id) return { ok: true, id: answer.id };
  const first = Array.isArray(answer) ? answer[0] : answer;
  return { ok: false, message: `${first?.errorCode ?? "error"}: ${first?.message ?? "no message"}` };
}

const query = (soql) => sf(["data", "query", "-q", soql]).records;
const one = (soql, what) => {
  const [record] = query(soql);
  if (!record) throw new Error(`Not found in the org: ${what}`);
  return record;
};

/** Point the app's client credentials flow at a username, by deploying its OAuth policy file. */
function runAppAs(username) {
  // The file names a username, so it is written to a git-ignored folder.
  const dir = fileURLToPath(new URL("../salesforce/main/default/extlClntAppOauthPolicies/", import.meta.url));
  mkdirSync(dir, { recursive: true });
  const name = `${APP}_oauthPlcy`;
  writeFileSync(
    `${dir}${name}.ecaOauthPlcy-meta.xml`,
    `<?xml version="1.0" encoding="UTF-8"?>
<ExtlClntAppOauthConfigurablePolicies xmlns="http://soap.sforce.com/2006/04/metadata">
    <clientCredentialsFlowUser>${username}</clientCredentialsFlowUser>
    <externalClientApplication>${APP}</externalClientApplication>
    <ipRelaxationPolicyType>Enforce</ipRelaxationPolicyType>
    <isClientCredentialsFlowEnabled>true</isClientCredentialsFlowEnabled>
    <isGuestCodeCredFlowEnabled>false</isGuestCodeCredFlowEnabled>
    <isTokenExchangeFlowEnabled>false</isTokenExchangeFlowEnabled>
    <label>${name}</label>
    <permittedUsersPolicyType>AllSelfAuthorized</permittedUsersPolicyType>
    <refreshTokenPolicyType>SpecificInactivity</refreshTokenPolicyType>
    <refreshTokenValidityPeriod>30</refreshTokenValidityPeriod>
    <refreshTokenValidityUnit>Days</refreshTokenValidityUnit>
    <requiredSessionLevel>STANDARD</requiredSessionLevel>
</ExtlClntAppOauthConfigurablePolicies>
`,
  );
  sf(["project", "deploy", "start", "-m", `ExtlClntAppOauthConfigurablePolicies:${name}`]);
}

// The user the CLI is signed in as: the admin, and the model for the new user's locale settings.
const cliUsername = sf(["org", "display"]).username;
const admin = one(
  `SELECT Id, Username, Email, TimeZoneSidKey, LocaleSidKey, EmailEncodingKey, LanguageLocaleKey FROM User WHERE Username = '${cliUsername}'`,
  "the user the Salesforce CLI is signed in as",
);

if (revert) {
  runAppAs(admin.Username);
  console.log("The External Client App now runs as your own user again.");
  console.log("Restart `npm run dev` so the gatekeeper fetches a new token.");
  process.exit(0);
}

let [user] = query(`SELECT Id, Username, IsActive FROM User WHERE Alias = '${ALIAS}'`);
if (!user) {
  const profile = one(`SELECT Id FROM Profile WHERE Name = '${PROFILE}'`, `the profile "${PROFILE}"`);
  const orgId = one("SELECT Id FROM Organization", "the organization").Id.toLowerCase();
  // A username only has to look like an email address and be unique across Salesforce.
  const username = `meddpicc.gatekeeper.${orgId}@example.com`;
  const values = {
    LastName: "MEDDPICC Gatekeeper",
    Alias: ALIAS,
    Username: username,
    // Salesforce requires a real address. The admin's own is copied inside the org.
    Email: admin.Email,
    ProfileId: profile.Id,
    TimeZoneSidKey: admin.TimeZoneSidKey,
    LocaleSidKey: admin.LocaleSidKey,
    EmailEncodingKey: admin.EmailEncodingKey,
    LanguageLocaleKey: admin.LanguageLocaleKey,
  };
  const created = create("User", values);
  if (!created.ok) throw new Error(`Could not create the integration user: ${created.message}`);
  user = { Id: created.id, Username: username, IsActive: true };
  console.log(`Created the integration user (alias ${ALIAS}).`);
} else {
  console.log(`The integration user (alias ${ALIAS}) already exists.`);
}

function assign(sobject, values, what) {
  const result = create(sobject, values);
  if (result.ok) console.log(`Assigned ${what}.`);
  else if (/duplicate/i.test(result.message)) console.log(`Already assigned: ${what}.`);
  else throw new Error(`Could not assign ${what}: ${result.message}`);
}

const psl = one(`SELECT Id FROM PermissionSetLicense WHERE DeveloperName = '${PSL}'`, `the permission set licence ${PSL}`);
assign("PermissionSetLicenseAssign", { AssigneeId: user.Id, PermissionSetLicenseId: psl.Id }, "the Salesforce API Integration permission set licence");

// Deploy the permission set as the repo has it before the app starts running
// as a user who has nothing else. An older copy in the org is how a read can
// work for an admin and fail for the integration user.
sf(["project", "deploy", "start", "-m", `PermissionSet:${PERMISSION_SET}`]);
console.log(`Deployed the ${PERMISSION_SET} permission set.`);

const permissionSet = one(`SELECT Id FROM PermissionSet WHERE Name = '${PERMISSION_SET}'`, `the permission set ${PERMISSION_SET} (run: npm run sf:deploy)`);
assign("PermissionSetAssignment", { AssigneeId: user.Id, PermissionSetId: permissionSet.Id }, `the ${PERMISSION_SET} permission set`);

runAppAs(user.Username);
console.log("The External Client App now runs as the integration user.");
console.log("Restart `npm run dev` so the gatekeeper fetches a new token, then run: npm run check:reset");
