import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Tests run inside the Workers runtime, against real Durable Object SQLite.
// Salesforce is faked: these bindings point at a host that does not exist, and
// they override anything in a local .dev.vars, so a test can never reach the org.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          SF_LOGIN_URL: "https://salesforce.test",
          SF_CONSUMER_KEY: "test-consumer-key",
          SF_CONSUMER_SECRET: "test-consumer-secret",
          DEV_IDENTITY: "rep@example.test",
          TEAM_DOMAIN: "https://test-team.cloudflareaccess.com",
          POLICY_AUD: "a".repeat(64),
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
