import { describe, expect, it } from "vitest";
import rawPolicy from "../../../policy/opportunity.json";
import {
  MAX_VALUE_LENGTH,
  UNKNOWN,
  evaluateWrite,
  known,
  normalizeValue,
  parsePolicy,
  readableFields,
  ruleFor,
  type ApprovalRecord,
  type ReasonCode,
  type WriteRequest,
} from "../src/policy";

const policy = parsePolicy(rawPolicy);

const MEDDPICC = [
  "Metrics__c",
  "Economic_Buyer__c",
  "Decision_Criteria__c",
  "Decision_Process__c",
  "Paper_Process__c",
  "Identified_Pain__c",
  "Champion__c",
  "Competition__c",
];
const FORECAST = ["CloseDate", "Amount", "StageName", "ForecastCategoryName"];

const approvalFor = (field: string, value: string | null, extra: Partial<ApprovalRecord> = {}): ApprovalRecord => ({
  proposalId: "p1",
  field,
  decision: "approve",
  value,
  approver: "user:rep@example.test",
  ...extra,
});

/** A request that is allowed. Each test changes one thing about it. */
const good = (extra: Partial<WriteRequest> = {}): WriteRequest => ({
  proposalId: "p1",
  field: "Champion__c",
  value: "Priya Raman, VP Operations",
  approval: approvalFor("Champion__c", "Priya Raman, VP Operations"),
  before: known(null),
  current: known(null),
  ...extra,
});

