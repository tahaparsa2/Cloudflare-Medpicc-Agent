/**
 * "How do you know it is right?" This runs every fixture call through the real
 * model and prints, per field, what Taha expects against what was proposed.
 * It spends about 200 neurons of the daily free allocation per call.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { buildMessages, parseModelOutput, verifyProposals } from "../src/extraction";
import { FORECAST_SIGNALS, MEDDPICC_FIELDS } from "../src/fields";
import { sha256Hex } from "../src/hash";
import { workersAiModel, type Recording } from "../src/model";

const root = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url).href);
const read = (path: string) => readFileSync(root(path), "utf8");

interface Expected {
  current?: Record<string, string | null>;
  fields: Record<string, "expect" | "blank" | "unlabelled">;
}

let proxy: PlatformProxy<{ AI: unknown; MODEL_ID: string; AI_GATEWAY_ID: string }>;

beforeAll(async () => {
  proxy = await getPlatformProxy({ configPath: root("workers/agent/wrangler.jsonc") });
});
afterAll(async () => {
  await proxy?.dispose();
});

const calls = readdirSync(root("fixtures/calls"))
  .filter((name) => name.endsWith(".txt"))
  .map((name) => name.replace(/\.txt$/, ""))
  .sort();

it.each(calls)("%s", async (transcriptId) => {
  const { AI, MODEL_ID, AI_GATEWAY_ID } = proxy.env;
  const context = read("context/meddpicc.md");
  const transcript = read(`fixtures/calls/${transcriptId}.txt`);
  const expected = JSON.parse(read(`fixtures/expected/${transcriptId}.json`)) as Expected;
  const current = expected.current ?? {};

  const answer = await workersAiModel(AI, MODEL_ID, AI_GATEWAY_ID).extract({
    messages: buildMessages({ context, transcript }),
    transcriptId,
    metadata: { transcript: transcriptId, source: "eval" },
  });

  if (process.env.RECORD === "1") {
    const recording: Recording = {
      transcriptId,
      transcriptHash: sha256Hex(transcript),
      contextHash: sha256Hex(context),
      modelId: answer.modelId,
      recordedAt: new Date().toISOString(),
      output: answer.output,
    };
    writeFileSync(root(`fixtures/recorded/${transcriptId}.json`), JSON.stringify(recording, null, 2) + "\n");
  }

  const out: string[] = ["", `${transcriptId}   model ${answer.modelId}   gateway log ${answer.gatewayLogId ?? "none"}`];
  out.push(answer.usage ? `  tokens: ${answer.usage.promptTokens} in, ${answer.usage.completionTokens} out` : "  tokens: not reported");
  const parsed = parseModelOutput(answer.output);
  if (!parsed.ok) {
    out.push(`  NO PROPOSAL: ${parsed.reason}`, `  raw answer: ${JSON.stringify(answer.output).slice(0, 600)}`);
    console.log(out.join("\n"));
    expect(parsed.ok, parsed.reason).toBe(true);
    return;
  }
  // Labels say what each transcript supports on its own, so the eval judges
  // the call with nothing in Salesforce unless the label file gives values.
  const fields = verifyProposals(parsed.proposals, transcript, current);
  const signals = verifyProposals(parsed.signals, transcript);
  const accepted = [...fields.accepted, ...signals.accepted];
  const dropped = [...fields.dropped, ...signals.dropped];

  let labelled = 0;
  let agreed = 0;
  for (const { field, label } of [...MEDDPICC_FIELDS, ...FORECAST_SIGNALS]) {
    const want = expected.fields[field] ?? "unlabelled";
    const got = accepted.find((item) => item.field === field);
    let verdict = "not labelled";
    if (want !== "unlabelled") {
      labelled += 1;
      const ok = (want === "expect") === Boolean(got);
      if (ok) agreed += 1;
      verdict = ok ? "ok" : want === "expect" ? "MISSED" : "EXTRA";
    }
    out.push(`  ${label.padEnd(18)} expected ${want.padEnd(10)} ${got ? "proposed" : "blank   "}  ${verdict}`);
    if (got) out.push(`      value: ${got.value}`, ...got.quotes.map((quote) => `      quote: "${quote}"`));
  }
  for (const item of dropped) {
    out.push(`  DROPPED ${item.label ?? "(whole answer)"}: ${item.reason}`);
    if (item.quote) out.push(`      quote: "${item.quote}"`);
  }
  out.push(labelled ? `  ${agreed} of ${labelled} labelled fields agree` : "  no labels yet: fill in fixtures/expected/" + transcriptId + ".json");
  console.log(out.join("\n"));
});
