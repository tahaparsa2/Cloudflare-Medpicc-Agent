/**
 * The policy evaluator: whether a write is allowed is a pure function of the
 * policy file, the approval record and the Salesforce values. No model call,
 * no I/O, no clock.
 *
 * Ported from GTM OS module 2.2 (design and rule semantics, not the code):
 *   - anything no rule allows is denied;
 *   - when a field is named under several rules, the most restrictive wins;
 *   - a fact the caller does not know never loosens the answer;
 *   - every answer names the rule that decided it.
 */

import { canonical, sha256Hex } from "./canonical";

export const RULES = ["rep_approval", "manager_approval", "deny"] as const;
export type Rule = (typeof RULES)[number];

/** Stricter rules rank higher. */
const STRICTNESS: Record<Rule, number> = { rep_approval: 0, manager_approval: 1, deny: 2 };

/** Salesforce long text area limit for the MEDDPICC fields. */
export const MAX_VALUE_LENGTH = 32_768;

const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;
/** Read-only display fields may reach one relationship away, e.g. Account.Name. */
const READ_NAME = /^[A-Za-z][A-Za-z0-9_]{0,79}(\.[A-Za-z][A-Za-z0-9_]{0,79})?$/;

export interface Policy {
  version: 1;
  object: "Opportunity";
  rules: Record<Rule, readonly string[]>;
  readOnly: readonly string[];
  /** SHA-256 of the canonical JSON of the policy file. Goes into every audit row. */
  hash: string;
}

export class PolicyError extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function nameList(value: unknown, where: string, pattern: RegExp): string[] {
  if (!Array.isArray(value)) throw new PolicyError(`${where} must be a list of field names`);
  for (const name of value) {
    if (typeof name !== "string" || !pattern.test(name)) {
      throw new PolicyError(`${where} holds an invalid field name: ${JSON.stringify(name)}`);
    }
  }
  return value as string[];
}

/** Validate the policy file. An invalid file throws, so the Worker does not start. */
export function parsePolicy(raw: unknown): Policy {
  if (!isRecord(raw)) throw new PolicyError("policy must be an object");
  const known = new Set(["version", "object", "description", "rules", "read_only", "default"]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) throw new PolicyError(`unknown policy key: ${key}`);
  }
  if (raw.version !== 1) throw new PolicyError("policy version must be 1");
  if (raw.object !== "Opportunity") throw new PolicyError('policy object must be "Opportunity"');
  if (raw.default !== "deny") throw new PolicyError('policy default must be "deny"');
  if (!isRecord(raw.rules)) throw new PolicyError("policy rules must be an object");

  const rules: Record<Rule, string[]> = { rep_approval: [], manager_approval: [], deny: [] };
  for (const [name, fields] of Object.entries(raw.rules)) {
    if (!(RULES as readonly string[]).includes(name)) throw new PolicyError(`unknown rule: ${name}`);
    rules[name as Rule] = nameList(fields, `rules.${name}`, FIELD_NAME);
  }
  const readOnly = raw.read_only === undefined ? [] : nameList(raw.read_only, "read_only", READ_NAME);

  return { version: 1, object: "Opportunity", rules, readOnly, hash: sha256Hex(canonical(raw)) };
}

/** The rule for a field and the name it is reported under. Most restrictive wins. */
export function ruleFor(policy: Policy, field: string): { rule: Rule; name: string } {
  let found: Rule | null = null;
  for (const rule of RULES) {
    if (policy.rules[rule].includes(field) && (found === null || STRICTNESS[rule] > STRICTNESS[found])) {
      found = rule;
    }
  }
  return found === null ? { rule: "deny", name: "default.deny" } : { rule: found, name: `rules.${found}` };
}

/** Every field the gatekeeper may read: the governed fields plus the read-only ones. */
export function readableFields(policy: Policy): string[] {
  const denied = new Set(policy.rules.deny);
  const all = [...policy.rules.rep_approval, ...policy.rules.manager_approval, ...policy.readOnly];
  return [...new Set(all)].filter((field) => !denied.has(field));
}

/** A value the caller may or may not know. Unknown is not the same as empty. */
export type Known<T> = { known: true; value: T } | { known: false };

export const known = <T>(value: T): Known<T> => ({ known: true, value });
export const UNKNOWN: Known<never> = { known: false };