describe("the policy file", () => {
  it("parses, and names the eight MEDDPICC fields and the four forecast fields", () => {
    expect([...policy.rules.rep_approval].sort()).toEqual([...MEDDPICC].sort());
    expect([...policy.rules.manager_approval].sort()).toEqual([...FORECAST].sort());
    expect(policy.rules.deny).toEqual([]);
  });

  it("has a hash that does not depend on key order", () => {
    const { rules, ...rest } = rawPolicy;
    const reordered = { rules, ...rest };
    expect(policy.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(parsePolicy(reordered).hash).toBe(policy.hash);
  });

  it("has a different hash when a rule changes", () => {
    const changed = { ...rawPolicy, rules: { ...rawPolicy.rules, manager_approval: ["CloseDate"] } };
    expect(parsePolicy(changed).hash).not.toBe(policy.hash);
  });

  it.each([
    ["not an object", "nope"],
    ["an array", []],
    ["a newer version", { ...rawPolicy, version: 2 }],
    ["another object", { ...rawPolicy, object: "Account" }],
    ["a default other than deny", { ...rawPolicy, default: "allow" }],
    ["a missing default", { ...rawPolicy, default: undefined }],
    ["an unknown top-level key", { ...rawPolicy, auto: ["Metrics__c"] }],
    ["an unknown rule", { ...rawPolicy, rules: { ...rawPolicy.rules, auto: ["Metrics__c"] } }],
    ["rules that are not an object", { ...rawPolicy, rules: ["Metrics__c"] }],
    ["a rule that is not a list", { ...rawPolicy, rules: { rep_approval: "Metrics__c" } }],
    ["a wildcard field", { ...rawPolicy, rules: { rep_approval: ["*"] } }],
    ["a field with a space", { ...rawPolicy, rules: { rep_approval: ["Close Date"] } }],
    ["a relationship field under a write rule", { ...rawPolicy, rules: { rep_approval: ["Account.Name"] } }],
    ["a non-string field", { ...rawPolicy, rules: { rep_approval: [7] } }],
    ["a bad read-only name", { ...rawPolicy, read_only: ["Name; DROP"] }],
  ])("rejects %s", (_label, raw) => {
    expect(() => parsePolicy(raw)).toThrow();
  });
});

describe("ruleFor", () => {
  it.each(MEDDPICC)("%s needs rep approval", (field) => {
    expect(ruleFor(policy, field)).toEqual({ rule: "rep_approval", name: "rules.rep_approval" });
  });

  it.each(FORECAST)("%s needs manager approval", (field) => {
    expect(ruleFor(policy, field)).toEqual({ rule: "manager_approval", name: "rules.manager_approval" });
  });

  it.each(["OwnerId", "Name", "Description", "NextStep", "metrics__c", "Metrics__C", ""])(
    "%j falls to the default and is denied",
    (field) => {
      expect(ruleFor(policy, field)).toEqual({ rule: "deny", name: "default.deny" });
    },
  );

  it("picks the most restrictive rule when a field is listed twice", () => {
    const both = parsePolicy({
      ...rawPolicy,
      rules: { rep_approval: ["Metrics__c", "Champion__c"], manager_approval: ["Metrics__c"], deny: ["Champion__c"] },
    });
    expect(ruleFor(both, "Metrics__c").rule).toBe("manager_approval");
    expect(ruleFor(both, "Champion__c")).toEqual({ rule: "deny", name: "rules.deny" });
  });
});

describe("readableFields", () => {
  it("is the governed fields plus the read-only ones", () => {
    expect(readableFields(policy).sort()).toEqual([...MEDDPICC, ...FORECAST, "Name", "Account.Name"].sort());
  });

  it("leaves out a denied field even if another list names it", () => {
    const denied = parsePolicy({ ...rawPolicy, rules: { ...rawPolicy.rules, deny: ["Amount"] } });
    expect(readableFields(denied)).not.toContain("Amount");
  });
});

describe("evaluateWrite", () => {
  it("allows an approved, unchanged MEDDPICC field", () => {
    expect(evaluateWrite(policy, good())).toMatchObject({ allowed: true, code: "approved", rule: "rules.rep_approval" });
  });

  it.each(MEDDPICC)("allows %s with a matching approval", (field) => {
    const request = good({ field, value: "v", approval: approvalFor(field, "v") });
    expect(evaluateWrite(policy, request).allowed).toBe(true);
  });

  it.each(FORECAST)("refuses %s even with an approval record for it", (field) => {
    const request = good({ field, value: "2027-01-15", approval: approvalFor(field, "2027-01-15") });
    expect(evaluateWrite(policy, request)).toMatchObject({
      allowed: false,
      code: "needs_manager_approval",
      rule: "rules.manager_approval",
    });
  });

  const refusals: [string, Partial<WriteRequest>, ReasonCode, string][] = [
    ["a field no rule names", { field: "OwnerId", approval: approvalFor("OwnerId", "x"), value: "x" }, "field_denied", "default.deny"],
    ["a field name with a dot", { field: "Account.Name" }, "invalid_field", "target.invalid"],
    ["a field name that is an injection attempt", { field: "Champion__c = 'x'" }, "invalid_field", "target.invalid"],
    ["an empty field name", { field: "" }, "invalid_field", "target.invalid"],
    ["a non-string value", { value: 42 }, "invalid_value", "rules.rep_approval"],
    ["an empty value", { value: "" }, "invalid_value", "rules.rep_approval"],
    ["a whitespace-only value", { value: "  \n " }, "invalid_value", "rules.rep_approval"],
    ["a value over the field limit", { value: "x".repeat(MAX_VALUE_LENGTH + 1) }, "invalid_value", "rules.rep_approval"],
    ["no approval record", { approval: null }, "needs_rep_approval", "rules.rep_approval"],
    ["an approval for another proposal", { approval: approvalFor("Champion__c", "Priya Raman, VP Operations", { proposalId: "p2" }) }, "approval_mismatch", "rules.rep_approval"],
    ["an approval for another field", { approval: approvalFor("Metrics__c", "Priya Raman, VP Operations") }, "approval_mismatch", "rules.rep_approval"],
    ["an approval for another value", { approval: approvalFor("Champion__c", "Someone else") }, "approval_mismatch", "rules.rep_approval"],
    ["an approval that differs only by trailing space", { approval: approvalFor("Champion__c", "Priya Raman, VP Operations ") }, "approval_mismatch", "rules.rep_approval"],
    ["an approval made by an agent", { approval: approvalFor("Champion__c", "Priya Raman, VP Operations", { approver: "agent:meddpicc" }) }, "approver_not_a_person", "rules.rep_approval"],
    ["an approval with no approver", { approval: approvalFor("Champion__c", "Priya Raman, VP Operations", { approver: "" }) }, "approver_not_a_person", "rules.rep_approval"],
    ["a rejection", { approval: approvalFor("Champion__c", null, { decision: "reject" }) }, "rejected_by_rep", "rules.rep_approval"],
    ["an unknown before value", { before: UNKNOWN }, "before_unknown", "rules.rep_approval"],
    ["an unknown current value", { current: UNKNOWN }, "current_unknown", "rules.rep_approval"],
    ["a field edited in Salesforce since the proposal", { current: known("Edited by a person") }, "stale", "rules.rep_approval"],
    ["a field emptied in Salesforce since the proposal", { before: known("Old"), current: known(null) }, "stale", "rules.rep_approval"],
  ];

  it.each(refusals)("refuses %s", (_label, change, code, rule) => {
    const decision = evaluateWrite(policy, good(change));
    expect(decision).toMatchObject({ allowed: false, code, rule });
    expect(decision.reason).not.toBe("");
  });

  it("accepts an edit decision the same way as an approval", () => {
    const request = good({ approval: approvalFor("Champion__c", "Priya Raman, VP Operations", { decision: "edit" }) });
    expect(evaluateWrite(policy, request).allowed).toBe(true);
  });

  it("accepts the local dev identity as a person", () => {
    const request = good({ approval: approvalFor("Champion__c", "Priya Raman, VP Operations", { approver: "dev:rep@example.test" }) });
    expect(evaluateWrite(policy, request).allowed).toBe(true);
  });

  it("checks the policy rule before the approval, so a forecast field never reports a missing approval", () => {
    const decision = evaluateWrite(policy, good({ field: "CloseDate", approval: null, before: UNKNOWN, current: UNKNOWN }));
    expect(decision.code).toBe("needs_manager_approval");
  });

  it("is not stale when Salesforce only changed empty-vs-null, line endings or outer whitespace", () => {
    expect(evaluateWrite(policy, good({ before: known(null), current: known("") })).allowed).toBe(true);
    expect(evaluateWrite(policy, good({ before: known("a\r\nb "), current: known("a\nb") })).allowed).toBe(true);
  });

  it("is stale when the text itself changed", () => {
    expect(evaluateWrite(policy, good({ before: known("a b"), current: known("a  b") })).code).toBe("stale");
  });

  it("overwrites an existing value when it is unchanged since the proposal", () => {
    expect(evaluateWrite(policy, good({ before: known("Old champion"), current: known("Old champion") })).allowed).toBe(true);
  });

  it("is a pure function: the same request gives the same answer and is not changed", () => {
    const request = good();
    const copy = structuredClone(request);
    expect(evaluateWrite(policy, request)).toEqual(evaluateWrite(policy, request));
    expect(request).toEqual(copy);
  });
});

describe("normalizeValue", () => {
  it.each([
    [null, ""],
    [undefined, ""],
    ["", ""],
    ["  a  ", "a"],
    ["a\r\nb\rc", "a\nb\nc"],
  ])("%j becomes %j", (input, output) => {
    expect(normalizeValue(input)).toBe(output);
  });
});
