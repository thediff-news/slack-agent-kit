/**
 * SyncEngine policy tests (docs/SYNC.md): fake syncable connectors over a
 * real SqliteStore + Rag, with a stub approval gate. No network, no live
 * tenants.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SyncEngine } from "../src/core/sync.js";
import type { ConnectorDoc, SyncableConnector, SyncListing } from "../src/connectors/types.js";
import type { ProposedAction } from "../src/core/skills.js";
import { SqliteStore } from "../src/core/store-sqlite.js";
import { AuditLog } from "../src/core/audit.js";
import { Rag } from "../src/rag/rag.js";
import { HashingEmbedder } from "../src/rag/embed.js";

class FakeConnector implements SyncableConnector {
  name: string;
  listings: SyncListing[] = [];
  constructor(name: string, private acl = "public") { this.name = name; }
  async search(): Promise<ConnectorDoc[]> { return []; }
  async get(): Promise<ConnectorDoc | undefined> { return undefined; }
  async list(): Promise<SyncListing> {
    return this.listings.shift() ?? { docs: [], complete: true };
  }
  push(docs: { id: string; body: string; acl?: string; lastModified?: string }[], complete = true) {
    this.listings.push({
      complete,
      docs: docs.map((d) => ({ id: d.id, title: d.id, body: d.body, acl: d.acl ?? this.acl, lastModified: d.lastModified })),
    });
  }
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "kit-sync-"));
  const store = new SqliteStore(join(dir, "s.db"));
  const audit = new AuditLog(join(dir, "a.jsonl"));
  const rag = new Rag(join(dir, "r.db"), new HashingEmbedder(256));
  return { store, audit, rag };
}

const approve = async (a: ProposedAction) => { await a.run(); };
const deny = async (_a: ProposedAction) => {};

test("sync: first crawl of a connector is gated; denial ingests nothing; approval then runs automatically", async () => {
  const { store, audit, rag } = setup();
  const conn = new FakeConnector("docs");
  conn.push([{ id: "A", body: "alpha body" }]);
  const engine = new SyncEngine(store, audit, rag, { docs: conn }, { reaskBackoffMs: 0, aclGateBackoffMs: 0 });

  await engine.runOnce(deny);
  assert.equal(rag.count(), 0); // denied: nothing indexed

  await engine.runOnce(approve); // approval: first crawl proceeds
  assert.ok(rag.count() > 0);

  // second run asks nobody even with new content
  conn.push([{ id: "A", body: "alpha body v2" }]);
  await engine.runOnce(deny); // gate must not be consulted at all
  const hits = await rag.retrieve("alpha", 3);
  assert.ok(hits[0].text.includes("v2"));
  await store.close(); rag.close();
});

test("sync: unchanged docs are skipped, changed docs are re-indexed (stale chunks dropped)", async () => {
  const { store, audit, rag } = setup();
  const conn = new FakeConnector("docs");
  conn.push([{ id: "A", body: "first version about apples" }, { id: "B", body: "static doc about pears" }]);
  const engine = new SyncEngine(store, audit, rag, { docs: conn }, { reaskBackoffMs: 0, aclGateBackoffMs: 0 });
  await engine.runOnce(approve);

  conn.push([{ id: "A", body: "second version about oranges" }, { id: "B", body: "static doc about pears" }]);
  const r2 = (await engine.runOnce(deny))[0];
  assert.equal(r2.ingested, 1); // only A changed
  assert.equal(r2.skipped, 1); // B untouched

  const hitsA = await rag.retrieve("oranges", 3);
  assert.ok(hitsA.length > 0);
  const hitsOld = await rag.retrieve("apples", 3);
  assert.equal(hitsOld.filter((h) => h.source === "A").length, 0); // stale chunks gone
  await store.close(); rag.close();
});

test("sync: deleted docs drop out of the index on complete listings only", async () => {
  const { store, audit, rag } = setup();
  const conn = new FakeConnector("docs");
  conn.push([{ id: "A", body: "doc alpha" }, { id: "B", body: "doc beta" }]);
  const engine = new SyncEngine(store, audit, rag, { docs: conn }, { reaskBackoffMs: 0, aclGateBackoffMs: 0 });
  await engine.runOnce(approve);
  const before = rag.count();

  // incomplete listing missing B: must NOT delete
  conn.push([{ id: "A", body: "doc alpha" }], false);
  const r2 = (await engine.runOnce(deny))[0];
  assert.equal(r2.deleted, 0);
  assert.equal(rag.count(), before);

  // complete listing missing B: delete
  conn.push([{ id: "A", body: "doc alpha" }], true);
  const r3 = (await engine.runOnce(deny))[0];
  assert.equal(r3.deleted, 1);
  const hits = await rag.retrieve("beta", 3);
  assert.equal(hits.filter((h) => h.source === "B").length, 0);
  await store.close(); rag.close();
});

test("sync: ACL re-tag of an indexed doc is gated, never automatic; old ACL holds until approved", async () => {
  const { store, audit, rag } = setup();
  const conn = new FakeConnector("docs");
  conn.push([{ id: "A", body: "shared body", acl: "finance" }]);
  const engine = new SyncEngine(store, audit, rag, { docs: conn }, { reaskBackoffMs: 0, aclGateBackoffMs: 0 });
  await engine.runOnce(approve);

  // connector config now tags the same doc public (wider): must be gated
  conn.push([{ id: "A", body: "shared body", acl: "public" }]);
  const gated: string[] = [];
  const r2 = (await engine.runOnce(async (a) => { gated.push(a.summary); /* human undecided: no run() */ }))[0];
  assert.deepEqual(r2.gated, ["A"]);
  assert.equal(gated.length, 1);
  // still only visible under the old ACL
  assert.ok((await rag.retrieve("shared", 3, ["finance"])).length > 0);
  assert.equal((await rag.retrieve("shared", 3, ["public"])).length, 0);

  // next run with the gate approved re-tags
  conn.push([{ id: "A", body: "shared body", acl: "public" }]);
  await engine.runOnce(approve);
  assert.ok((await rag.retrieve("shared", 3, ["public"])).length > 0);
  await store.close(); rag.close();
});

