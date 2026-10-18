import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, existsSync } from "node:fs";

export interface AuditEntry {
  seq: number;
  ts: string;
  kind: string;
  actor: string;
  detail: string;
  prevHash: string;
  hash: string;
}

/**
 * Append-only audit log with a hash chain: each entry commits to the hash
 * of the previous one, so a tampered or deleted line breaks verification.
 * Every event, permission decision, approval and execution is logged here.
 */
export class AuditLog {
  private path: string;
  private lastHash = "genesis";
  private seq = 0;

  constructor(path: string) {
    this.path = path;
    if (existsSync(path)) {
      const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
      if (lines.length > 0) {
        const last = JSON.parse(lines[lines.length - 1]) as AuditEntry;
        this.lastHash = last.hash;
        this.seq = last.seq;
      }
    }
  }

  record(kind: string, actor: string, detail: string): AuditEntry {
    const entry: AuditEntry = {
      seq: this.seq + 1,
      ts: new Date().toISOString(),
      kind, actor, detail,
      prevHash: this.lastHash,
      hash: "",
    };
    entry.hash = createHash("sha256")
      .update(`${entry.seq}|${entry.ts}|${kind}|${actor}|${detail}|${entry.prevHash}`)
      .digest("hex");
    appendFileSync(this.path, JSON.stringify(entry) + "\n");
    this.lastHash = entry.hash;
    this.seq = entry.seq;
    return entry;
  }

  /** Verify the chain; returns the sequence number of the first bad entry, or null. */
  static verify(path: string): number | null {
    if (!existsSync(path)) return null;
    let prevHash = "genesis";
    const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
    for (const line of lines) {
      const e = JSON.parse(line) as AuditEntry;
      const expect = createHash("sha256")
        .update(`${e.seq}|${e.ts}|${e.kind}|${e.actor}|${e.detail}|${prevHash}`)
        .digest("hex");
      if (e.hash !== expect || e.prevHash !== prevHash) return e.seq;
      prevHash = e.hash;
    }
    return null;
  }
}
