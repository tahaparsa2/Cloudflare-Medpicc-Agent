import { defineConfig } from "vitest/config";

// The agent's own logic is plain functions, tested in Node with a fake
// gatekeeper and recorded model answers. No model call, no Salesforce.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
