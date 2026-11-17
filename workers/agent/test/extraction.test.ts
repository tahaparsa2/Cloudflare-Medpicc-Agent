import { describe, expect, it } from "vitest";
import { ALREADY_FILLED, ANSWER_KEYS, EXTRACTION_SCHEMA, MAX_PROPOSED_LENGTH, buildMessages, parseModelOutput, verifyProposals } from "../src/extraction";
import { FIELD_NAMES } from "../src/fields";
import { sha256Hex } from "../src/hash";
import { checkQuote } from "../src/quote-check";
import { CALL_1, CALL_2, CONTEXT, answer, readFixture, recording } from "./helpers";

const PAIN = "The VPN hardware goes out of support in March.";
const OUTAGES = "We had three VPN outages last quarter, and each one lasted about four hours.";
const SLIP = "Signature will slip to January, realistically the week after that board meeting.";

describe("buildMessages", () => {
  const [system, user] = buildMessages({ context: CONTEXT, transcript: CALL_1 });

  it("gives the model the guide, the field names and the rules", () => {
    expect(system!.role).toBe("system");
    expect(system!.content).toContain(CONTEXT.trim());
    for (const key of ANSWER_KEYS) expect(system!.content).toContain(key);
    expect(system!.content).toContain("word for word");
  });

  it("gives the model the transcript, and nothing about what Salesforce holds", () => {
    expect(user!.role).toBe("user");
    expect(user!.content).toBe(`<transcript>\n${CALL_1.trim()}\n</transcript>`);
    expect(system!.content).not.toContain("Current values");
  });

  it("asks for the close date only as a change said in the call, never as a computed date", () => {
    expect(system!.content).toContain("CloseDate");
    expect(system!.content).toContain("Do not work out a calendar date");
  });
});

describe("EXTRACTION_SCHEMA", () => {
  it("requires an answer for the eight fields and the close date, and nothing else", () => {
    expect(ANSWER_KEYS).toEqual([...FIELD_NAMES, "CloseDate"]);
    expect(EXTRACTION_SCHEMA.required).toEqual(ANSWER_KEYS);
    expect(Object.keys(EXTRACTION_SCHEMA.properties)).toEqual(ANSWER_KEYS);
  });
});

describe("parseModelOutput", () => {
  const good = answer({ Identified_Pain__c: { value: "VPN hardware out of support in March.", quotes: [PAIN] } });

  it("returns the fields the model gave a value for", () => {
    expect(parseModelOutput(good)).toEqual({
      ok: true,
      proposals: [{ field: "Identified_Pain__c", value: "VPN hardware out of support in March.", quotes: [PAIN] }],
      signals: [],
    });
  });

  it("returns the close date as a signal, apart from the proposals", () => {
    const withDate = { ...good, CloseDate: { value: "January, the week after the board meeting", quotes: [SLIP] } };
    expect(parseModelOutput(withDate)).toEqual({
      ok: true,
      proposals: [{ field: "Identified_Pain__c", value: "VPN hardware out of support in March.", quotes: [PAIN] }],
      signals: [{ field: "CloseDate", value: "January, the week after the board meeting", quotes: [SLIP] }],
    });
  });

  it("accepts the same answer as a JSON string", () => {
    expect(parseModelOutput(JSON.stringify(good))).toMatchObject({ ok: true, proposals: [{ field: "Identified_Pain__c" }] });
  });

  it("returns no proposals when every value is empty", () => {
    expect(parseModelOutput(answer({}))).toEqual({ ok: true, proposals: [], signals: [] });
  });

  it("treats a whitespace-only value as empty", () => {
    expect(parseModelOutput(answer({ Champion__c: { value: "  \n", quotes: ["anything at all here"] } }))).toEqual({ ok: true, proposals: [], signals: [] });
  });

  it.each<[string, unknown]>([
    ["text that is not JSON", "Here are the fields you asked for"],
    ["null", null],
    ["a number", 7],
    ["a list", [good]],
    ["nothing", undefined],
    ["an empty object", {}],
    ["the old list shape", { proposals: [] }],
    ["a missing field", (() => { const { Champion__c: _gone, ...rest } = good; return rest; })()],
    ["a missing close date entry", (() => { const { CloseDate: _gone, ...rest } = good; return rest; })()],
    ["a field it was not asked for", { ...good, Amount: { value: "90000", quotes: ["this is above that"] } }],
    ["a field that is a string", { ...good, Champion__c: "Priya Raman" }],
    ["a field that is null", { ...good, Champion__c: null }],
    ["a value that is not a string", { ...good, Champion__c: { value: 42, quotes: [] } }],
    ["quotes that are not a list", { ...good, Champion__c: { value: "Priya Raman", quotes: "I am running the evaluation" } }],
    ["a quote that is not a string", { ...good, Champion__c: { value: "Priya Raman", quotes: [{ text: "x" }] } }],
    ["a missing quotes list", { ...good, Champion__c: { value: "Priya Raman" } }],
  ])("refuses %s, as a whole", (_label, output) => {
    const result = parseModelOutput(output);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: expect.any(String) });
  });
});

