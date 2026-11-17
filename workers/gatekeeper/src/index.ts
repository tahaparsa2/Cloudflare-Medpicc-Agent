import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  ApprovedUpdateRequest,
  AuditQuery,
  AuditRow,
  DecisionRequest,
  DecisionResult,
  FieldResult,
  FieldUpdateRequest,
  GatekeeperEnv,
  ProposalLogRequest,
  ProposalLogResult,
  PersonEvidence,
  ReadRequest,
  ReadResult,
  SalesforceGatekeeperApi,
  VerifyResult,
  WhoResult,
} from "./types";

export { SalesforceGatekeeper } from "./salesforce";
export type * from "./types";

/**
 * Worker B: the gatekeeper. The agent Worker calls these methods over a service
 * binding. Nothing here is reachable from the internet. Every call goes to one
 * Durable Object, which holds the credential, the approvals and the audit log.
 */
export default class GatekeeperEntrypoint
  extends WorkerEntrypoint<GatekeeperEnv>
  implements SalesforceGatekeeperApi
{
  private get gatekeeper() {
    return this.env.GATEKEEPER.getByName("salesforce");
  }

  async whoIs(evidence: PersonEvidence): Promise<WhoResult> {
    return this.gatekeeper.whoIs(evidence);
  }

  async readOpportunity(request: ReadRequest): Promise<ReadResult> {
    return this.gatekeeper.readOpportunity(request);
  }

  async recordDecision(request: DecisionRequest): Promise<DecisionResult> {
    return this.gatekeeper.recordDecision(request);
  }

  async applyApprovedUpdate(request: ApprovedUpdateRequest): Promise<FieldResult[]> {
    return this.gatekeeper.applyApprovedUpdate(request);
  }

  async requestFieldUpdate(request: FieldUpdateRequest): Promise<FieldResult> {
    return this.gatekeeper.requestFieldUpdate(request);
  }

  async logProposal(request: ProposalLogRequest): Promise<ProposalLogResult> {
    return this.gatekeeper.logProposal(request);
  }

  async listAudit(query?: AuditQuery): Promise<AuditRow[]> {
    return this.gatekeeper.listAudit(query);
  }

  async verifyAudit(): Promise<VerifyResult> {
    return this.gatekeeper.verifyAudit();
  }

  /** No HTTP surface. A stray request gets a 404, not a hint. */
  override async fetch(): Promise<Response> {
    return new Response("Not found", { status: 404 });
  }
}
