import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FieldResult, FieldUpdateRequest, ProposalLogRequest, ProposalLogResult, ReadRequest, ReadResult } from "../../gatekeeper/src/types";
import { ANSWER_KEYS } from "../src/extraction";
import { FIELD_NAMES } from "../src/fields";
import type { ModelClient, Recording } from "../src/model";

const root = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url).href);
export const readFixture = (path: string): string => readFileSync(root(path), "utf8");

export const CONTEXT = readFixture("context/meddpicc.md");
export const CALL_1 = readFixture("fixtures/calls/call-1.txt");
export const CALL_2 = readFixture("fixtures/calls/call-2.txt");
export const recording = (id: string): Recording => JSON.parse(readFixture(`fixtures/recorded/${id}.json`)) as Recording;

export const OPP = "006000000000001AAA";

/** A model answer in the schema's shape: every key present, empty unless given. */
export function answer(given: Record<string, { value: string; quotes: string[] }>): Record<string, { value: string; quotes: string[] }> {
  return Object.fromEntries(ANSWER_KEYS.map((field) => [field, given[field] ?? { value: "", quotes: [] }]));
}

export function fixedModel(output: unknown, id = "test-model"): ModelClient & { calls: number } {
  const model = {
    id,
    calls: 0,
    async extract() {
      model.calls += 1;
      return { output, modelId: id, gatewayLogId: "log-1" };
    },
  };
  return model;
}

/** Stands in for the gatekeeper binding. Records what the agent asked of it. */
export class FakeGatekeeper {
  fields: Record<string, string | null> = {
    Name: "Tessaline Freight - New Business",
    "Account.Name": "Tessaline Freight",
    CloseDate: "2026-12-18",
    ...Object.fromEntries(FIELD_NAMES.map((field) => [field, null])),
  };
  failRead: string | null = null;
  failLog: string | null = null;
  reads: ReadRequest[] = [];
  logs: ProposalLogRequest[] = [];
  requests: FieldUpdateRequest[] = [];

  async readOpportunity(request: ReadRequest): Promise<ReadResult> {
    this.reads.push(request);
    if (this.failRead) return { ok: false, reason: this.failRead, auditSeq: 1 };
    return { ok: true, opportunityId: request.opportunityId, snapshotId: "snapshot-1", fields: { ...this.fields }, auditSeq: 1 };
  }

  /** Answers as the real gatekeeper does for a forecast field: refused, with the rule and an audit row. */
  async requestFieldUpdate(request: FieldUpdateRequest): Promise<FieldResult> {
    this.requests.push(request);
    return {
      field: request.field,
      outcome: "refused",
      code: "needs_manager_approval",
      rule: "rules.manager_approval",
      reason: `${request.field} is a forecast field: needs manager approval, which this demo does not build`,
      auditSeq: 7,
    };
  }

  async logProposal(request: ProposalLogRequest): Promise<ProposalLogResult> {
    this.logs.push(request);
    if (this.failLog) return { ok: false, reason: this.failLog, auditSeq: 2 };
    return { ok: true, auditSeqs: [2] };
  }
}