describe("verifyProposals", () => {
  const verify = (proposals: { field: string; value: string; quotes: string[] }[], current: Record<string, string | null> = {}) =>
    verifyProposals(proposals, CALL_1, current);

  it("accepts a proposal whose quote is in the transcript", () => {
    const result = verify([{ field: "Identified_Pain__c", value: " VPN hardware out of support in March. ", quotes: [` ${PAIN} `] }]);
    expect(result.dropped).toEqual([]);
    expect(result.accepted).toEqual([{ field: "Identified_Pain__c", value: "VPN hardware out of support in March.", quotes: [PAIN] }]);
  });

  it("accepts up to three quotes when every one is in the transcript", () => {
    const result = verify([{ field: "Identified_Pain__c", value: "Outages and a support deadline.", quotes: [PAIN, OUTAGES] }]);
    expect(result.accepted).toHaveLength(1);
  });

  it.each<[string, { value?: string; quotes: string[] }, string]>([
    ["an invented quote", { quotes: ["Our budget for this project is two million dollars."] }, "not in the transcript"],
    ["one good quote and one invented", { quotes: [PAIN, "Our budget for this project is two million dollars."] }, "not in the transcript"],
    ["a paraphrased quote", { quotes: ["The VPN hardware reaches end of support in March."] }, "not in the transcript"],
    ["no quote", { quotes: [] }, "no quote was given"],
    ["only blank quotes", { quotes: ["", "  "] }, "no quote was given"],
    ["a quote too short to check", { quotes: ["in March."] }, "too short"],
    ["four quotes", { quotes: [PAIN, PAIN, PAIN, PAIN] }, "more than 3 quotes"],
    ["a value over the limit", { value: "x".repeat(MAX_PROPOSED_LENGTH + 1), quotes: [PAIN] }, "over 2000 characters"],
  ])("drops a proposal with %s, and says why", (_label, change, reason) => {
    const result = verify([{ field: "Identified_Pain__c", value: "VPN hardware out of support in March.", ...change }]);
    expect(result.accepted).toEqual([]);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]).toMatchObject({ field: "Identified_Pain__c", label: "Identified Pain", reason: expect.stringContaining(reason) });
  });

  it("names the quote that failed", () => {
    const invented = "Our budget for this project is two million dollars.";
    const result = verify([{ field: "Identified_Pain__c", value: "v", quotes: [PAIN, invented] }]);
    expect(result.dropped[0]!.quote).toBe(invented);
  });

  describe("the empty-only rule", () => {
    const pain = { field: "Identified_Pain__c", value: "VPN hardware out of support in March.", quotes: [PAIN] };

    it("drops a proposal for a field that already has a value, and says why", () => {
      const result = verify([pain], { Identified_Pain__c: "Something older" });
      expect(result.accepted).toEqual([]);
      expect(result.dropped).toEqual([expect.objectContaining({ field: "Identified_Pain__c", value: pain.value, reason: ALREADY_FILLED })]);
    });

    it.each<[string, string | null | undefined]>([
      ["null", null],
      ["an empty string", ""],
      ["only whitespace", "  \n"],
      ["absent", undefined],
    ])("keeps a proposal when the Salesforce value is %s", (_label, held) => {
      const current: Record<string, string | null> = held === undefined ? {} : { Identified_Pain__c: held };
      expect(verify([pain], current).accepted).toEqual([pain]);
    });

    it("looks only at the field's own value", () => {
      expect(verify([pain], { Champion__c: "Priya Raman" }).accepted).toEqual([pain]);
    });

    it("drops a filled field even when its quote is invented: one reason, the first that applies", () => {
      const result = verify([{ ...pain, quotes: ["Our budget for this project is two million dollars."] }], { Identified_Pain__c: "Older" });
      expect(result.dropped.map((d) => d.reason)).toEqual([ALREADY_FILLED]);
    });

    it("does not apply when no Salesforce values are given, as for a forecast signal", () => {
      const result = verifyProposals([{ field: "CloseDate", value: "January", quotes: [SLIP] }], CALL_2);
      expect(result.accepted).toEqual([{ field: "CloseDate", value: "January", quotes: [SLIP] }]);
    });
  });

  it("drops a forecast signal whose quote is not in the transcript", () => {
    const result = verifyProposals([{ field: "CloseDate", value: "February", quotes: ["We will sign in February, once the audit is done."] }], CALL_2);
    expect(result.accepted).toEqual([]);
    expect(result.dropped).toEqual([expect.objectContaining({ field: "CloseDate", label: "Close Date", reason: "the quote is not in the transcript" })]);
  });

  it("keeps the first proposal when a field comes twice", () => {
    const result = verify([
      { field: "Identified_Pain__c", value: "First", quotes: [PAIN] },
      { field: "Identified_Pain__c", value: "Second", quotes: [OUTAGES] },
    ]);
    expect(result.accepted.map((p) => p.value)).toEqual(["First"]);
    expect(result.dropped[0]!.reason).toContain("twice");
  });

  it("judges each field on its own", () => {
    const result = verify([
      { field: "Identified_Pain__c", value: "Real", quotes: [PAIN] },
      { field: "Economic_Buyer__c", value: "Invented CFO", quotes: ["Elena Vasquez signs everything above 50,000 dollars."] },
    ]);
    expect(result.accepted.map((p) => p.field)).toEqual(["Identified_Pain__c"]);
    expect(result.dropped.map((d) => d.field)).toEqual(["Economic_Buyer__c"]);
  });
});

