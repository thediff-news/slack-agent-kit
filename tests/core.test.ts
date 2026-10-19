import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/core/store-sqlite.js";
import { AuditLog } from "../src/core/audit.js";
import { Permissions } from "../src/core/permissions.js";
import { HashingEmbedder, cosine } from "../src/rag/embed.js";
import { Rag } from "../src/rag/rag.js";
import { stripAppMention } from "../src/core/events.js";

const tmp = () => mkdtempSync(join(tmpdir(), "kit-test-"));

test("dedup: an event recorded twice is a duplicate", async () => {
  const s = new SqliteStore(join(tmp(), "s.db"));
  assert.equal(await s.recordEvent("e1", "slack", "alert", "u1", "x"), "new");
  assert.equal(await s.recordEvent("e1", "slack", "alert", "u1", "x"), "duplicate");
  await s.close();
});

test("approval resolves exactly once", async () => {
  const s = new SqliteStore(join(tmp(), "s.db"));
  await s.createApproval({ id: "a1", actionKey: "k1", summary: "rotate key", requestedBy: "u1", requestedAt: new Date().toISOString(), status: "pending" });
  assert.equal(await s.resolveApproval("a1", "approved", "boss"), true);
  assert.equal(await s.resolveApproval("a1", "denied", "other"), false); // second decision ignored
  assert.equal((await s.getApproval("a1"))?.status, "approved");
  await s.close();
});

test("execution idempotency keys", async () => {
  const s = new SqliteStore(join(tmp(), "s.db"));
  assert.equal(await s.hasExecuted("k1"), false);
  await s.markExecuted("k1", "done");
  assert.equal(await s.hasExecuted("k1"), true);
  await s.close();
});

test("audit hash chain verifies and detects tampering", () => {
  const p = join(tmp(), "audit.jsonl");
  const log = new AuditLog(p);
  log.record("event_received", "u1", "first");
  log.record("action_executed", "agent", "second");
  assert.equal(AuditLog.verify(p), null);
  // tamper with the first line
  const lines = readFileSync(p, "utf8").trim().split("\n");
  const e = JSON.parse(lines[0]);
  e.detail = "forged";
  writeFileSync(p, JSON.stringify(e) + "\n" + lines.slice(1).join("\n") + "\n");
  assert.equal(AuditLog.verify(p), 1);
});

test("RBAC: viewer cannot trigger mutating skill, operator can, channel allow-list enforced", () => {
  const perms = new Permissions({
    roles: { admin: ["read", "propose", "execute", "approve"], operator: ["read", "propose", "approve"], viewer: ["read"] },
    users: { alice: "operator", bob: "viewer" },
    approvers: ["alice"],
    channels: { sec: { allow: ["credential-triage"] }, general: { allow: ["*"] } },
    roleAcls: {},
  });
  assert.equal(perms.canTrigger("bob", "credential-triage", "mutating", "general").ok, false);
  assert.equal(perms.canTrigger("alice", "credential-triage", "mutating", "general").ok, true);
  assert.equal(perms.canTrigger("alice", "credential-triage", "mutating", "sec").ok, true);
  assert.equal(perms.canTrigger("alice", "other-skill", "mutating", "sec").ok, false);
  assert.equal(perms.canApprove("alice"), true);
  assert.equal(perms.canApprove("bob"), false);
});

test("hashing embedder is deterministic and retrieves the right doc", async () => {
  const dir = tmp();
  const rag = new Rag(join(dir, "r.db"), new HashingEmbedder(256));
  await rag.ingest("policy.md", "Credential rotation policy: revoke the leaked key at the provider first, then remove it from source.");
  await rag.ingest("lunch.md", "The cafeteria serves pizza on Fridays and salad every other day.");
  const hits = await rag.retrieve("what do we do when a key leaks?", 1);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].source, "policy.md");
  // the inline acl: tag line is metadata, stripped from retrieved text
  await rag.ingest("secret.md", "acl: finance\n\nQ4 discounts are 18% annual.", "finance");
  const tagged = await rag.retrieve("Q4 discounts", 1);
  assert.ok(!tagged[0].text.includes("acl:"));
  assert.match(tagged[0].text, /^Q4 discounts/);
  assert.equal(tagged[0].acl, "finance");
  // idempotent ingest
  assert.equal(await rag.ingest("policy.md", "Credential rotation policy: revoke the leaked key at the provider first, then remove it from source."), 0);
  rag.close();
});

test("stripAppMention removes a leading Slack mention, keeps the rest", () => {
  assert.equal(stripAppMention("<@U0CAELXUH2N> ingest notion:abc123"), "ingest notion:abc123");
  assert.equal(stripAppMention("  <@U123>  hello?"), "hello?");
  assert.equal(stripAppMention("no mention here"), "no mention here");
  assert.equal(stripAppMention("tell <@U123> later"), "tell <@U123> later");
});
