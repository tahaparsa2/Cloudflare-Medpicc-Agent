import { describe, expect, it } from "vitest";
import { readFixture } from "./helpers";

/**
 * The gatekeeper runs as an integration user whose only access is the
 * MEDDPICC_Gatekeeper permission set. An admin user hides a gap in it, because
 * an admin can read everything. This checks the permission set against the
 * policy file, so a field the gatekeeper reads or writes is never left out.
 */

const policy = JSON.parse(readFixture("policy/opportunity.json")) as {
  rules: { rep_approval: string[]; manager_approval: string[] };
  read_only: string[];
};
const xml = readFixture("salesforce/main/default/permissionsets/MEDDPICC_Gatekeeper.permissionset-meta.xml");

const fieldPermissions = new Map(
  [...xml.matchAll(/<fieldPermissions>([\s\S]*?)<\/fieldPermissions>/g)].map((match) => {
    const block = match[1]!;
    const tag = (name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(block)?.[1];
    return [tag("field")!, { readable: tag("readable") === "true", editable: tag("editable") === "true" }];
  }),
);
const objectPermissions = new Map(
  [...xml.matchAll(/<objectPermissions>([\s\S]*?)<\/objectPermissions>/g)].map((match) => {
    const block = match[1]!;
    const tag = (name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(block)?.[1];
    return [tag("object")!, { read: tag("allowRead") === "true", edit: tag("allowEdit") === "true" }];
  }),
);

/** Standard fields Salesforce does not let a permission set grant or lock: every user who can read the object reads them. */
const NOT_PERMISSIONABLE = new Set(["Name", "CloseDate", "StageName", "ForecastCategoryName"]);

describe("the MEDDPICC_Gatekeeper permission set", () => {
  it("lets the gatekeeper read and edit opportunities, and read accounts", () => {
    expect(objectPermissions.get("Opportunity")).toEqual({ read: true, edit: true });
    expect(objectPermissions.get("Account")).toMatchObject({ read: true, edit: false });
  });

  it.each(policy.rules.rep_approval)("grants read and edit on %s, which a rep can approve", (field) => {
    expect(fieldPermissions.get(`Opportunity.${field}`)).toEqual({ readable: true, editable: true });
  });

  it.each(policy.rules.manager_approval.filter((field) => !NOT_PERMISSIONABLE.has(field)))(
    "grants read but not edit on %s, a forecast field",
    (field) => {
      expect(fieldPermissions.get(`Opportunity.${field}`)).toEqual({ readable: true, editable: false });
    },
  );

  it.each(policy.read_only.filter((field) => field.includes(".")))("grants read on the link behind %s", (field) => {
    // Account.Name is read through Opportunity.AccountId. Without read on that
    // link Salesforce answers "No such relation 'Account' on entity 'Opportunity'".
    const relation = field.split(".")[0]!;
    expect(fieldPermissions.get(`Opportunity.${relation}Id`)).toMatchObject({ readable: true });
    expect(objectPermissions.get(relation)).toMatchObject({ read: true });
  });

  it("grants edit on nothing but the eight MEDDPICC fields", () => {
    const editable = [...fieldPermissions].filter(([, permission]) => permission.editable).map(([field]) => field.replace("Opportunity.", ""));
    expect(editable.sort()).toEqual([...policy.rules.rep_approval].sort());
  });
});
