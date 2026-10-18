/**
 * Regression tests for the two ACL findings:
 *  1. an inline "acl: public" line in an EXTERNAL doc (Jira/Confluence/Notion)
 *     must not override the connector's configured ACL;
 *  2. re-ingesting identical content under a tighter ACL must re-tag the
 *     existing chunks, not leave the old public rows.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Rag } from "../src/rag/rag.js";
import { HashingEmbedder } from "../src/rag/embed.js";
import { SqliteStore } from "../src/core/store-sqlite.js";
import { AuditLog } from "../src/core/audit.js";
import { KnowledgeSkill } from "../src/skills/knowledge.js";
import { FilesystemConnector } from "../src/connectors/fs.js";
import { cliEvent } from "../src/adapters/cli.js";
import { mkdirSync, writeFileSync } from "node:fs";
import type { Connector } from "../src/connectors/types.js";

function makeCtx(dir: string, connectors: Record<string, Connector>) {
  const rag = new Rag(join(dir, "r.db"), new HashingEmbedder(256));
  const ctx: any = {
    store: new SqliteStore(join(dir, "s.db")),
    audit: new AuditLog(join(dir, "a.jsonl")),
    rag,
    connectors,
    config: {},
    reply: async () => {},
    enrich: async () => "",
    aclsFor: () => ["public", "eng"],
  };
  return ctx;
}

test("external doc with inline 'acl: public' stays at the connector's restricted ACL", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kit-acl1-"));
  // External connector: configured ACL eng, body tries to self-tag public.
  const evilConnector: Connector = {
    name: "jira",
    search: async () => [],
    get: async () => ({
      id: "PROJ-9",
      title: "PROJ-9: rotate signing keys",
      body: "acl: public\n\nRotation procedure: revoke the signing keys at the provider first.",
      acl: "eng",
    }),
  };
  const ctx = makeCtx(dir, { jira: evilConnector });
  const skill = new KnowledgeSkill();
  const result = await skill.handle(cliEvent("ingest jira:PROJ-9"), ctx);
  assert.match(result.findings, /ACL `eng`/);
  await result.actions[0].run();

  const eng = await ctx.rag.retrieve("signing keys rotation", 3, ["public", "eng"]);
  assert.ok(eng.length > 0);
  assert.equal(eng[0].acl, "eng");
  const publicOnly = await ctx.rag.retrieve("signing keys rotation", 3, ["public"]);
  assert.equal(publicOnly.length, 0);
  ctx.store.close(); ctx.rag.close();
});

test("local filesystem doc still honors an inline acl: tag", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kit-acl2-"));
  mkdirSync(join(dir, "docs"));
  writeFileSync(join(dir, "docs", "policy.md"), "acl: finance\n\nQ4 discounts are 18% annual, pre-decisional.");
  const ctx = makeCtx(dir, { docs: new FilesystemConnector(join(dir, "docs")) });
  const skill = new KnowledgeSkill();
  const result = await skill.handle(cliEvent("ingest policy.md"), ctx);
  assert.match(result.findings, /ACL `finance`/);
  await result.actions[0].run();
  const hits = await ctx.rag.retrieve("Q4 discounts", 3, ["public", "finance"]);
  assert.ok(hits.length > 0);
  assert.equal(hits[0].acl, "finance");
  ctx.store.close(); ctx.rag.close();
});

test("re-ingest under a tighter ACL revokes the old public rows", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kit-acl3-"));
  const rag = new Rag(join(dir, "r.db"), new HashingEmbedder(256));
  const text = "Credential rotation policy: revoke the leaked key at the provider first.";

  await rag.ingest("policy.md", text, "public");
  assert.equal((await rag.retrieve("leaked key rotation", 3, ["public"])).length, 1);

  const changed = await rag.ingest("policy.md", text, "finance"); // same content, tighter ACL
  assert.equal(changed, 1); // re-tagged, not a no-op and not a duplicate
  assert.equal(rag.count(), 1); // still one chunk
  assert.equal((await rag.retrieve("leaked key rotation", 3, ["public"])).length, 0);
  const fin = await rag.retrieve("leaked key rotation", 3, ["finance"]);
  assert.equal(fin.length, 1);
  assert.equal(fin[0].acl, "finance");

  assert.equal(await rag.ingest("policy.md", text, "finance"), 0); // true no-op now
  rag.close();
});
