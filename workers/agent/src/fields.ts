import policy from "../../../policy/opportunity.json";

/** The eight MEDDPICC fields, in the order a rep reads them. */
export const MEDDPICC_FIELDS = [
  { field: "Metrics__c", label: "Metrics" },
  { field: "Economic_Buyer__c", label: "Economic Buyer" },
  { field: "Decision_Criteria__c", label: "Decision Criteria" },
  { field: "Decision_Process__c", label: "Decision Process" },
  { field: "Paper_Process__c", label: "Paper Process" },
  { field: "Identified_Pain__c", label: "Identified Pain" },
  { field: "Champion__c", label: "Champion" },
  { field: "Competition__c", label: "Competition" },
] as const;

export type MeddpiccField = (typeof MEDDPICC_FIELDS)[number]["field"];

export const FIELD_NAMES: readonly string[] = MEDDPICC_FIELDS.map((f) => f.field);

/**
 * Forecast fields the agent listens for in a call but never proposes. When a
 * call says one changed, the agent asks the gatekeeper, which refuses: these
 * need a manager.
 */
export const FORECAST_SIGNALS = [{ field: "CloseDate", label: "Close Date" }] as const;

export const SIGNAL_NAMES: readonly string[] = FORECAST_SIGNALS.map((f) => f.field);

export const labelFor = (field: string): string =>
  [...MEDDPICC_FIELDS, ...FORECAST_SIGNALS].find((f) => f.field === field)?.label ?? field;

// The agent only ever proposes fields a rep may approve. If this list and the
// policy file drift apart, fail at load rather than propose something the
// gatekeeper will refuse.
const approvable = new Set<string>(policy.rules.rep_approval);
if (approvable.size !== FIELD_NAMES.length || !FIELD_NAMES.every((field) => approvable.has(field))) {
  throw new Error("fields.ts and policy/opportunity.json disagree about the MEDDPICC fields");
}
const managerOnly = new Set<string>(policy.rules.manager_approval);
if (!SIGNAL_NAMES.every((field) => managerOnly.has(field))) {
  throw new Error("fields.ts lists a forecast signal that policy/opportunity.json does not put under manager_approval");
}
