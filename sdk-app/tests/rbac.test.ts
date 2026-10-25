import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildToolHandlers } from "../src/tools.js";
import { configFromEnv } from "../src/config.js";
import { AuditLog } from "../src/audit.js";
import { openRagStore } from "../src/rag-store.js";
import { AgentCore } from "../src/agent.js";
import { ApprovalStore } from "../src/approvals.js";
import type { Connector, ConnectorDoc } from "../../src/connectors/types.js";

const mk = (extra: Record<string, string> = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "rbac-"));
  const config = configFromEnv({ SDK_APP_AUDIT_LOG: join(dir, "a.jsonl"), SDK_APP_APPROVALS_LOG: join(dir, "p.jsonl"), SDK_APP_RAG_DB: join(dir, "r.db"), ...extra } as any);
  return { dir, config, audit: new AuditLog(config.auditLog), approvals: new ApprovalStore(config.approvalsLog) };
};

class EmptyConn implements Connector {
  name = "empty";
  async search() { return []; }
  async get() { return undefined; }
}

const seededRag = async (dbPath: string) => {
  const ragStore = openRagStore(dbPath);
  await ragStore.rag.replace("fs:pub.md", "deploy rollback runbook public guidance");
  await ragStore.rag.replace("fs:secret.md", "deploy rollback secret engineering credentials", "engineering");
  return ragStore;
};

test("config: unknown user -> public only; enrolled -> +tags; * -> unfiltered; broken JSON fails closed", () => {
  const { config } = mk({ SDK_APP_USER_ACLS: '{"U_ENG":["engineering"],"U_ALL":["*"]}' });
  assert.deepEqual(config.aclTagsFor("U_NOPE"), ["public"]);
  assert.deepEqual(config.aclTagsFor("U_ENG"), ["public", "engineering"]);
  assert.equal(config.aclTagsFor("U_ALL"), undefined);
  assert.equal(config.isKnownIdentity("U_NOPE"), false);
  assert.equal(config.isKnownIdentity("U_ENG"), true);
  const broken = configFromEnv({ SDK_APP_USER_ACLS: "{not json" } as any);
  assert.deepEqual(broken.aclTagsFor("U_ENG"), ["public"], "broken map grants nothing extra");
});

test("search_docs RAG path: public requester cannot see engineering doc; enrolled can", async () => {
  const { config, audit } = mk();
  const ragStore = await seededRag(config.ragDb);
  const pub = buildToolHandlers({ connectors: [new EmptyConn()], config, audit, ragStore, aclTags: config.aclTagsFor("U_NOPE") });
  const pubHits = await pub.searchDocs({ query: "deploy rollback" });
  assert.match(pubHits.content[0].text, /pub\.md/);
  assert.doesNotMatch(pubHits.content[0].text, /secret\.md|credentials/);
  const eng = buildToolHandlers({ connectors: [new EmptyConn()], config, audit, ragStore, aclTags: ["public", "engineering"] });
  const engHits = await eng.searchDocs({ query: "deploy rollback" });
  assert.match(engHits.content[0].text, /secret\.md/);
});

test("connector fallback also filters by acl", async () => {
  const { config, audit } = mk();
  const docs: ConnectorDoc[] = [
    { id: "p1", title: "deploy", body: "public deploy note" },
    { id: "e1", title: "deploy", body: "engineering deploy note", acl: "engineering" },
  ];
  const conn: Connector = { name: "m", search: async () => docs, get: async (id) => docs.find((d) => d.id === id) };
  const pub = buildToolHandlers({ connectors: [conn], config, audit, aclTags: ["public"] });
  const r = await pub.searchDocs({ query: "deploy" });
  assert.match(r.content[0].text, /p1/);
  assert.doesNotMatch(r.content[0].text, /e1|engineering deploy/);
});

test("get_doc direct bypass: restricted id is denied for public requester", async () => {
  const { config, audit } = mk();
  const docs: ConnectorDoc[] = [{ id: "e1", title: "secret", body: "engineering only", acl: "engineering" }];
  const conn: Connector = { name: "m", search: async () => docs, get: async (id) => docs.find((d) => d.id === id) };
  const pub = buildToolHandlers({ connectors: [conn], config, audit, aclTags: ["public"] });
  const denied = await pub.getDoc({ id: "e1" });
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /Access denied/);
  const eng = buildToolHandlers({ connectors: [conn], config, audit, aclTags: ["public", "engineering"] });
  assert.match((await eng.getDoc({ id: "e1" })).content[0].text, /engineering only/);
});

