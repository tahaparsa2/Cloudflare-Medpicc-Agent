import { createHash } from "node:crypto";

/**
 * The one serialization every hash in this Worker covers: compact JSON with
 * object keys sorted. Same rule as GTM OS module 2.1.
 */
export function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = sortKeys(source[key]);
    return sorted;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("canonical JSON cannot hold NaN or Infinity");
  }
  return value;
}

/** Synchronous on purpose: an audit append must not yield between read and insert. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
