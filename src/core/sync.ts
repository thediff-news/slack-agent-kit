import { createHash } from "node:crypto";
import type { Connector, SyncableConnector, SyncedDoc } from "../connectors/types.js";
import { isSyncable } from "../connectors/types.js";
import type { DurableStore } from "./store.js";
import type { AuditLog } from "./audit.js";
import type { Rag } from "../rag/rag.js";
import type { ProposedAction } from "./skills.js";
import { actionKey } from "./runtime.js";

export interface SyncResult {
  connector: string;
  listed: number;
  ingested: number;
  skipped: number;
  deleted: number;
  gated: string[];
  error?: string;
}

interface DocState { hash: string; acl: string }
interface ConnectorSyncState {
  /** One-time human approval for automatic sync of this connector. */
  approved: boolean;
  /** ISO timestamp backing off re-asks after a denial. */
  gateAskedAt?: string;
  /** High-water mark of source-side lastModified, for incremental listings. */
  cursor?: string;
  /** docId -> last indexed content hash + ACL. */
  docs: Record<string, DocState>;
  /** docId -> ISO timestamp when an ACL-change gate was last requested. */
  aclGateAskedAt?: Record<string, string>;
  runCount: number;
}

const DEFAULT_REASK_BACKOFF_MS = 24 * 60 * 60 * 1000; // denied first-sync: re-ask after a day
const DEFAULT_ACL_GATE_BACKOFF_MS = 60 * 60 * 1000; // undecided ACL change: re-ask after an hour
/** Every Nth run uses a full listing so deletions reconcile even when the
 * connector supports incremental (cursor) listings. */
const FULL_RECONCILE_EVERY = 10;

/**
 * Automatic connector sync. Policy (see docs/SYNC.md):
 *  - connectors an admin configured are crawled on a schedule with NO
 *    per-document approval; docs ingest under the connector's configured
 *    ACL, which source text can never widen;
 *  - the FIRST sync of a connector (a new connector/scope) is gated: one
 *    durable human approval per connector;
 *  - re-tagging a doc to a different ACL is gated per doc;
 *  - deletions always apply immediately (dropping access is the safe
 *    direction), on full listings only.
 */
export class SyncEngine {
  constructor(
    private store: DurableStore,
    private audit: AuditLog,
    private rag: Rag,
    private connectors: Record<string, Connector>,
    private opts: { reaskBackoffMs?: number; aclGateBackoffMs?: number } = {},
  ) {}

  private get reaskBackoffMs() { return this.opts.reaskBackoffMs ?? DEFAULT_REASK_BACKOFF_MS; }
  private get aclGateBackoffMs() { return this.opts.aclGateBackoffMs ?? DEFAULT_ACL_GATE_BACKOFF_MS; }

  /** Run one sync pass. `gate` routes a mutating proposal through the
   * runtime's approval gate (adapter supplies runtime.executeProposed). */
  async runOnce(gate: (action: ProposedAction) => Promise<void>): Promise<SyncResult[]> {
    const results: SyncResult[] = [];
    for (const [name, conn] of Object.entries(this.connectors)) {
      if (!isSyncable(conn)) continue;
      try {
        results.push(await this.syncConnector(name, conn, gate));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.audit.record("sync_failed", "sync-engine", `${name}: ${msg}`);
        results.push({ connector: name, listed: 0, ingested: 0, skipped: 0, deleted: 0, gated: [], error: msg });
      }
    }
    return results;
  }

  private async loadState(name: string): Promise<ConnectorSyncState> {
    const raw = await this.store.get("sync", `state:${name}`);
    if (raw) return JSON.parse(raw) as ConnectorSyncState;
    return { approved: false, docs: {}, runCount: 0 };
  }

