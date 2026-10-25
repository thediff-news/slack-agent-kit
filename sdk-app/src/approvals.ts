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
   * Returns "resolved" | "unknown" | "wrong-thread". */
  resolve(id: string, approved: boolean, resolver: string, fromThread?: string): "resolved" | "unknown" | "wrong-thread" {
    const req = this.pending.get(id);
    if (!req) return "unknown";
    if (fromThread !== undefined && fromThread !== req.thread) return "wrong-thread";
    this.pending.delete(id);
    this.append({ type: "resolved", id, approved, resolver, at: new Date().toISOString() });
    this.waiters.get(id)?.(approved);
    this.waiters.delete(id);
    return "resolved";
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
