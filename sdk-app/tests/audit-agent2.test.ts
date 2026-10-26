import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "../src/audit.js";
import { AgentCore } from "../src/agent.js";
import { buildKitServer } from "../src/tools.js";
import { configFromEnv } from "../src/config.js";
import { ApprovalStore } from "../src/approvals.js";
import type { Connector } from "../../src/connectors/types.js";

class EmptyConnector implements Connector {
  name = "empty";
  async search() { return []; }
  async get() { return undefined; }
}

test("audit hash chain verifies; a tampered line breaks it", () => {
  const p = join(mkdtempSync(join(tmpdir(), "audit-")), "a.jsonl");
  const log = new AuditLog(p);
  log.write("message_in", { text: "one" }, "t");
  log.write("turn_cost", { cost_usd: 0.001 }, "t");
  log.write("message_out", { text: "two" }, "t");
  assert.equal(AuditLog.verify(p), null, "intact chain verifies");
  // tamper: rewrite the middle line's detail
  const lines = readFileSync(p, "utf8").trim().split("\n");
  const ev = JSON.parse(lines[1]);
  ev.detail.cost_usd = 999;
  lines[1] = JSON.stringify(ev);
  writeFileSync(p, lines.join("\n") + "\n");
  assert.equal(AuditLog.verify(p), 2, "tampered seq 2 detected");
});

const setup = (queryFn: any, dir: string) => {
  const config = configFromEnv({ SDK_APP_AUDIT_LOG: join(dir, "audit.jsonl") } as any);
  const audit = new AuditLog(config.auditLog);
  const approvals = new ApprovalStore(join(dir, "appr.jsonl"));
  const mcpServer = buildKitServer({ connectors: [new EmptyConnector()], config, audit });
  return new AgentCore({ config, mcpServer, approvals, audit, queryFn });
};

test("concurrent chats on one thread serialize; session id persists across instances", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent2-"));
  const inflight: string[] = [];
  const order: string[] = [];
  const fakeQuery = async function* ({ prompt }: any) {
    inflight.push(prompt);
    await new Promise((r) => setTimeout(r, 30));
    order.push(prompt);
    inflight.splice(inflight.indexOf(prompt), 1);
    yield { type: "result", subtype: "success", session_id: `sess-${prompt}`, duration_ms: 1, total_cost_usd: 0, num_turns: 1, is_error: false } as any;
  };
  const agent = setup(fakeQuery, dir);
  await Promise.all([agent.chat("t", "a"), agent.chat("t", "b"), agent.chat("t", "c")]);
  assert.deepEqual(order, ["a", "b", "c"], "turns ran one at a time, in order");
  assert.equal(agent.sessionId("t"), "sess-c");
  const agent2 = setup(fakeQuery, dir); // "restart"
  assert.equal(agent2.sessionId("t"), "sess-c", "session id survives restart");
});