  private async syncConnector(
    name: string,
    conn: SyncableConnector,
    gate: (action: ProposedAction) => Promise<void>,
  ): Promise<SyncResult> {
    const state = await this.loadState(name);
    const res: SyncResult = { connector: name, listed: 0, ingested: 0, skipped: 0, deleted: 0, gated: [] };

    // Gate 1: new connector/scope - one durable human approval, then automatic.
    if (!state.approved) {
      const askedAt = state.gateAskedAt ? Date.parse(state.gateAskedAt) : 0;
      if (Date.now() - askedAt < this.reaskBackoffMs) {
        res.gated.push("first-sync (asked, awaiting or denied)");
        return res;
      }
      state.gateAskedAt = new Date().toISOString();
      await this.store.set("sync", `state:${name}`, JSON.stringify(state));
      let approved = false;
      // Unique key per ask: the runtime dedupes executed action keys, so reusing
      // the same key after a state reset made re-approvals impossible to execute
      // (live bug: "Already executed earlier, not repeating" -> gate read as denied).
      await gate({
        key: actionKey("sync-enable", name, state.gateAskedAt),
        tier: "mutating",
        summary: `Enable automatic scheduled sync for connector \`${name}\` - its docs will be indexed under its configured ACL, no per-document approvals`,
        run: async () => {
          approved = true;
          return `automatic sync enabled for ${name}`;
        },
      });
      if (!approved) return { ...res, gated: ["first-sync (denied)"] };
      state.approved = true;
      this.audit.record("sync_enabled", "sync-engine", name);
    }

    state.runCount += 1;
    // Full listing on the first crawl and every Nth run (deletion reconcile);
    // incremental by cursor otherwise.
    const full = state.cursor === undefined || state.runCount % FULL_RECONCILE_EVERY === 0;
    const listing = await conn.list(full ? undefined : state.cursor);
    const complete = full && listing.complete;
    res.listed = listing.docs.length;

    const seen = new Set<string>();
    let maxMod = state.cursor;
    for (const doc of listing.docs) {
      seen.add(doc.id);
      const acl = doc.acl ?? "public"; // connector-configured ACL; source text can never widen it
      const hash = createHash("sha256").update(doc.body).digest("hex");
      const prev = state.docs[doc.id];
      if (prev && prev.hash === hash && prev.acl === acl) {
        res.skipped++;
      } else if (prev && prev.acl !== acl) {
        // Gate 2: re-tagging an indexed doc to a different ACL needs approval.
        res.gated.push(doc.id);
        const askedAt = state.aclGateAskedAt?.[doc.id] ? Date.parse(state.aclGateAskedAt[doc.id]) : 0;
        if (Date.now() - askedAt >= this.aclGateBackoffMs) {
          state.aclGateAskedAt = { ...(state.aclGateAskedAt ?? {}), [doc.id]: new Date().toISOString() };
          await gate({
            key: actionKey("sync-acl", name, doc.id, prev.acl, acl),
            tier: "mutating",
            summary: `Re-tag indexed doc \`${doc.id}\` (via ${name}) from ACL \`${prev.acl}\` to \`${acl}\``,
            run: async () => {
              const n = await this.rag.replace(doc.id, doc.body, acl);
              state.docs[doc.id] = { hash, acl };
              return `re-tagged ${doc.id} to ACL ${acl} (${n} chunk(s))`;
            },
          });
        }
      } else {
        const n = await this.rag.replace(doc.id, doc.body, acl);
        state.docs[doc.id] = { hash, acl };
        res.ingested++;
        this.audit.record("sync_ingested", "sync-engine", `${name}/${doc.id}: ${n} chunk(s), ACL ${acl}`);
      }
      const mod = (doc as SyncedDoc).lastModified;
      if (mod && (!maxMod || mod > maxMod)) maxMod = mod;
    }

    if (complete) {
      for (const id of Object.keys(state.docs)) {
        if (!seen.has(id)) {
          const removed = this.rag.remove(id);
          delete state.docs[id];
          res.deleted++;
          this.audit.record("sync_deleted", "sync-engine", `${name}/${id}: ${removed} chunk(s) dropped (gone upstream)`);
        }
      }
    }

    state.cursor = maxMod;
    await this.store.set("sync", `state:${name}`, JSON.stringify(state));
    this.audit.record(
      "sync_completed",
      "sync-engine",
      `${name}: listed=${res.listed} ingested=${res.ingested} skipped=${res.skipped} deleted=${res.deleted} gated=${res.gated.length} full=${full}`,
    );
    return res;
  }
}
