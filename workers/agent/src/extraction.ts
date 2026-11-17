/**
 * Everything around the one model call: what the model is asked, the schema
 * its answer must match, and the checks its answer has to pass in code.
 * Nothing in this file calls a model.
 */

import { FIELD_NAMES, FORECAST_SIGNALS, MEDDPICC_FIELDS, SIGNAL_NAMES, labelFor } from "./fields";
import type { DroppedField } from "./proposal";
import { checkQuote } from "./quote-check";

export interface Message {
  role: "system" | "user";
  content: string;
}

/** A proposal is a line or two for a CRM field, not an essay. */
export const MAX_PROPOSED_LENGTH = 2_000;

export const MAX_QUOTES = 3;

const FIELD_ANSWER = {
  type: "object",
  properties: {
    // Quotes come before the value, so the model finds its evidence first.
    quotes: { type: "array", items: { type: "string" } },
    value: { type: "string" },
  },
  required: ["quotes", "value"],
} as const;

/** Every key the model must answer: the eight MEDDPICC fields, then the forecast signals. */
export const ANSWER_KEYS: readonly string[] = [...FIELD_NAMES, ...SIGNAL_NAMES];

/**
 * The schema sent to the model with JSON Mode, and enforced again in
 * `parseModelOutput`. Every key must be answered, with an empty value where
 * the call does not support it. Asking for each by name matters: given a
 * free-form list, the model often returned an empty one.
 */
export const EXTRACTION_SCHEMA = {
  type: "object",
  properties: Object.fromEntries(ANSWER_KEYS.map((key) => [key, FIELD_ANSWER])),
  required: [...ANSWER_KEYS],
};

/**
 * What the model is asked. It sees the guide and the transcript and nothing
 * about what Salesforce holds, so the same call always gets the same question.
 * What to do with a field that already has a value is decided in code.
 */
export function buildMessages(input: { context: string; transcript: string }): Message[] {
  const fieldList = MEDDPICC_FIELDS.map((f) => `- ${f.field}: ${f.label}`).join("\n");
  const signalList = FORECAST_SIGNALS.map((f) => `- ${f.field}: ${f.label}`).join("\n");

  const system = [
    "You fill in MEDDPICC fields on a Salesforce opportunity from the transcript of one sales call.",
    "",
    "Rules:",
    "- Answer for all eight MEDDPICC fields.",
    "- Propose a value only when the transcript holds evidence for the field, as the guide below defines evidence.",
    '- For every value you propose, give "quotes": one to three passages copied from the transcript, word for word, that support it. Each passage must be one continuous stretch of the transcript from one speaker. If your evidence is in two places, give two quotes. Never join them into one, never paraphrase, never shorten with "...".',
    '- If the transcript does not support a field, or the guide says that kind of statement does not count, answer that field with "quotes": [] and "value": "". Do not guess.',
    '- Write each value as the guide\'s "How to write a value" section says.',
    "- Also answer CloseDate. Give it a value only when the buyer's side says in this call that the date they expect to sign has changed. The value is the new timing in the words of the call, with the same kind of quotes. Do not work out a calendar date. If the call does not say the signing date changed, answer CloseDate with \"quotes\": [] and \"value\": \"\".",
    "- Answer with JSON only, in the shape the schema requires.",
    "",
    "MEDDPICC fields, by the exact names to use:",
    fieldList,
    "",
    "Forecast field to listen for, by the exact name to use:",
    signalList,
    "",
    "<guide>",
    input.context.trim(),
    "</guide>",
  ].join("\n");

  const user = ["<transcript>", input.transcript.trim(), "</transcript>"].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

export interface RawProposal {
  field: string;
  value: string;
  quotes: string[];
}

export type ParseResult = { ok: true; proposals: RawProposal[]; signals: RawProposal[] } | { ok: false; reason: string };

/**
 * Check the model's answer against the schema. Workers AI does not guarantee
 * the answer matches, so any mismatch makes the whole answer unusable: no
 * proposal, rather than a partly trusted one.
 *
 * Returns only the keys the model gave a value for: MEDDPICC fields as
 * `proposals`, forecast fields as `signals`.
 */
export function parseModelOutput(output: unknown): ParseResult {
  let answer = output;
  if (typeof answer === "string") {
    try {
      answer = JSON.parse(answer);
    } catch {
      return { ok: false, reason: "the model answer is not JSON" };
    }
  }
  if (typeof answer !== "object" || answer === null || Array.isArray(answer)) {
    return { ok: false, reason: "the model answer is not a JSON object" };
  }
  const byField = answer as Record<string, unknown>;
  for (const key of Object.keys(byField)) {
    if (!ANSWER_KEYS.includes(key)) {
      return { ok: false, reason: `the model answer names a field it was not asked for: ${JSON.stringify(key.slice(0, 80))}` };
    }
  }

  const proposals: RawProposal[] = [];
  const signals: RawProposal[] = [];
  for (const field of ANSWER_KEYS) {
    const item = byField[field];
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return { ok: false, reason: `the model answer has no entry for ${field}` };
    }
    const { value, quotes } = item as Record<string, unknown>;
    if (typeof value !== "string" || !Array.isArray(quotes) || !quotes.every((quote) => typeof quote === "string")) {
      return { ok: false, reason: `the model answer for ${field} is missing its value or its list of quotes` };
    }
    // An empty value is the model saying the call does not support this field.
    if (value.trim() === "") continue;
    (SIGNAL_NAMES.includes(field) ? signals : proposals).push({ field, value, quotes: quotes as string[] });
  }
  return { ok: true, proposals, signals };
}

