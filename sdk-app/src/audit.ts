import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Append-only audit log: one JSON event per line. Every message in/out,
 * tool call, permission decision and per-turn cost lands here. */
export type AuditEvent = {
  ts: string;
  kind:
    | "message_in" | "message_out" | "tool_call" | "tool_result"
    | "approval_requested" | "approval_resolved" | "turn_cost" | "error";
  thread?: string;
  detail: Record<string, unknown>;
};

export class AuditLog {
  constructor(private path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }
  write(kind: AuditEvent["kind"], detail: Record<string, unknown>, thread?: string): void {
    const ev: AuditEvent = { ts: new Date().toISOString(), kind, detail, ...(thread ? { thread } : {}) };
    appendFileSync(this.path, JSON.stringify(ev) + "\n");
  }
}
