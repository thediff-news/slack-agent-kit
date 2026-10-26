/** Smoke B (event-driven): approve -> ARMED write against a fake gh fixture.
 * Approval IDs come from the approvals LOG FILE (the ledger is the source of
 * truth), never from stdout regexes. No external effects: gh is /tmp/fake-bin/gh. */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { startBudgetProxy } from "./budget-proxy.mjs";

const realKey = process.env.ANTHROPIC_API_KEY ?? (process.env.SDK_APP_KEY_FILE ? readFileSync(process.env.SDK_APP_KEY_FILE, "utf8").trim() : "");
if (!realKey) throw new Error("ANTHROPIC_API_KEY (or SDK_APP_KEY_FILE) is required");
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

/** Poll the approvals ledger for a pending (requested, unresolved) id. */
const pendingId = (): string | null => {
  if (!existsSync("/tmp/smoke2-approvals.jsonl")) return null;
  const rows = readFileSync("/tmp/smoke2-approvals.jsonl", "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const resolved = new Set(rows.filter((r) => r.type === "resolved").map((r) => r.id));
  const pend = rows.filter((r) => r.type === "requested" && !resolved.has(r.req.id));
  return pend.length ? pend[pend.length - 1].req.id : null;
};
const until = (fn: () => boolean, ms: number, label: string) => new Promise<boolean>((resolve) => {
  const t0 = Date.now();
  const iv = setInterval(() => {
    if (fn()) { clearInterval(iv); resolve(true); }
    else if (Date.now() - t0 > ms) { clearInterval(iv); console.log(`[smokeB] TIMEOUT ${label}`); resolve(false); }
  }, 200);
});

await until(() => buf.includes("you> "), 90000, "ready");
send("Open an issue in thediff-news/slack-agent-kit titled 'armed-fixture test issue' about verifying the write path");
const gotPrompt = await until(() => pendingId() !== null, 60000, "approval request in ledger");
if (gotPrompt) send(`approve ${pendingId()}`);
const created = await until(() => buf.includes("issues/999"), 60000, "armed creation via fake gh");
send("quit");
await new Promise((r) => child.on("exit", r));
const audit = readFileSync("/tmp/smoke2-audit.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));
const ghLog = existsSync("/tmp/fake-gh-calls.log") ? readFileSync("/tmp/fake-gh-calls.log", "utf8").trim() : "";
console.log("\n[smokeB] VERDICT", JSON.stringify({
  approvalFlow: audit.some((e: any) => e.kind === "approval_requested") && audit.some((e: any) => e.kind === "approval_resolved" && e.detail.approved === true),
  toolExecuted: audit.some((e: any) => e.kind === "tool_call" && e.detail.tool === "github_create_issue" && e.detail.dryRun === false),
  armedWriteToFixture: created && /issue create --repo thediff-news\/slack-agent-kit/.test(ghLog),
  modelReportedUrl: buf.includes("issues/999"),
  costTotal: audit.filter((e: any) => e.kind === "turn_cost").reduce((a: number, e: any) => a + (e.detail.cost_usd || 0), 0).toFixed(6),
  auditChainOk: (await import("./src/audit.js")).AuditLog.verify("/tmp/smoke2-audit.jsonl") === null,
}));
proxy.close();
process.exit(0);
