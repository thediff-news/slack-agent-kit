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
  assert.equal(agent.cancel("nope"), false);
  const turn = agent.chat("t1", "hi");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(agent.cancel("t1"), true, "in-flight turn cancelled");
  await turn; // must resolve, not hang or throw
  assert.equal(agent.cancel("t1"), false, "nothing left to cancel after the turn");
});
