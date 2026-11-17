/**
 * The MCP server: four tools for an MCP client such as Claude Code. Built with
 * `createMcpHandler` from the Agents SDK, which serves Streamable HTTP and
 * builds a fresh server for each request, so there is no session to keep.
 *
 * What each tool does is in mcp-tools.ts. None of them can approve.
 */

import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { draftMeddpiccUpdate, getOpportunity, getProposalStatus, requestFieldUpdate, type McpDeps, type ToolResult } from "./mcp-tools";

export const MCP_ROUTE = "/mcp";

const opportunityId = z.string().describe("Salesforce Opportunity id, 15 or 18 characters, starting 006");

/** A tool's answer as MCP content: the result as JSON text, flagged as an error when it is one. */
function reply(result: ToolResult) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], isError: !result.ok };
}

export function createServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: "meddpicc-agent", version: "0.1.0" });

  server.registerTool(
    "get_opportunity",
    {
      description: "Read an opportunity's MEDDPICC and forecast fields from Salesforce, through the gatekeeper. Read-only. The read is recorded in the audit log.",
      inputSchema: z.object({ opportunity_id: opportunityId }),
    },
    async (input) => reply(await getOpportunity(deps, input)),
  );

  server.registerTool(
    "draft_meddpicc_update",
    {
      description:
        "Draft proposed MEDDPICC values from a call transcript, each with the lines from the call that support it. Writes nothing to Salesforce. Returns the proposal and the review link where a signed-in person approves, edits or rejects each field. Replaces the opportunity's current proposal.",
      inputSchema: z.object({
        opportunity_id: opportunityId,
        transcript_id: z.string().describe(`Which call ended. One of: ${deps.transcripts.join(", ")}`),
      }),
    },
    async (input) => reply(await draftMeddpiccUpdate(deps, input)),
  );

  server.registerTool(
    "get_proposal_status",
    {
      description: "Report where the opportunity's current proposal stands: each field's decision, who made it, and whether the gatekeeper wrote it. Read-only.",
      inputSchema: z.object({ opportunity_id: opportunityId }),
    },
    async (input) => reply(await getProposalStatus(deps, input)),
  );

  server.registerTool(
    "request_field_update",
    {
      description:
        "Ask the gatekeeper to set one field on the opportunity. The gatekeeper decides from its policy file and returns its answer and reason. A request made here has no person's approval behind it, so expect a refusal: forecast fields such as CloseDate need a manager, and MEDDPICC fields need a rep's approval on the review page. The request and the answer are recorded in the audit log.",
      inputSchema: z.object({
        opportunity_id: opportunityId,
        field: z.string().describe("Salesforce field API name, for example CloseDate or Champion__c"),
        value: z.string().describe("The value asked for"),
      }),
    },
    async (input) => reply(await requestFieldUpdate(deps, input)),
  );

  return server;
}

/** Handle one MCP request. */
export function handleMcp(request: Request, env: unknown, ctx: ExecutionContext, deps: McpDeps): Response | Promise<Response> {
  return createMcpHandler(() => createServer(deps), { route: MCP_ROUTE })(request, env, ctx);
}
