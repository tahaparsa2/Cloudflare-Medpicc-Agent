import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The live run: the real gatekeeper code in the Workers runtime, against the
// real Salesforce org. Credentials come from workers/gatekeeper/.dev.vars.
// Nothing here overrides them. Run with `npm run m1:live`.

function seededOpportunityId(): string {
  try {
    const path = fileURLToPath(new URL("../../.seed.local.json", import.meta.url).href);
    const seed = JSON.parse(readFileSync(path, "utf8"));
    return String(seed.opportunityId ?? "");
  } catch {
    return "";
  }
}

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: { LIVE_OPPORTUNITY_ID: seededOpportunityId() },
      },
    }),
  ],
  test: {
    include: ["live/**/*.live.ts"],
    testTimeout: 60_000,
  },
});
