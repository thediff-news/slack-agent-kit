import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";

/** Append-only audit log with a hash chain (ported from the kit's durable
 * core): each entry commits to the previous entry's hash, so a tampered or
 * deleted line breaks verification. Every message in/out, tool call,
 * permission decision, approval and per-turn cost lands here. */
export type AuditEvent = {
  seq: number;
  ts: string;
  kind:
    | "message_in" | "message_out" | "tool_call" | "tool_result"
    | "approval_requested" | "approval_resolved" | "turn_cost" | "error"
    | "identity_denied" | "channel_denied" | "capability_denied" | "checkpoint_refused" | "turn_cancelled" | "image_in" | "image_out"
    | "escalation" | "message_dropped";
  thread?: string;
  detail: Record<string, unknown>;
  prevHash: string;
  hash: string;
};

const hashOf = (e: Omit<AuditEvent, "hash">): string =>
  createHash("sha256").update(JSON.stringify(e)).digest("hex");

export class AuditLog {
  private lastHash = "genesis";
  private seq = 0;

  constructor(public readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
      const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
      if (lines.length) {
        const last = JSON.parse(lines[lines.length - 1]) as AuditEvent;
        this.lastHash = last.hash;
        this.seq = last.seq;
      }
    }
  }

  write(kind: AuditEvent["kind"], detail: Record<string, unknown>, thread?: string): void {
    const base: Omit<AuditEvent, "hash"> = {
      seq: this.seq + 1, ts: new Date().toISOString(), kind,
      ...(thread ? { thread } : {}), detail, prevHash: this.lastHash,
    };
    const ev: AuditEvent = { ...base, hash: hashOf(base) };
    appendFileSync(this.path, JSON.stringify(ev) + "\n");
    this.lastHash = ev.hash;
    this.seq = ev.seq;
  }

  /** Verify the whole chain; returns the first broken seq or null when intact. */
  static verify(path: string): number | null {
    if (!existsSync(path)) return null;
    let prev = "genesis";
    for (const [i, line] of readFileSync(path, "utf8").trim().split("\n").filter(Boolean).entries()) {
      const ev = JSON.parse(line) as AuditEvent;
      if (ev.seq !== i + 1 || ev.prevHash !== prev || ev.hash !== hashOf({ ...ev, hash: undefined as never } as any)) return ev.seq;
      prev = ev.hash;
    }
    return null;
  }
}
