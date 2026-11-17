// A full reset before a demo run: blank the eight MEDDPICC fields in
// Salesforce, and clear the local Workers' stored state (the agent's proposal
// and the gatekeeper's audit log), so the run starts from an empty page and
// audit row 1.
//
//   npm run demo:reset
//
// The audit log is append-only: nothing in the app can clear it. This removes
// the local development storage it lives in, which is only possible with the
// dev server stopped. It does nothing to a deployed Worker.

import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.DEV_PORT ?? 8787);

const listening = await new Promise((resolve) => {
  const socket = createConnection({ port: PORT, host: "127.0.0.1" });
  socket.once("connect", () => {
    socket.destroy();
    resolve(true);
  });
  socket.once("error", () => resolve(false));
});
if (listening) {
  console.error(`Something is listening on port ${PORT}. Stop \`npm run dev\` first (Ctrl+C), then run this again.`);
  process.exit(1);
}

execFileSync("node", [fileURLToPath(new URL("./sf-reset.mjs", import.meta.url))], { stdio: "inherit" });

// `wrangler dev` keeps local state beside the first config it is given
// (workers/agent). The other two places are cleared too, in case the Workers
// were ever started another way.
const places = ["workers/agent/.wrangler/state", "workers/gatekeeper/.wrangler/state", ".wrangler/state"];
let cleared = 0;
for (const place of places) {
  const state = fileURLToPath(new URL(`../${place}`, import.meta.url));
  if (!existsSync(state)) continue;
  rmSync(state, { recursive: true, force: true });
  console.log(`Cleared local state: ${place}`);
  cleared += 1;
}
console.log(cleared > 0 ? "The local proposal and audit log are gone." : "No local state to clear");
console.log("\nReady. Start the Workers again with: npm run dev:replay   (or npm run dev for live model calls)");