export type DecisionKind = "approve" | "edit" | "reject";

/** One person's decision on one field of one proposal. */
export interface ApprovalRecord {
  proposalId: string;
  field: string;
  decision: DecisionKind;
  /** The exact value approved. Null for a rejection. */
  value: string | null;
  /** `user:<email>` once Access is on; `dev:<email>` for the local dev identity. */
  approver: string;
}

export interface WriteRequest {
  /** Null for a direct request with no proposal behind it. */
  proposalId: string | null;
  field: string;
  value: unknown;
  approval: ApprovalRecord | null;
  /** The Salesforce value captured when the proposal was drafted. */
  before: Known<string | null>;
  /** The Salesforce value right now. */
  current: Known<string | null>;
}

export type ReasonCode =
  | "approved"
  | "invalid_field"
  | "field_denied"
  | "needs_manager_approval"
  | "invalid_value"
  | "needs_rep_approval"
  | "rejected_by_rep"
  | "approval_mismatch"
  | "approver_not_a_person"
  | "before_unknown"
  | "current_unknown"
  | "stale";

export interface Decision {
  allowed: boolean;
  code: ReasonCode;
  /** The rule that decided it, e.g. `rules.manager_approval` or `default.deny`. */
  rule: string;
  reason: string;
}

const refuse = (code: ReasonCode, rule: string, reason: string): Decision => ({
  allowed: false,
  code,
  rule,
  reason,
});

/** Salesforce returns null for empty and may change line endings and outer whitespace. */
export function normalizeValue(value: string | null | undefined): string {
  return (value ?? "").replace(/\r\n?/g, "\n").trim();
}

const isPerson = (principal: string): boolean => /^(user|dev):.+/.test(principal);

/**
 * Decide one field write.
 *
 * Order: the field name, then the policy rule, then the value, then the
 * approval record, then the stale check. The first failure is the answer.
 */
export function evaluateWrite(policy: Policy, request: WriteRequest): Decision {
  const { field, value, approval } = request;

  if (typeof field !== "string" || !FIELD_NAME.test(field)) {
    return refuse("invalid_field", "target.invalid", "that is not a field name");
  }

  const { rule, name } = ruleFor(policy, field);
  if (rule === "deny") {
    return refuse("field_denied", name, `${field} is not writable: no policy rule allows it`);
  }
  if (rule === "manager_approval") {
    return refuse(
      "needs_manager_approval",
      name,
      `${field} is a forecast field: needs manager approval, which this demo does not build`,
    );
  }

  // rule === "rep_approval" from here on.
  if (typeof value !== "string" || value.trim() === "" || value.length > MAX_VALUE_LENGTH) {
    return refuse(
      "invalid_value",
      name,
      `the value for ${field} must be text of 1 to ${MAX_VALUE_LENGTH} characters`,
    );
  }
  if (approval === null) {
    return refuse(
      "needs_rep_approval",
      name,
      `${field} needs a rep's approval on the review page; nothing else can approve it`,
    );
  }
  if (approval.proposalId !== request.proposalId || approval.field !== field) {
    return refuse("approval_mismatch", name, `the approval on record is not for ${field} of this proposal`);
  }
  if (!isPerson(approval.approver)) {
    return refuse("approver_not_a_person", name, `the approval for ${field} was not made by a signed-in person`);
  }
  if (approval.decision === "reject") {
    return refuse("rejected_by_rep", name, `${approval.approver} rejected the proposed ${field}`);
  }
  if (approval.value !== value) {
    return refuse("approval_mismatch", name, `the approval for ${field} is for a different value`);
  }

  if (!request.before.known) {
    return refuse(
      "before_unknown",
      name,
      `there is no record of ${field} from when the proposal was drafted, so a newer edit cannot be ruled out`,
    );
  }
  if (!request.current.known) {
    return refuse("current_unknown", name, `the current ${field} in Salesforce could not be read`);
  }
  if (normalizeValue(request.current.value) !== normalizeValue(request.before.value)) {
    return refuse(
      "stale",
      name,
      `${field} changed in Salesforce after the proposal was drafted; the write is stale`,
    );
  }

  return {
    allowed: true,
    code: "approved",
    rule: name,
    reason: `${field} approved by ${approval.approver} and unchanged in Salesforce since the proposal`,
  };
}
