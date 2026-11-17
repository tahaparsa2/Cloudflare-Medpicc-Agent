import type { Caller } from "./types";

export type Identity = { ok: true; label: string; person: boolean } | { ok: false; reason: string };

const AGENT_ID = /^[A-Za-z0-9_.:/-]{1,128}$/;

/**
 * Turn what a caller says about itself into the name the audit log records.
 *
 * An agent names itself and is never a person. A person has to bring proof.
 * This function handles the two callers that need no network: an agent, and
 * the dev identity, which only a gatekeeper started with DEV_IDENTITY in its
 * local .dev.vars accepts. A Cloudflare Access token is verified in access.ts.
 */
export function identifyCaller(caller: Caller | null | undefined, devIdentity: string | undefined): Identity {
  if (caller?.kind === "agent") {
    return typeof caller.id === "string" && AGENT_ID.test(caller.id)
      ? { ok: true, label: `agent:${caller.id}`, person: false }
      : { ok: false, reason: "the agent id is missing or malformed" };
  }
  if (caller?.kind === "dev") {
    const identity = devIdentity?.trim();
    return identity
      ? { ok: true, label: `dev:${identity}`, person: true }
      : { ok: false, reason: "the dev identity is not enabled on this gatekeeper" };
  }
  if (caller?.kind === "access_jwt") {
    return { ok: false, reason: "an Access token has to be verified before it names anyone" };
  }
  return { ok: false, reason: "the caller did not say who it is" };
}
