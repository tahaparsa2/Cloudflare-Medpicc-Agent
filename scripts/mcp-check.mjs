// Connects to the local MCP server as a real MCP client and checks it:
// exactly the four tools, a read that works, and a close-date request that
// the gatekeeper refuses. Nothing here writes to Salesforce.
//
//   npm run dev:replay       (in another terminal)
//   npm run mcp:check

import { readFileSync } from "node:fs";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const base = process.env.AGENT_URL ?? "http://localhost:8787";
const EXPECTED = ["draft_meddpicc_update", "get_opportunity", "get_proposal_status", "request_field_update"];

let opportunityId = process.env.OPPORTUNITY_ID;
if (!opportunityId) {
  try {
    opportunityId = JSON.parse(readFileSync(new URL("../.seed.local.json", import.meta.url), "utf8")).opportunityId;
  } catch {
    console.error("No opportunity id. Run `npm run sf:seed` first, or set OPPORTUNITY_ID.");
    process.exit(1);
  }
}

const fail = (message) => {
  console.error(`\nFAIL: ${message}`);
  process.exit(1);
};
const parse = (result) => JSON.parse(result.content?.[0]?.text ?? "{}");

const client = new Client({ name: "mcp-check", version: "0.1.0" });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", base)));
} catch (error) {
  fail(`could not connect to ${base}/mcp. Is the dev server running? (${error.message})`);
}

const { tools } = await client.listTools();
const names = tools.map((tool) => tool.name).sort();
console.log(`Tools: ${names.join(", ")}`);
if (JSON.stringify(names) !== JSON.stringify(EXPECTED)) fail(`expected exactly ${EXPECTED.join(", ")}`);
const suspicious = names.filter((name) => /approv|decid|reject|apply|write/.test(name));
if (suspicious.length > 0) fail(`a tool looks able to decide or write: ${suspicious.join(", ")}`);

const read = parse(await client.callTool({ name: "get_opportunity", arguments: { opportunity_id: opportunityId } }));
if (!read.ok) fail(`get_opportunity: ${read.error}`);
console.log(`get_opportunity: ${read.fields.Name}, close date ${read.fields.CloseDate}`);

const status = parse(await client.callTool({ name: "get_proposal_status", arguments: { opportunity_id: opportunityId } }));
if (!status.ok) fail(`get_proposal_status: ${status.error}`);
console.log(`get_proposal_status: ${status.status}`);

const asked = parse(await client.callTool({ name: "request_field_update", arguments: { opportunity_id: opportunityId, field: "CloseDate", value: "2027-01-21" } }));
console.log(`request_field_update CloseDate: ${asked.outcome}. ${asked.reason} (audit row ${asked.audit_row})`);
if (asked.outcome !== "refused" || asked.code !== "needs_manager_approval") fail("the gatekeeper did not refuse the close date");

const after = parse(await client.callTool({ name: "get_opportunity", arguments: { opportunity_id: opportunityId } }));
if (after.fields.CloseDate !== read.fields.CloseDate) fail("the close date changed in Salesforce");
console.log(`Close date in Salesforce is still ${after.fields.CloseDate}`);

await client.close();
console.log("\nPASS: four tools, none can approve, and the close date was refused.");
