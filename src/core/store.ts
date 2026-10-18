/**
 * DurableStore: every piece of state the agent touches goes through here.
 * Nothing is shown or executed before its record is committed - the
 * replay-safety rule this kit borrows from pi-durable's design.
 *
 * Two implementations ship:
 *  - SqliteStore (default, zero-config)
 *  - PiDurableStore (src/core/store-pi.ts) on @earendil-works/pi-durable
 * The interface is deliberately small so the experimental pi-durable API
 * can be swapped out without touching skills, approvals or adapters.
 */
export interface Approval {
  id: string;
  actionKey: string;
  summary: string;
  requestedBy: string;
  requestedAt: string;
  status: "pending" | "approved" | "denied" | "expired";
  resolvedBy?: string;
  resolvedAt?: string;
}

export interface DurableStore {
  recordEvent(id: string, source: string, kind: string, actorId: string, payload: string): Promise<"new" | "duplicate">;
  createApproval(a: Approval): Promise<void>;
  getApproval(id: string): Promise<Approval | undefined>;
  pendingApprovals(): Promise<Approval[]>;
  /** Returns false when already resolved - the one-decision rule. */
  resolveApproval(id: string, decision: "approved" | "denied", by: string): Promise<boolean>;
  hasExecuted(actionKey: string): Promise<boolean>;
  markExecuted(actionKey: string, resultSummary: string): Promise<void>;
  get(scope: string, key: string): Promise<string | undefined>;
  set(scope: string, key: string, value: string): Promise<void>;
  close(): Promise<void>;
}
