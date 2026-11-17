/**
 * Proof of a signed-in person: a Cloudflare Access token.
 *
 * Access sits in front of the agent Worker and adds a signed JWT to every
 * request it lets through. The agent Worker passes that token on, and it is
 * verified here, in the gatekeeper, against Access's public keys. The agent
 * Worker can pass a token on. It cannot make one.
 *
 * Verification follows Cloudflare's "Validate JWTs" guide: the signature
 * against the team's published keys, RS256 only, the issuer (the team domain)
 * and the audience (the Access application's AUD tag).
 */

import { createRemoteJWKSet, customFetch, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Identity } from "./identity";

export interface AccessConfig {
  /** https://<team-name>.cloudflareaccess.com */
  teamDomain: string;
  /** The Access application's AUD tag. */
  audience: string;
}

const TEAM_DOMAIN = /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/;
const AUDIENCE = /^[0-9a-f]{64}$/;
const EMAIL = /^[^\s@:]{1,64}@[^\s@:]{1,255}$/;

export const NOT_CONFIGURED = "Cloudflare Access sign-in is not configured on this gatekeeper";

export type AccessSetup = { ok: true; config: AccessConfig } | { ok: false; reason: string };

/**
 * Both values, or nothing: a half-configured gatekeeper accepts no token. A
 * value that is set but in the wrong shape is named in the reason, without
 * repeating it, so a typo does not look like "not configured".
 */
export function accessSetup(teamDomain: string | undefined, audience: string | undefined): AccessSetup {
  const domain = (teamDomain ?? "").trim().replace(/\/+$/, "");
  const aud = (audience ?? "").trim();
  if (domain === "" && aud === "") return { ok: false, reason: NOT_CONFIGURED };
  const problems = [
    domain === "" ? "TEAM_DOMAIN is not set" : TEAM_DOMAIN.test(domain) ? null : "TEAM_DOMAIN is not in the form https://<team-name>.cloudflareaccess.com",
    aud === "" ? "POLICY_AUD is not set" : AUDIENCE.test(aud) ? null : "POLICY_AUD is not a 64-character AUD tag",
  ].filter(Boolean);
  if (problems.length > 0) return { ok: false, reason: `${NOT_CONFIGURED}: ${problems.join("; ")}` };
  return { ok: true, config: { teamDomain: domain, audience: aud } };
}

export function accessConfig(teamDomain: string | undefined, audience: string | undefined): AccessConfig | null {
  const setup = accessSetup(teamDomain, audience);
  return setup.ok ? setup.config : null;
}

export class AccessVerifier {
  private readonly keys: JWTVerifyGetKey | null;
  private readonly config: AccessConfig | null;
  private readonly problem: string;

  /** `keys` is for tests. Otherwise the team's published keys are fetched, and cached, on first use. */
  constructor(setup: AccessSetup | AccessConfig | null, keys?: JWTVerifyGetKey) {
    const config = setup === null ? null : "teamDomain" in setup ? setup : setup.ok ? setup.config : null;
    this.config = config;
    this.problem = setup !== null && "ok" in setup && !setup.ok ? setup.reason : NOT_CONFIGURED;
    this.keys =
      keys ??
      (config
        ? createRemoteJWKSet(new URL(`${config.teamDomain}/cdn-cgi/access/certs`), {
            // Look `fetch` up at call time, so a test can stand in for the network.
            [customFetch]: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
          })
        : null);
  }

  /** The person a token names, as `user:<email>`, or why the token is refused. */
  async identify(token: unknown): Promise<Identity> {
    if (!this.config || !this.keys) return { ok: false, reason: this.problem };
    if (typeof token !== "string" || token.length === 0 || token.length > 8192) {
      return { ok: false, reason: "the Access token is missing or malformed" };
    }
    let email: unknown;
    try {
      const { payload } = await jwtVerify(token, this.keys, {
        issuer: this.config.teamDomain,
        audience: this.config.audience,
        algorithms: ["RS256"],
      });
      email = payload.email;
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      return { ok: false, reason: `the Access token did not verify (${typeof code === "string" ? code : "error"})` };
    }
    // A service token is a valid Access token that names no person. It cannot approve.
    if (typeof email !== "string" || !EMAIL.test(email)) {
      return { ok: false, reason: "the Access token names no person, so it cannot approve anything" };
    }
    return { ok: true, label: `user:${email.toLowerCase()}`, person: true };
  }
}