export interface VerifiedProposals {
  accepted: RawProposal[];
  dropped: DroppedField[];
}

/** Why the agent leaves a filled field alone. Shown on the review page and in the audit log. */
export const ALREADY_FILLED =
  "Salesforce already has a value for this field, and in this demo the agent only proposes for empty fields";

/**
 * The checks every proposal passes in code before a person sees it. Every one
 * of its quotes must be in the transcript. A proposal that fails is dropped
 * and the drop is kept, with its reason, for the audit log.
 *
 * `current` turns on the demo's empty-only rule: a field that already has a
 * value in Salesforce is not proposed again, whatever the call says. Forecast
 * signals are checked without it.
 */
export function verifyProposals(
  proposals: RawProposal[],
  transcript: string,
  current?: Record<string, string | null>,
): VerifiedProposals {
  const accepted: RawProposal[] = [];
  const dropped: DroppedField[] = [];
  const seen = new Set<string>();

  for (const proposal of proposals) {
    const value = proposal.value.trim();
    const quotes = proposal.quotes.map((quote) => quote.trim()).filter((quote) => quote !== "");
    const drop = (reason: string, quote?: string) =>
      dropped.push({ field: proposal.field, label: labelFor(proposal.field), value: value || null, quote: quote ?? (quotes.join("\n") || null), reason });

    if (seen.has(proposal.field)) {
      drop("the model proposed this field twice; the first proposal is kept");
      continue;
    }
    if (value === "") {
      drop("the proposed value is empty");
      continue;
    }
    if (current && (current[proposal.field] ?? "").trim() !== "") {
      drop(ALREADY_FILLED);
      continue;
    }
    if (value.length > MAX_PROPOSED_LENGTH) {
      drop(`the proposed value is over ${MAX_PROPOSED_LENGTH} characters`);
      continue;
    }
    if (quotes.length === 0) {
      drop("no quote was given");
      continue;
    }
    if (quotes.length > MAX_QUOTES) {
      drop(`more than ${MAX_QUOTES} quotes were given`);
      continue;
    }
    const failed = quotes.map((quote) => ({ quote, verdict: checkQuote(quote, transcript) })).find((q) => !q.verdict.ok);
    if (failed && !failed.verdict.ok) {
      drop(failed.verdict.reason, failed.quote);
      continue;
    }
    seen.add(proposal.field);
    accepted.push({ field: proposal.field, value, quotes });
  }
  return { accepted, dropped };
}
