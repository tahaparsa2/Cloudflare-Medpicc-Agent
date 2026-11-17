import { createHash } from "node:crypto";

/** SHA-256 of a text, as hex. Names the exact transcript and context file behind a proposal. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
