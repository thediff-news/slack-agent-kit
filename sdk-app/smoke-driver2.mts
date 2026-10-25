/** Smoke B: deny leg + armed write against a fake gh (local fixture).
 * Turn A: issue request -> deny -> model must NOT call the tool.
 * Turn B: issue request -> approve -> SDK_APP_DRY_RUN=0 -> fake gh executes. */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { startBudgetProxy } from "./budget-proxy.mjs";

const realKey = readFileSync("KEY-FROM-ENV", "utf8").trim();
const proxy = await startBudgetProxy({
  totalUsd: 0.50, model: "claude-sonnet-5-5", maxOutputTokens: 2048,
  inputRatePerMTok: 2.50, outputRatePerMTok: 10,
  upstreamBase: "https://api.anthropic.com", realKey,
});
const child = spawn("npx", ["tsx", "sdk-app/src/cli.ts"], {
  env: { ...process.env, PATH: `/tmp/fake-bin:${process.env.PATH}`,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${proxy.port}`, ANTHROPIC_API_KEY: "proxy-managed",
    CLAUDE_CONFIG_DIR: "/tmp/smoke-claude-config",
    SDK_APP_DOCS_ROOT: "sdk-app/fixtures/docs", SDK_APP_AUDIT_LOG: "/tmp/smoke2-audit.jsonl",
    SDK_APP_APPROVALS_LOG: "/tmp/smoke2-approvals.jsonl", SDK_APP_MAX_TURNS: "6", SDK_APP_DRY_RUN: "0" },
  stdio: ["pipe", "pipe", "inherit"],
});
let buf = "";
child.stdout.on("data", (d) => { buf += d.toString(); process.stdout.write(d); });
const send = (s: string) => { console.log(`[smokeB] >>> ${s}`); child.stdin.write(s + "\n"); };
let cursor = 0; // only match NEW output - never re-match a previous turn's prompt
const waitFor = (re: RegExp, ms: number, label: string) => new Promise<boolean>((resolve) => {
  const t0 = Date.now();
  const iv = setInterval(() => {
    const fresh = buf.slice(cursor);
    if (re.test(fresh)) { cursor = buf.length; clearInterval(iv); resolve(true); }
    else if (Date.now() - t0 > ms) { clearInterval(iv); console.log(`[smokeB] TIMEOUT ${label}`); resolve(false); }
  }, 200);
});
await waitFor(/you> /, 90000, "ready");
let deniedAck = true;
if (!process.env.SMOKE_B_SKIP_DENY) {
  send("Open an issue in thediff-news/slack-agent-kit titled 'deny-path test issue'");
  await waitFor(/\[approval needed\] (\S+):/i, 60000, "approval A");
  const idA = /\[approval needed\] (\S+):/i.exec(buf.slice(cursor))?.[1];
  if (idA) send(`deny ${idA}`);
  deniedAck = await waitFor(/denied|not created|won't create|will not create/i, 60000, "deny acknowledgement");
}
send("Open an issue in thediff-news/slack-agent-kit titled 'approve-path test issue'");
await waitFor(/\[approval needed\] (\S+):/i, 60000, "approval B");
const idB = /\[approval needed\] (\S+):/i.exec(buf.slice(cursor - buf.length + (cursor = buf.length, 0) + buf.length))?.[1] ?? /\[approval needed\] (\S+):/i.exec(buf.slice(cursor))?.[1];
if (idB) send(`approve ${idB}`);
const created = await waitFor(/issues\/999/, 60000, "armed creation via fake gh");
send("quit");
await new Promise((r) => child.on("exit", r));
const audit = readFileSync("/tmp/smoke2-audit.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));
const ghCalls = audit.filter((e: any) => e.kind === "tool_call" && e.detail.tool === "github_create_issue");
const denials = audit.filter((e: any) => e.kind === "approval_resolved" && e.detail.approved === false);
console.log("\n[smokeB] VERDICT", JSON.stringify({
  deniedAck, denialRecorded: denials.length === 1,
  noToolCallAfterDeny: ghCalls.length === 1, // exactly one: the approved one
  armedWriteExecuted: created, ghCalls: ghCalls.length,
  costTotal: audit.filter((e: any) => e.kind === "turn_cost").reduce((a: number, e: any) => a + (e.detail.cost_usd || 0), 0).toFixed(6),
}));
proxy.close();
process.exit(0);
