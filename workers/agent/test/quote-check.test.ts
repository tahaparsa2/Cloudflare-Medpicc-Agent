import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MIN_QUOTE_LENGTH, checkQuote, normalize, speakerTurns } from "../src/quote-check";

const transcript = [
  "SYNTHETIC TRANSCRIPT.",
  "Participants: Maya Chen (Halden Networks); Priya Raman (Tessaline Freight)",
  "",
  "Maya Chen: Is there a date that makes this urgent, or is it a general frustration?",
  "",
  "Priya Raman: There is a date. The VPN hardware goes out of support in March. After that we get",
  "no security patches, and Marcus will not sign off on running it.",
  "",
  "Marcus Hale: Correct. I am not carrying unpatched remote access into an audit.",
].join("\n");

describe("normalize", () => {
  it("forgives case and whitespace, and nothing else", () => {
    expect(normalize("  The VPN\n\thardware  ")).toBe("the vpn hardware");
    expect(normalize("out of support.")).not.toBe(normalize("out of support"));
  });
});

describe("checkQuote", () => {
  it.each([
    ["an exact passage", "The VPN hardware goes out of support in March."],
    ["different case", "the vpn hardware GOES OUT of support in march."],
    ["different whitespace", "The  VPN hardware\ngoes out of   support in March."],
    ["a passage that crosses a line break", "After that we get no security patches, and Marcus will not sign off"],
    ["a whole turn with its speaker", "Marcus Hale: Correct. I am not carrying unpatched remote access into an audit."],
    ["a passage that runs from one turn into the next, copied exactly", "general frustration? Priya Raman: There is a date."],
    ["the speaker's name in front of words from the middle of their turn", "Priya Raman: The VPN hardware goes out of support in March."],
    ["the same, in different case and spacing", "priya raman:   the VPN hardware goes out of support in march."],
  ])("accepts %s", (_label, quote) => {
    expect(checkQuote(quote, transcript)).toEqual({ ok: true });
  });

  it.each([
    ["a paraphrase", "The VPN hardware reaches end of support in March."],
    ["a changed number", "The VPN hardware goes out of support in April."],
    ["dropped punctuation", "There is a date The VPN hardware goes out of support in March"],
    ["an ellipsis joining two passages", "There is a date... Marcus will not sign off on running it."],
    ["two passages joined into one", "There is a date. Marcus will not sign off on running it."],
    ["words from one speaker under another speaker's name", "Marcus Hale: The VPN hardware goes out of support in March."],
    ["a speaker who is not in the call", "Elena Vasquez: The VPN hardware goes out of support in March."],
    ["an invented line", "Our budget for this project is two million dollars."],
    ["an invented line under a real speaker's name", "Priya Raman: Our budget for this project is two million dollars."],
  ])("rejects %s", (_label, quote) => {
    expect(checkQuote(quote, transcript)).toEqual({ ok: false, reason: "the quote is not in the transcript" });
  });

  it.each([
    ["a word that appears in every call", "Correct."],
    ["a short phrase", "There is a date."],
    ["a short phrase behind a speaker's name", "Priya Raman: There is a date."],
  ])("rejects %s as too short to check", (_label, quote) => {
    const verdict = checkQuote(quote, transcript);
    expect(verdict.ok).toBe(false);
    expect(verdict).toMatchObject({ reason: expect.stringContaining("too short") });
  });

  it.each([[""], ["   \n "], [null], [undefined], [42], [["a", "b"]]])("rejects %j as no quote", (quote) => {
    expect(checkQuote(quote, transcript)).toEqual({ ok: false, reason: "no quote was given" });
  });

  it("measures length after normalising, so padding does not help", () => {
    expect(checkQuote(`Correct.${" ".repeat(MIN_QUOTE_LENGTH)}`, transcript).ok).toBe(false);
  });

  it("finds nothing in an empty transcript", () => {
    expect(checkQuote("The VPN hardware goes out of support in March.", "").ok).toBe(false);
  });
});

describe("speakerTurns", () => {
  it("splits a transcript into turns that run to the next speaker", () => {
    const turns = speakerTurns(transcript);
    expect(turns.map((t) => t.speaker)).toEqual(["participants", "maya chen", "priya raman", "marcus hale"]);
    expect(turns[2]!.text).toBe(
      "there is a date. the vpn hardware goes out of support in march. after that we get no security patches, and marcus will not sign off on running it.",
    );
  });

  it("reads the real fixture calls", () => {
    for (const call of ["call-1", "call-2"]) {
      const path = fileURLToPath(new URL(`../../../fixtures/calls/${call}.txt`, import.meta.url).href);
      const speakers = new Set(speakerTurns(readFileSync(path, "utf8")).map((t) => t.speaker));
      expect(speakers.has("maya chen")).toBe(true);
      expect(speakers.has("priya raman")).toBe(true);
    }
  });
});
