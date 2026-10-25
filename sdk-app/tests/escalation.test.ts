import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StallDetector, refusalSignature, describeStall } from "../src/escalation.js";
import { AgentCore } from "../src/agent.js";
import { buildKitServer } from "../src/tools.js";
import { configFromEnv } from "../src/config.js";
import { AuditLog } from "../src/audit.js";
import { ApprovalStore } from "../src/approvals.js";
import type { Connector } from "../../src/connectors/types.js";

class EmptyConnector implements Connector {
  name = "empty";
  async search() { return []; }
  async get() { return undefined; }
}

// --- refusalSignature -------------------------------------------------------

test("refusalSignature: null for ordinary tool output", () => {
  assert.equal(refusalSignature("tests passed: 5/5"), null);
  assert.equal(refusalSignature(""), null);
});

test("refusalSignature: factory refusal reasons are classified", () => {
  assert.equal(refusalSignature("no BEFORE-FIX UI evidence recorded for this UI case. Reproduce..."), "no-before-ui-evidence");
  assert.match(refusalSignature("REFUSED: the branch changed after approval (diff-hash was abc123def456, now 999888777)")!, /^diff-changed-after-approval/);
  assert.equal(refusalSignature("Denied by human (approval a1b2c3d4). Do not retry."), "human-denied-approval");
  assert.equal(refusalSignature("Your identity is not enrolled in this app; factory, browser and write capabilities stay locked"), "identity-not-enrolled");
});

test("refusalSignature: volatile ids/hashes do not fork the signature", () => {
  const a = refusalSignature("REFUSED: thing one abcdef1234567890")!;
  const b = refusalSignature("REFUSED: thing one 0000ffffeeeedddd")!;
  assert.equal(a, b);
});

// --- StallDetector ----------------------------------------------------------

test("three identical refusals escalate; two do not", () => {
  const d = new StallDetector();
  assert.equal(d.observeToolResult("factory_write_file", "no BEFORE-FIX UI evidence recorded"), null);
  assert.equal(d.observeToolResult("factory_write_file", "no BEFORE-FIX UI evidence recorded"), null);
  const sig = d.observeToolResult("factory_write_file", "no BEFORE-FIX UI evidence recorded");
  assert.equal(sig?.kind, "gate-refusal-loop");
  if (sig?.kind === "gate-refusal-loop") {
    assert.equal(sig.tool, "factory_write_file");
    assert.equal(sig.count, 3);
  }
});

test("different refusal reasons do not sum; different tools do not sum", () => {
  const d = new StallDetector();
  d.observeToolResult("factory_write_file", "no BEFORE-FIX UI evidence recorded");
  d.observeToolResult("factory_write_file", "no BEFORE-FIX UI evidence recorded");
  d.observeToolResult("factory_create_pr", "REFUSED: workflow-incomplete");
  d.observeToolResult("factory_create_pr", "REFUSED: workflow-incomplete");
  assert.equal(d.observeToolResult("factory_create_pr", "REFUSED: workflow-incomplete")?.kind, "gate-refusal-loop");
});

test("interleaved successful calls do not reset a refusal loop", () => {
  const d = new StallDetector();
  d.observeToolResult("factory_write_file", "no BEFORE-FIX UI evidence recorded");
  d.observeToolResult("factory_read_file", "file contents here");
  d.observeToolResult("factory_write_file", "no BEFORE-FIX UI evidence recorded");
  assert.equal(d.observeToolResult("factory_write_file", "no BEFORE-FIX UI evidence recorded")?.kind, "gate-refusal-loop");
});

test("turn exhaustion escalates; success does not", () => {
  const d = new StallDetector();
  assert.equal(d.observeResultSubtype("success", 12), null);
  const sig = d.observeResultSubtype("error_max_turns", 50);
  assert.equal(sig?.kind, "turn-exhausted");
  if (sig?.kind === "turn-exhausted") assert.equal(sig.numTurns, 50);
});

test("three consecutive errors escalate; reset clears the streak", () => {
  const d = new StallDetector();
  d.observeError("e1");
  d.observeError("e2");
  assert.equal(d.observeError("e3")?.kind, "error-loop");
  const e = new StallDetector();
  e.observeError("e1");
  e.observeError("e2");
  e.resetErrors();
  assert.equal(e.observeError("e3"), null);
});

