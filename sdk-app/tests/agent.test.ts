import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentCore } from "../src/agent.js";
import { buildKitServer, qualified } from "../src/tools.js";
import { configFromEnv } from "../src/config.js";
import { AuditLog } from "../src/audit.js";
import { ApprovalStore } from "../src/approvals.js";
import type { Connector } from "../../src/connectors/types.js";

class EmptyConnector implements Connector {
  name = "empty";
  async search() { return []; }
  async get() { return undefined; }
}

const setup = (queryFn: any) => {
  const dir = mkdtempSync(join(tmpdir(), "agent-"));
  const config = configFromEnv({} as any);
  const audit = new AuditLog(join(dir, "audit.jsonl"));
  const approvals = new ApprovalStore(join(dir, "approvals.jsonl"));
  const mcpServer = buildKitServer({ connectors: [new EmptyConnector()], config, audit });
  const agent = new AgentCore({ config, mcpServer, approvals, audit, queryFn });
  return { agent, approvals, auditPath: join(dir, "audit.jsonl") };
};

const assistantMsg = (text: string) => ({
  type: "assistant",
  session_id: "sess-1",
  message: { id: "m1", content: [{ type: "text", text }] },
  parent_tool_use_id: null,
  uuid: "u1",
});
const resultMsg = () => ({
  type: "result", subtype: "success", session_id: "sess-1",
  duration_ms: 1200, total_cost_usd: 0.0123, num_turns: 1, is_error: false,
});

test("chat streams assistant text, stores session, audits cost; second turn resumes", async () => {
  const seenOptions: any[] = [];
  const fakeQuery = async function* ({ options }: any) {
    seenOptions.push(options);
    yield assistantMsg("Hello from the loop.");
    yield resultMsg();
  };
  const { agent, auditPath } = setup(fakeQuery);
  const texts: string[] = [];
  await agent.chat("t1", "hi", { onText: (t) => texts.push(t) });
  assert.deepEqual(texts, ["Hello from the loop."]);
  assert.equal(agent.sessionId("t1"), "sess-1");
  await agent.chat("t1", "again", {});
  assert.equal(seenOptions[1].resume, "sess-1", "second turn resumes the session");
  assert.equal(seenOptions[0].model, "claude-sonnet-5-5");
  const auditLines = readFileSync(auditPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(auditLines.some((e) => e.kind === "turn_cost" && e.detail.cost_usd === 0.0123));
  assert.ok(auditLines.some((e) => e.kind === "message_in"));
  assert.ok(auditLines.some((e) => e.kind === "message_out"));
});

test("mutating tool is gated: approve allows, deny denies, read tools auto-allow", async () => {
  const decisions: any[] = [];
  const fakeQuery = async function* ({ options }: any) {
    // read tool: auto-allow
    decisions.push(await options.canUseTool(qualified("search_docs"), { query: "x" }));
    // unknown/built-in tool: default-deny
    decisions.push(await options.canUseTool("Bash", { command: "rm -rf /" }));
    // mutating tool: goes through the approval store
    const p = options.canUseTool(qualified("github_create_issue"), { repo: "o/r", title: "T", body: "b" });
    // the surface sees the request and approves it
    setTimeout(() => setup2.approvals.resolve(setup2.approvals.list()[0].id, true, "tester"), 5);
    decisions.push(await p);
    // second mutating call, denied
    const p2 = options.canUseTool(qualified("github_create_issue"), { repo: "o/r", title: "T2", body: "b" });
    setTimeout(() => setup2.approvals.resolve(setup2.approvals.list()[0].id, false, "tester"), 5);
    decisions.push(await p2);
    yield resultMsg();
  };
  const s = setup(fakeQuery);
  (globalThis as any).setup2 = s;
  const setup2 = s;
  const needed: string[] = [];
  await agent0(s).chat("t2", "do it", { onApprovalNeeded: (id) => needed.push(id) });
  assert.equal(decisions[0].behavior, "allow", "read tool auto-allowed");
  assert.equal(decisions[1].behavior, "deny", "built-in Bash default-denied");
  assert.equal(decisions[2].behavior, "allow", "approved mutation allowed");
  assert.equal(decisions[3].behavior, "deny", "denied mutation denied");
  assert.match(decisions[3].message, /Denied by human/);
  assert.equal(needed.length, 2, "surface was notified for both mutating calls");
});
function agent0(s: any) { return s.agent as AgentCore; }

test("multi-user same-thread isolation: unknown user identity-denied, enrolled user reaches approval gate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-mu-"));
  const config = configFromEnv({
    SDK_APP_USER_ACLS: JSON.stringify({ U1: [] }),
    SDK_APP_RBAC_USERS: JSON.stringify({ U1: "chief" }),
    SDK_APP_RBAC_ROLES: JSON.stringify({ chief: ["read", "propose", "approve"] }),
  } as any);
  const audit = new AuditLog(join(dir, "audit.jsonl"));
  const approvals = new ApprovalStore(join(dir, "approvals.jsonl"));
  const mcpServer = buildKitServer({ connectors: [new EmptyConnector()], config, audit });
  const decisions: Record<string, any> = {};
  let call = 0;
  const fakeQuery = async function* ({ options }: any) {
    const who = call++ === 0 ? "U0" : "U1"; // turns on one thread serialize: U0 first
    decisions[who] = await options.canUseTool(qualified("github_create_issue"), { repo: "o/r", title: "T", body: "b" });
    yield resultMsg();
  };
  const agent = new AgentCore({ config, mcpServer, approvals, audit, queryFn: fakeQuery });

  // unknown user in the thread: identity-denied before capability or approval
  await (agent as any).chat("C1:1.1", "create issue", {}, { userId: "U0", surface: "slack" });
  // enrolled user in the SAME thread: passes identity, 'propose' cap, hits approval gate
  const pending: string[] = [];
  const chatP = (agent as any).chat("C1:1.1", "create issue", { onApprovalNeeded: (id: string) => pending.push(id) }, { userId: "U1", surface: "slack" });
  let req;
  for (let i = 0; i < 100 && !req; i++) { await new Promise((r) => setTimeout(r, 20)); req = approvals.list()[0]; }
  assert.ok(req, "approval was requested for the enrolled user");
  approvals.resolve(req.id, true, "approver", "C1:1.1");
  await chatP;

  assert.equal(decisions.U0?.behavior, "deny", "unknown user denied");
  assert.match(decisions.U0?.message ?? "", /identity/i);
  assert.equal(decisions.U1?.behavior, "allow", "enrolled user approved through gate");
  assert.equal(pending.length, 1, "approval surfaced only for the enrolled user");

  const lines = readFileSync(join(dir, "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(lines.some((e) => e.kind === "identity_denied" && e.detail.user === "U0"));
  assert.ok(lines.some((e) => e.kind === "approval_requested"));
});
