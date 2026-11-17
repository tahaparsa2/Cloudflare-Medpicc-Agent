import { defineConfig } from "vitest/config";

// The live check: runs the fixture calls against the real model, in Node, with
// the Workers AI binding reached through your Wrangler sign-in.
//   npm run eval           expected against proposed, per field
//   npm run eval:record    the same, and saves the answers to fixtures/recorded/
export default defineConfig({
  test: {
    include: ["eval/**/*.eval.ts"],
    environment: "node",
    testTimeout: 300_000,
  },
});