test("describeStall produces a reasoned brief per signal kind", () => {
  assert.match(describeStall({ kind: "gate-refusal-loop", tool: "t", refusal: "r", count: 3 }), /same gate refusal 3x/);
  assert.match(describeStall({ kind: "turn-exhausted", numTurns: 50 }), /ran out of turns \(50\)/);
  assert.match(describeStall({ kind: "error-loop", consecutive: 3, last: "boom" }), /3 consecutive errors/);
});

// --- AgentCore integration (fake queryFn, no API) ---------------------------

const setup = (queryFn: any) => {
  const dir = mkdtempSync(join(tmpdir(), "esc-"));
  const config = configFromEnv({} as any);
  const audit = new AuditLog(join(dir, "audit.jsonl"));
  const approvals = new ApprovalStore(join(dir, "approvals.jsonl"));
  const mcpServer = buildKitServer({ connectors: [new EmptyConnector()], config, audit });
  const agent = new AgentCore({ config, mcpServer, approvals, audit, queryFn });
  return { agent, auditPath: join(dir, "audit.jsonl") };
};

const toolUse = (id: string, name: string) => ({
  type: "assistant", session_id: "s1",
  message: { id: id, content: [{ type: "tool_use", id, name, input: {} }] },
  parent_tool_use_id: null, uuid: id,
});
const toolResult = (id: string, text: string) => ({
  type: "user", session_id: "s1",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: true }] },
  parent_tool_use_id: null, uuid: `r-${id}`,
});
const refusalRound = (i: number) => [
  toolUse(`t${i}`, "mcp__kit__factory_write_file"),
  toolResult(`t${i}`, "no BEFORE-FIX UI evidence recorded for this UI case."),
];

const auditKinds = (path: string) =>
  readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).kind);

test("refusal loop: escalates once, aborts the turn, audits, no onCancelled", async () => {
  const queryFn = async function* () {
    for (let i = 0; i < 3; i++) for (const m of refusalRound(i)) yield m as any;
    // the real SDK terminates an aborted query with an error
    throw new Error("The operation was aborted");
  };
  const { agent, auditPath } = setup(queryFn);
  const escalations: string[] = [];
  let cancelled = false;
  await agent.chat("th1", "fix the bug", {
    onEscalated: (_s, brief) => escalations.push(brief),
    onCancelled: () => { cancelled = true; },
  });
  assert.equal(escalations.length, 1);
  assert.match(escalations[0], /same gate refusal 3x/);
  assert.equal(cancelled, false); // escalation, not a user cancel
  const kinds = auditKinds(auditPath);
  assert.ok(kinds.includes("escalation"));
  assert.ok(kinds.includes("turn_cancelled"));
});

test("turn exhaustion at the SDK limit escalates without aborting", async () => {
  const queryFn = async function* () {
    yield { type: "result", subtype: "error_max_turns", session_id: "s1", duration_ms: 5, total_cost_usd: 0.01, num_turns: 50 } as any;
  };
  const { agent, auditPath } = setup(queryFn);
  const escalations: string[] = [];
  await agent.chat("th2", "fix the bug", { onEscalated: (_s, brief) => escalations.push(brief) });
  assert.equal(escalations.length, 1);
  assert.match(escalations[0], /ran out of turns \(50\)/);
  assert.ok(auditKinds(auditPath).includes("escalation"));
});

test("a corrected refusal is normal work: no escalation", async () => {
  const queryFn = async function* () {
    for (const m of refusalRound(0)) yield m as any;
    for (const m of refusalRound(1)) yield m as any;
    yield { type: "assistant", session_id: "s1", message: { id: "x", content: [{ type: "text", text: "fixed after adding evidence" }] }, parent_tool_use_id: null, uuid: "x" } as any;
    yield { type: "result", subtype: "success", session_id: "s1", duration_ms: 5, total_cost_usd: 0.01, num_turns: 9 } as any;
  };
  const { agent, auditPath } = setup(queryFn);
  let escalated = false;
  await agent.chat("th3", "fix the bug", { onEscalated: () => { escalated = true; } });
  assert.equal(escalated, false);
  assert.ok(!auditKinds(auditPath).includes("escalation"));
});