describe.each(["call-1", "call-2"])("the recorded model answer for %s", (id) => {
  const transcript = readFixture(`fixtures/calls/${id}.txt`);
  const saved = recording(id);

  it("was recorded against the transcript as it is now", () => {
    expect(saved.transcriptId).toBe(id);
    expect(saved.transcriptHash, "the transcript changed: run npm run eval:record").toBe(sha256Hex(transcript));
  });

  it("matches the schema", () => {
    expect(parseModelOutput(saved.output).ok).toBe(true);
  });

  it("gives proposals, and every accepted one is backed by the transcript", () => {
    const parsed = parseModelOutput(saved.output);
    if (!parsed.ok) throw new Error(parsed.reason);
    const { accepted, dropped } = verifyProposals(parsed.proposals, transcript, {});
    expect(accepted.length + dropped.length).toBe(parsed.proposals.length);
    expect(accepted.length).toBeGreaterThan(0);
    for (const proposal of accepted) {
      for (const quote of proposal.quotes) expect(checkQuote(quote, transcript)).toEqual({ ok: true });
    }
  });
});

describe("the recorded answers and the close date", () => {
  const signals = (id: string) => {
    const parsed = parseModelOutput(recording(id).output);
    if (!parsed.ok) throw new Error(parsed.reason);
    return verifyProposals(parsed.signals, readFixture(`fixtures/calls/${id}.txt`));
  };

  it("call 1 says nothing about the close date", () => {
    expect(signals("call-1")).toEqual({ accepted: [], dropped: [] });
  });

  it("call 2 says the close date slipped, with a quote that is in the transcript", () => {
    const { accepted, dropped } = signals("call-2");
    expect(dropped).toEqual([]);
    expect(accepted.map((s) => s.field)).toEqual(["CloseDate"]);
    expect(accepted[0]!.value).toMatch(/january/i);
  });
});
