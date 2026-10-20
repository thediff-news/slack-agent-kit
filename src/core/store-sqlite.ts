import Database from "better-sqlite3";
import type { Approval, DurableStore } from "./store.js";

export class SqliteStore implements DurableStore {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, source TEXT, kind TEXT, actor_id TEXT,
        payload TEXT, recorded_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY, action_key TEXT UNIQUE, summary TEXT,
        requested_by TEXT, requested_at TEXT,
        status TEXT, resolved_by TEXT, resolved_at TEXT
      );
      CREATE TABLE IF NOT EXISTS executions (
        action_key TEXT PRIMARY KEY, result_summary TEXT,
        executed_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS kv (
        scope TEXT, key TEXT, value TEXT, PRIMARY KEY (scope, key)
      );
    `);
  }

  async recordEvent(id: string, source: string, kind: string, actorId: string, payload: string): Promise<"new" | "duplicate"> {
    const res = this.db
      .prepare("INSERT OR IGNORE INTO events (id, source, kind, actor_id, payload) VALUES (?,?,?,?,?)")
      .run(id, source, kind, actorId, payload);
    return res.changes === 1 ? "new" : "duplicate";
  }

  async createApproval(a: Approval): Promise<void> {
    this.db
      .prepare("INSERT OR IGNORE INTO approvals (id, action_key, summary, requested_by, requested_at, status) VALUES (?,?,?,?,?,?)")
      .run(a.id, a.actionKey, a.summary, a.requestedBy, a.requestedAt, a.status);
  }

  async getApproval(id: string): Promise<Approval | undefined> {
    const row = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as any;
    return row ? rowToApproval(row) : undefined;
  }

  async pendingApprovals(): Promise<Approval[]> {
    const rows = this.db.prepare("SELECT * FROM approvals WHERE status = 'pending'").all() as any[];
    return rows.map(rowToApproval);
  }

  async resolveApproval(id: string, decision: "approved" | "denied", by: string): Promise<boolean> {
    const res = this.db
      .prepare("UPDATE approvals SET status = ?, resolved_by = ?, resolved_at = datetime('now') WHERE id = ? AND status = 'pending'")
      .run(decision, by, id);
    return res.changes === 1;
  }

  async hasExecuted(actionKey: string): Promise<boolean> {
    return !!this.db.prepare("SELECT 1 FROM executions WHERE action_key = ?").get(actionKey);
  }

  async markExecuted(actionKey: string, resultSummary: string): Promise<void> {
    this.db
      .prepare("INSERT OR IGNORE INTO executions (action_key, result_summary) VALUES (?,?)")
      .run(actionKey, resultSummary);
  }

  async get(scope: string, key: string): Promise<string | undefined> {
    const row = this.db.prepare("SELECT value FROM kv WHERE scope = ? AND key = ?").get(scope, key) as any;
    return row?.value;
  }

  async set(scope: string, key: string, value: string): Promise<void> {
    this.db
      .prepare("INSERT INTO kv (scope, key, value) VALUES (?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value = excluded.value")
      .run(scope, key, value);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

function rowToApproval(r: any): Approval {
  return {
    id: r.id, actionKey: r.action_key, summary: r.summary,
    requestedBy: r.requested_by, requestedAt: r.requested_at,
    status: r.status,
    ...(r.resolved_by != null ? { resolvedBy: r.resolved_by } : {}),
    ...(r.resolved_at != null ? { resolvedAt: r.resolved_at } : {}),
  };
}
