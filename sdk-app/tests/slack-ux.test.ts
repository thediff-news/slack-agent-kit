import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chunkText, renderError } from "../src/slack.js";
import { AgentCore } from "../src/agent.js";
import { configFromEnv } from "../src/config.js";
import { AuditLog } from "../src/audit.js";
import { ApprovalStore } from "../src/approvals.js";

test("chunkText: short text untouched; long text splits under max on boundaries", () => {
  assert.deepEqual(chunkText("hello"), ["hello"]);
  const para = "a".repeat(2000);
  const long = `${para}\n\n${para}\n\n${para}`;
  const chunks = chunkText(long);
  assert.ok(chunks.length >= 2);
  for (const c of chunks) assert.ok(c.length <= 3500, `chunk ${c.length} <= 3500`);
  assert.equal(chunks.join("").replace(/\n/g, ""), long.replace(/\n/g, ""), "no content lost");
});

test("renderError: budget cap, timeout and generic render distinct honest messages", () => {
  assert.match(renderError(new Error("budget proxy hard cap exceeded 429")), /spending cap/);
  assert.match(renderError(new Error("request timed out")), /too long/);
  assert.match(renderError(new Error("boom")), /went wrong/);
});

test("cancel: in-flight turn aborts and resolves; cancel with no turn returns false", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cancel-"));
  const config = configFromEnv({ SDK_APP_AUDIT_LOG: join(dir, "a.jsonl"), SDK_APP_APPROVALS_LOG: join(dir, "p.jsonl") } as any);
  const audit = new AuditLog(config.auditLog);
  const approvals = new ApprovalStore(config.approvalsLog);
  const fakeQuery = (({ options }: any) => {
    return (async function* () {
      await new Promise((_, rej) => {
        options.abortController.signal.addEventListener("abort", () => rej(new Error("The operation was aborted")));
      });
    })();
  }) as any;
  const agent = new AgentCore({ config, approvals, audit, queryFn: fakeQuery, mcpServerFactory: () => ({}) as any });
  assert.equal(agent.cancel("nope"), 0);
  const turn = agent.chat("t1", "hi");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(agent.cancel("t1"), 1, "in-flight turn cancelled");
  await turn; // must resolve, not hang or throw
  assert.equal(agent.cancel("t1"), 0, "nothing left to cancel after the turn");
});

test("cancel: top-level stop in a channel cancels a turn running in that channel's thread", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cancel-ch-"));
  const config = configFromEnv({ SDK_APP_AUDIT_LOG: join(dir, "a.jsonl"), SDK_APP_APPROVALS_LOG: join(dir, "p.jsonl") } as any);
  const audit = new AuditLog(config.auditLog);
  const approvals = new ApprovalStore(config.approvalsLog);
  const fakeQuery = (({ options }: any) => {
    return (async function* () {
      await new Promise((_, rej) => {
        options.abortController.signal.addEventListener("abort", () => rej(new Error("The operation was aborted")));
      });
    })();
  }) as any;
  const agent = new AgentCore({ config, approvals, audit, queryFn: fakeQuery, mcpServerFactory: () => ({}) as any });
  const turn = agent.chat("C123:111.111", "hi");
  await new Promise((r) => setTimeout(r, 20));
  // a new top-level channel message gets its own ts -> different threadKey,
  // same channel; the fallback must still cancel the running thread turn
  assert.equal(agent.cancel("C123:999.999"), 1, "channel-level stop cancelled the thread turn");
  await turn;
  assert.equal(agent.cancel("C123:999.999"), 0, "nothing left to cancel");
});

test("cancel: does not reach across channels", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cancel-xch-"));
  const config = configFromEnv({ SDK_APP_AUDIT_LOG: join(dir, "a.jsonl"), SDK_APP_APPROVALS_LOG: join(dir, "p.jsonl") } as any);
  const audit = new AuditLog(config.auditLog);
  const approvals = new ApprovalStore(config.approvalsLog);
  let abortSeen = false;
  const fakeQuery = (({ options }: any) => {
    return (async function* () {
      await new Promise((res, rej) => {
        options.abortController.signal.addEventListener("abort", () => { abortSeen = true; rej(new Error("The operation was aborted")); });
        setTimeout(res, 60);
      });
    })();
  }) as any;
  const agent = new AgentCore({ config, approvals, audit, queryFn: fakeQuery, mcpServerFactory: () => ({}) as any });
  const turn = agent.chat("C123:111.111", "hi");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(agent.cancel("C999:999.999"), 0, "other channel untouched");
  assert.equal(abortSeen, false);
  await turn;
});

test("toMrkdwn converts **bold** to Slack *bold* but leaves code spans alone", async () => {
  const { toMrkdwn } = await import("../src/slack.js");
  assert.equal(toMrkdwn("a **bold** move"), "a *bold* move");
  assert.equal(toMrkdwn("`**not bold**` and **bold**"), "`**not bold**` and *bold*");
  assert.equal(toMrkdwn("no markup"), "no markup");
});