test("agent gate: unknown slack identity denied factory/browse/write, allowed public reads; enrolled not identity-denied", async () => {
  const { config, audit, approvals } = mk({ SDK_APP_USER_ACLS: '{"U_ENG":["engineering"]}' });
  let captured: any;
  const fakeQuery = (({ options }: any) => {
    captured = options;
    return (async function* () { yield { type: "result", subtype: "success", session_id: "s1" }; })();
  }) as any;
  const agent = new AgentCore({ config, approvals, audit, queryFn: fakeQuery, mcpServerFactory: () => ({}) as any });
  await agent.chat("t1", "hi", {}, { userId: "U_RANDOM", surface: "slack" });
  const gate = captured.canUseTool;
  for (const t of ["factory_clone", "browse_open", "browse_read", "github_create_issue", "factory_create_pr"]) {
    const d = await gate(`mcp__kit__${t}`, {});
    assert.equal(d.behavior, "deny", `${t} denied for unknown identity`);
    assert.match(d.message, /not enrolled/);
  }
  for (const t of ["search_docs", "get_doc"]) {
    assert.equal((await gate(`mcp__kit__${t}`, {})).behavior, "allow", `${t} stays open`);
  }
  assert.equal((await gate("mcp__kit__sync_docs", {})).behavior, "deny", "sync denied for unknown identity (index mutation + existence counts)");
  assert.deepEqual(captured.allowedTools, ["mcp__kit__search_docs", "mcp__kit__get_doc"]);
  // enrolled identity: factory read passes the identity tier (no identity_denied)
  await agent.chat("t2", "hi", {}, { userId: "U_ENG", surface: "slack" });
  const d2 = await captured.canUseTool("mcp__kit__factory_clone", { repo: "x" });
  assert.equal(/not enrolled/.test(d2.message ?? ""), false, "enrolled not identity-denied");
  assert.ok(captured.allowedTools.includes("mcp__kit__factory_clone"), "enrolled keeps full read tool set");
});

test("sync_docs: unknown identity denied by default; publicSync=1 opens it; enrolled always allowed", async () => {
  const { config, audit, approvals } = mk();
  let captured: any;
  const fakeQuery = (({ options }: any) => { captured = options; return (async function* () { yield { type: "result", subtype: "success", session_id: "s" }; })(); }) as any;
  const agent = new AgentCore({ config, approvals, audit, queryFn: fakeQuery, mcpServerFactory: () => ({}) as any });
  await agent.chat("t1", "hi", {}, { userId: "U_RANDOM", surface: "slack" });
  const d = await captured.canUseTool("mcp__kit__sync_docs", {});
  assert.equal(d.behavior, "deny");
  assert.deepEqual(captured.allowedTools, ["mcp__kit__search_docs", "mcp__kit__get_doc"]);
  // enrolled identity keeps sync
  const mk2 = mk({ SDK_APP_USER_ACLS: '{"U_ENG":["engineering"]}' });
  let cap2: any;
  const fq2 = (({ options }: any) => { cap2 = options; return (async function* () { yield { type: "result", subtype: "success", session_id: "s" }; })(); }) as any;
  const agent2 = new AgentCore({ config: mk2.config, approvals: mk2.approvals, audit: mk2.audit, queryFn: fq2, mcpServerFactory: () => ({}) as any });
  await agent2.chat("t1", "hi", {}, { userId: "U_ENG", surface: "slack" });
  assert.ok(cap2.allowedTools.includes("mcp__kit__sync_docs"));
});

test("no role collapse: ACL enrollment grants identity but never approver authority", () => {
  const { config } = mk({ SDK_APP_USER_ACLS: '{"U_ENG":["engineering"]}', SDK_APP_APPROVERS: "U_ADMIN" });
  assert.equal(config.isKnownIdentity("U_ENG"), true, "enrolled via ACL map");
  assert.equal(config.isApprover("U_ENG"), false, "ACL enrollment is NOT approver authority");
  assert.equal(config.isApprover("U_ADMIN"), true);
  assert.equal(config.isApprover("U_RANDOM"), false);
  assert.equal(config.isApprover(undefined), false);
});