test("sync: an inline acl: line in source text can never widen the connector ACL", async () => {
  const { store, audit, rag } = setup();
  const conn = new FakeConnector("docs", "finance");
  // hostile source text trying to make itself public
  conn.push([{ id: "A", body: "acl: public\nsecret finance numbers" }]);
  const engine = new SyncEngine(store, audit, rag, { docs: conn }, { reaskBackoffMs: 0, aclGateBackoffMs: 0 });
  await engine.runOnce(approve);
  assert.ok((await rag.retrieve("finance", 3, ["finance"])).length > 0);
  assert.equal((await rag.retrieve("finance", 3, ["public"])).length, 0);
  await store.close(); rag.close();
});

test("sync: a failing connector is audited and never blocks the others", async () => {
  const { store, audit, rag } = setup();
  const bad = new FakeConnector("bad");
  const good = new FakeConnector("good");
  bad.list = async () => { throw new Error("boom"); };
  good.push([{ id: "G", body: "good doc" }]);
  const engine = new SyncEngine(store, audit, rag, { bad, good });
  const results = await engine.runOnce(approve);
  assert.equal(results.find((r) => r.connector === "bad")?.error, "boom");
  assert.ok(rag.count() > 0);
  await store.close(); rag.close();
});

test("sync: re-ask after state reset uses a fresh action key, so a runtime that dedupes executed keys can still approve (live bug)", async () => {
  const { store, audit, rag } = setup();
  const conn = new FakeConnector("docs");
  conn.push([{ id: "A", body: "alpha body" }]);
  const engine = new SyncEngine(store, audit, rag, { docs: conn }, { reaskBackoffMs: 0, aclGateBackoffMs: 0 });
  const seenKeys = new Set<string>();
  const gate = async (a: ProposedAction) => {
    if (seenKeys.has(a.key)) return; // runtime dedupe: never re-execute the same key
    seenKeys.add(a.key);
    await a.run();
  };
  await engine.runOnce(gate); // first approval executes
  assert.ok(rag.count() > 0);
  // state reset (bot data lost): new engine, same store wiped of sync state
  await store.set("sync", "state:docs", JSON.stringify({ approved: false, docs: {}, runCount: 0 })); // state reset
  const engine2 = new SyncEngine(store, audit, rag, { docs: conn }, { reaskBackoffMs: 0, aclGateBackoffMs: 0 });
  conn.push([{ id: "A", body: "alpha body v3" }]);
  await engine2.runOnce(gate); // re-ask must use a NEW key, so approval executes again
  assert.equal(seenKeys.size, 2);
  const hits = await rag.retrieve("alpha", 3);
  assert.ok(hits[0].text.includes("v3"));
  await store.close(); rag.close();
});
