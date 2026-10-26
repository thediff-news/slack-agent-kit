import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentCore } from "../src/agent.js";
import { buildKitServer, qualified } from "../src/tools.js";
import { configFromEnv } from "../src/config.js";
import { AuditLog } from "../src/audit.js";
import { ApprovalStore } from "../src/approvals.js";
import { createLineHandler } from "../src/harness.js";
import type { Connector } from "../../src/connectors/types.js";

class EmptyConnector implements Connector {
  name = "empty";
  async search() { return []; }
  async get() { return undefined; }
}

test("REGRESSION: approval command resolves a gate while its chat turn is in flight (no deadlock)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-"));
  const config = configFromEnv({} as any);
  const audit = new AuditLog(join(dir, "audit.jsonl"));
  const approvals = new ApprovalStore(join(dir, "appr.jsonl"));
  const mcpServer = buildKitServer({ connectors: [new EmptyConnector()], config, audit });

  const gateDecisions: any[] = [];
  const fakeQuery = async function* ({ options }: any) {
    // simulate the model calling the mutating tool: gate blocks until resolved
    gateDecisions.push(await options.canUseTool(qualified("github_create_issue"), { repo: "o/r", title: "t", body: "b" }));
    yield { type: "assistant", session_id: "s1", message: { id: "m", content: [{ type: "text", text: "done" }] }, parent_tool_use_id: null, uuid: "u" } as any;
    yield { type: "result", subtype: "success", session_id: "s1", duration_ms: 1, total_cost_usd: 0.001, num_turns: 1, is_error: false } as any;
  };
  const agent = new AgentCore({ config, mcpServer, approvals, audit, queryFn: fakeQuery });
  const out: string[] = [];
  const h = createLineHandler(agent, approvals, { print: (s) => out.push(s), printStream: (s) => out.push(s) }, "t");

  const watchdog = setTimeout(() => { throw new Error("deadlock: gate never resolved"); }, 3000);
  h.onLine("open the issue");                       // chat starts, hits the gate
  await new Promise((r) => setTimeout(r, 20));       // let the gate register
  const pending = approvals.list();
  assert.equal(pending.length, 1);
  h.onLine(`approve ${pending[0].id}`);              // must reach the store DURING the in-flight chat
  await h.drain();
  clearTimeout(watchdog);
  assert.equal(gateDecisions[0].behavior, "allow");
  assert.ok(out.some((s) => /approval needed/.test(s)));
  assert.ok(out.some((s) => /done/.test(s)));
});

test("messages queue behind an in-flight chat in order", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-"));
  const config = configFromEnv({} as any);
  const audit = new AuditLog(join(dir, "audit.jsonl"));
  const approvals = new ApprovalStore(join(dir, "appr.jsonl"));
  const mcpServer = buildKitServer({ connectors: [new EmptyConnector()], config, audit });
  const order: string[] = [];
  const fakeQuery = async function* ({ prompt }: any) {
    order.push(prompt);
    await new Promise((r) => setTimeout(r, 10));
    yield { type: "result", subtype: "success", session_id: "s", duration_ms: 1, total_cost_usd: 0, num_turns: 1, is_error: false } as any;
  };
  const agent = new AgentCore({ config, mcpServer, approvals, audit, queryFn: fakeQuery });
  const h = createLineHandler(agent, approvals, { print: () => {}, printStream: () => {} }, "t");
  h.onLine("first");
  h.onLine("second");
  h.onLine("third");
  await h.drain();
  assert.deepEqual(order, ["first", "second", "third"]);
});
