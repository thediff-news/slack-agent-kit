import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

/** Durable-ish approval ledger: every request and every resolution is
 * appended to a JSONL log, so pending approvals survive a restart and each
 * request resolves exactly once (kit semantics, rebuilt for the SDK app).
 * Slack/CLI surfaces call resolve(); the SDK canUseTool gate awaits it. */
export type ApprovalRequest = {
  id: string;
  tool: string;
  summary: string;
  input: Record<string, unknown>;
  createdAt: string;
};

type LogRow =
  | { type: "requested"; req: ApprovalRequest }
  | { type: "resolved"; id: string; approved: boolean; resolver: string; at: string };

export class ApprovalStore {
  private pending = new Map<string, ApprovalRequest>();
  private waiters = new Map<string, (approved: boolean) => void>();

  constructor(private logPath: string) {
    mkdirSync(dirname(logPath), { recursive: true });
    if (existsSync(logPath)) {
      const resolved = new Set<string>();
      for (const line of readFileSync(logPath, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const row = JSON.parse(line) as LogRow;
        if (row.type === "requested") this.pending.set(row.req.id, row.req);
        else { this.pending.delete(row.id); resolved.add(row.id); }
      }
    }
  }

  /** Register a new approval request; await the returned promise for the human decision. */
  request(tool: string, input: Record<string, unknown>, summary: string): { req: ApprovalRequest; decision: Promise<boolean> } {
    const req: ApprovalRequest = { id: randomUUID().slice(0, 8), tool, summary, input, createdAt: new Date().toISOString() };
    this.append({ type: "requested", req });
    this.pending.set(req.id, req);
    const decision = new Promise<boolean>((res) => this.waiters.set(req.id, res));
    return { req, decision };
  }

  /** Resolve exactly once. Returns false when the id is unknown or already resolved. */
  resolve(id: string, approved: boolean, resolver: string): boolean {
    if (!this.pending.has(id)) return false;
    this.pending.delete(id);
    this.append({ type: "resolved", id, approved, resolver, at: new Date().toISOString() });
    this.waiters.get(id)?.(approved);
    this.waiters.delete(id);
    return true;
  }

  /** Pending requests, e.g. resurfaced after a restart. */
  list(): ApprovalRequest[] {
    return [...this.pending.values()];
  }

  private append(row: LogRow): void {
    appendFileSync(this.logPath, JSON.stringify(row) + "\n");
  }
}
