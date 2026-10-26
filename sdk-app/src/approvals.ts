import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID, createHash } from "node:crypto";

/** Approval ledger (JSONL, append-only). A request binds:
 *  - the exact tool + payload (sha256 of the canonical input), so a retried
 *    tool call with a changed payload needs a NEW approval;
 *  - the conversation thread it was requested in - a resolution from any
 *    other thread is rejected;
 *  - the resolver's identity (surface-checked: Slack adapter enforces the
 *    named-approver allowlist; the CLI harness is the local owner).
 *  Each request resolves exactly once; pending requests survive restart. */
export type ApprovalRequest = {
  id: string;
  tool: string;
  summary: string;
  input: Record<string, unknown>;
  payloadHash: string;
  thread: string;
  createdAt: string;
};

export const payloadHashOf = (input: Record<string, unknown>): string =>
  createHash("sha256").update(JSON.stringify(input, Object.keys(input).sort())).digest("hex");

type LogRow =
  | { type: "requested"; req: ApprovalRequest }
  | { type: "resolved"; id: string; approved: boolean; resolver: string; at: string };

export class ApprovalStore {
  private pending = new Map<string, ApprovalRequest>();
  private waiters = new Map<string, (approved: boolean) => void>();

  constructor(private logPath: string) {
    mkdirSync(dirname(logPath), { recursive: true });
    if (existsSync(logPath)) {
      for (const line of readFileSync(logPath, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const row = JSON.parse(line) as LogRow;
        if (row.type === "requested") this.pending.set(row.req.id, row.req);
        else this.pending.delete(row.id);
      }
    }
  }

  request(tool: string, input: Record<string, unknown>, summary: string, thread: string): { req: ApprovalRequest; decision: Promise<boolean> } {
    const req: ApprovalRequest = {
      id: randomUUID().slice(0, 8), tool, summary, input,
      payloadHash: payloadHashOf(input), thread, createdAt: new Date().toISOString(),
    };
    this.append({ type: "requested", req });
    this.pending.set(req.id, req);
    const decision = new Promise<boolean>((res) => this.waiters.set(req.id, res));
    return { req, decision };
  }

  /** Resolve exactly once, and only from the thread the request was made in.
   * Returns "resolved" | "unknown" | "wrong-thread"; on "resolved", `resumed`
   * tells whether a live turn consumed the decision (false after a restart -
   * the caller should tell the thread the decision landed but the original
   * turn is gone). */
  resolve(id: string, approved: boolean, resolver: string, fromThread?: string): { status: "resolved" | "unknown" | "wrong-thread"; resumed: boolean } {
    const req = this.pending.get(id);
    if (!req) return { status: "unknown", resumed: false };
    if (fromThread !== undefined && fromThread !== req.thread) return { status: "wrong-thread", resumed: false };
    this.pending.delete(id);
    this.append({ type: "resolved", id, approved, resolver, at: new Date().toISOString() });
    const waiter = this.waiters.get(id);
    this.waiters.delete(id);
    waiter?.(approved);
    return { status: "resolved", resumed: waiter !== undefined };
  }

  /** Re-check that a payload still matches what was approved (ledger audit). */
  payloadMatches(id: string, input: Record<string, unknown>): boolean {
    return this.pending.get(id)?.payloadHash === payloadHashOf(input);
  }

  list(): ApprovalRequest[] {
    return [...this.pending.values()];
  }

  private append(row: LogRow): void {
    appendFileSync(this.logPath, JSON.stringify(row) + "\n");
  }
}
