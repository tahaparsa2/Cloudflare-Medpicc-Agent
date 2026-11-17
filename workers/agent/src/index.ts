import { getAgentByName } from "agents";
import type { PersonEvidence } from "../../gatekeeper/src/types";
import { TRANSCRIPTS } from "./bundled";
import { MCP_ROUTE, handleMcp } from "./mcp";
import type { AgentReply } from "./opportunity-agent";

export { OpportunityAgent } from "./opportunity-agent";

const OPPORTUNITY_ID = /^006[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/;

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

const reply = (result: AgentReply, okStatus = 200): Response =>
  result.ok ? json(result.state, okStatus) : json({ error: result.reason }, result.status);

/**
 * The proof of who is acting, as it arrived. Behind Cloudflare Access every
 * request carries a signed token naming the person. Without one, the request
 * is offered as the local dev identity, which only a gatekeeper started with
 * DEV_IDENTITY in its .dev.vars accepts. Either way this Worker decides
 * nothing: the gatekeeper checks the proof.
 */
function personFrom(request: Request): PersonEvidence {
  const token = request.headers.get("cf-access-jwt-assertion");
  return token ? { kind: "access_jwt", token } : { kind: "dev" };
}

async function body(request: Request): Promise<Record<string, unknown> | null> {
  // Requiring JSON means another site cannot post here with a plain form.
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return null;
  try {
    const parsed: unknown = await request.json();
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Worker A: the agent and the review page.
 *
 * Agent instances are addressed from this handler by opportunity id. The
 * Agents SDK's own request router is deliberately not mounted, so an agent's
 * methods are never reachable straight from a browser or an MCP client.
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { method } = request;
    const path = url.pathname;

    // Nothing is served to a caller the gatekeeper cannot name: not a page,
    // not a stylesheet. Deployed, that means a verified Cloudflare Access
    // token. If Access were ever switched off, every request would stop here.
    const person = personFrom(request);
    const who = await env.GATEKEEPER_SALESFORCE.whoIs(person);
    if (!who.ok) return json({ error: `Not signed in: ${who.reason}` }, 403);

    if (method === "GET" && path === "/health") {
      return json({ worker: "meddpicc-agent", ok: true, model: env.MODEL_ID, modelMode: env.MODEL_MODE, signedInAs: who.label });
    }

    // The MCP server. In this demo it is served only where the local dev
    // identity is in force. A deployed Worker has no dev identity, so it has
    // no MCP route: an MCP client cannot sign in through Cloudflare Access as a
    // person, and nothing unauthenticated is exposed.
    if (path === MCP_ROUTE) {
      if (who.kind !== "dev") return json({ error: "The MCP server is not exposed on the deployed Worker in this demo" }, 404);
      return handleMcp(request, env, ctx, {
        gatekeeper: env.GATEKEEPER_SALESFORCE,
        agentFor: (opportunityId) => getAgentByName(env.OpportunityAgent, opportunityId),
        reviewUrl: (opportunityId) => new URL(`/review/${opportunityId}`, url).href,
        transcripts: Object.keys(TRANSCRIPTS),
      });
    }

    // The simulated "call ended" event.
    if (path === "/calls") {
      if (method !== "POST") return json({ error: "POST a call-ended event here" }, 405);
      const event = await body(request);
      const opportunityId = event?.opportunityId;
      const transcriptId = event?.transcriptId;
      if (typeof opportunityId !== "string" || !OPPORTUNITY_ID.test(opportunityId) || typeof transcriptId !== "string") {
        return json({ error: 'send JSON: { "opportunityId": "006...", "transcriptId": "call-1" }' }, 400);
      }
      const agent = await getAgentByName(env.OpportunityAgent, opportunityId);
      const result = await agent.draft(transcriptId);
      if (!result.ok) return json({ error: result.reason }, result.status);
      const proposal = result.state.proposal!;
      return json(
        {
          proposalId: proposal.id,
          reviewUrl: new URL(`/review/${opportunityId}`, url).href,
          proposed: proposal.fields.map((f) => f.field),
          dropped: proposal.dropped.length,
          askNext: proposal.askNext.map((f) => f.field),
          notWritable: (proposal.notWritable ?? []).map((f) => ({ field: f.field, outcome: f.outcome, reason: f.reason })),
        },
        201,
      );
    }

    // The audit log, read through the gatekeeper. The audit page itself is a
    // static file at /audit. Nothing here can change a row.
    if (method === "GET" && path === "/api/audit") {
      const opportunityId = url.searchParams.get("opportunity") ?? undefined;
      if (opportunityId !== undefined && !OPPORTUNITY_ID.test(opportunityId)) return json({ error: "Not found" }, 404);
      return json({ opportunityId: opportunityId ?? null, rows: await env.GATEKEEPER_SALESFORCE.listAudit({ opportunityId, limit: 500 }) });
    }
    // Recompute the whole chain: intact, or the first broken row.
    if (method === "GET" && path === "/audit/verify") {
      return json(await env.GATEKEEPER_SALESFORCE.verifyAudit());
    }

    // The review page: one static page, which reads the opportunity id from its own address.
    const review = /^\/review\/([A-Za-z0-9]+)$/.exec(path);
    if (method === "GET" && review) {
      if (!OPPORTUNITY_ID.test(review[1]!)) return json({ error: "Not found" }, 404);
      return env.ASSETS.fetch(new Request(new URL("/review", url), { headers: request.headers }));
    }

    const api = /^\/api\/opportunities\/([A-Za-z0-9]+)(\/decisions|\/apply)?$/.exec(path);
    if (api) {
      const [, opportunityId, action] = api;
      if (!OPPORTUNITY_ID.test(opportunityId!)) return json({ error: "Not found" }, 404);
      const agent = await getAgentByName(env.OpportunityAgent, opportunityId!);

      if (!action && method === "GET") {
        const state = await agent.view();
        return json({ opportunityId, ...state, identity: who.kind, signedInAs: who.label, transcripts: Object.keys(TRANSCRIPTS) });
      }
      if (action === "/decisions" && method === "POST") {
        const input = await body(request);
        if (!input || typeof input.field !== "string" || typeof input.decision !== "string") {
          return json({ error: 'send JSON: { "field": "...", "decision": "approve" | "edit" | "reject", "value": "..." }' }, 400);
        }
        return reply(
          await agent.decide({
            field: input.field,
            decision: input.decision as "approve" | "edit" | "reject",
            value: typeof input.value === "string" ? input.value : null,
            approver: person,
          }),
        );
      }
      if (action === "/apply" && method === "POST") {
        if (!(await body(request))) return json({ error: "send JSON: {}" }, 400);
        return reply(await agent.apply(person));
      }
      return json({ error: "Method not allowed" }, 405);
    }

    // Everything else is a static file: the audit page, the scripts, the stylesheet.
    if (method === "GET" || method === "HEAD") return env.ASSETS.fetch(request);
    return json({ error: "Not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
