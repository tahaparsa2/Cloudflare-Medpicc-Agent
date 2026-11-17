/**
 * The quote check: the main defence against invented values, and it needs no
 * second model. A proposal survives only if its quotes are in the transcript.
 */

/** A quote this short would match almost any transcript, so it proves nothing. */
export const MIN_QUOTE_LENGTH = 20;

/** Case and whitespace are the only things forgiven. Punctuation and wording are not. */
export function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export type QuoteVerdict = { ok: true } | { ok: false; reason: string };

const tooShort = `the quote is under ${MIN_QUOTE_LENGTH} characters, too short to check`;

export function checkQuote(quote: unknown, transcript: string): QuoteVerdict {
  if (typeof quote !== "string" || normalize(quote) === "") {
    return { ok: false, reason: "no quote was given" };
  }
  const wanted = normalize(quote);
  const whole = normalize(transcript);

  // The model often writes "Speaker: words". When the name is a speaker in
  // this call, it is an attribution: the length that counts is the words
  // alone, and they must be in a turn by that same speaker. So a name cannot
  // pad a short quote, and words cannot be put in another speaker's mouth.
  const labelled = /^([^:\n]{1,60}):\s*([\s\S]+)$/.exec(quote.trim());
  if (labelled) {
    const speaker = normalize(labelled[1]!);
    const turns = speakerTurns(transcript).filter((turn) => turn.speaker === speaker);
    if (turns.length > 0) {
      const said = normalize(labelled[2]!);
      if (said.length < MIN_QUOTE_LENGTH) return { ok: false, reason: tooShort };
      // In one of their turns, or copied exactly from where their turn begins.
      const found = turns.some((turn) => turn.text.includes(said)) || whole.includes(wanted);
      return found ? { ok: true } : { ok: false, reason: "the quote is not in the transcript" };
    }
  }

  if (wanted.length < MIN_QUOTE_LENGTH) return { ok: false, reason: tooShort };
  return whole.includes(wanted) ? { ok: true } : { ok: false, reason: "the quote is not in the transcript" };
}

/** The transcript as turns: a line starting "Name: " opens a turn that runs to the next such line. */
export function speakerTurns(transcript: string): { speaker: string; text: string }[] {
  const turns: { speaker: string; lines: string[] }[] = [];
  for (const line of transcript.split(/\r?\n/)) {
    const opening = /^([^:\n]{1,60}):\s+(.*)$/.exec(line);
    if (opening) turns.push({ speaker: normalize(opening[1]!), lines: [opening[2]!] });
    else turns.at(-1)?.lines.push(line);
  }
  return turns.map((turn) => ({ speaker: turn.speaker, text: normalize(turn.lines.join(" ")) }));
}
