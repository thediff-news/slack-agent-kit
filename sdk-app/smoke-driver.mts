/** Live smoke for sdk-app: real model through the budget proxy (hard $0.50 cap),
 * driving the CLI harness: docs question (read tools) + gated issue creation
 * (approve -> dry-run). Prints a verdict + exact costs from the audit log. */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { startBudgetProxy } from "./budget-proxy.mjs";

const realKey = process.env.ANTHROPIC_API_KEY ?? (process.env.SDK_APP_KEY_FILE ? readFileSync(process.env.SDK_APP_KEY_FILE, "utf8").trim() : "");
if (!realKey) throw new Error("ANTHROPIC_API_KEY (or SDK_APP_KEY_FILE) is required");
const proxy = await startBudgetProxy({
  totalUsd: 0.50, model: "claude-sonnet-5-5", maxOutputTokens: 2048,
  inputRatePerMTok: 2.50, outputRatePerMTok: 10,
  upstreamBase: "https://api.anthropic.com", realKey,
});
console.log(`[smoke] proxy on :${proxy.port} (hard cap $0.50)`);

const child = spawn("npx", ["tsx", "sdk-app/src/cli.ts"], {
  env: {
    ...process.env,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${proxy.port}`,
    ANTHROPIC_API_KEY: "proxy-managed",
    CLAUDE_CONFIG_DIR: "/tmp/smoke-claude-config",
    SDK_APP_DOCS_ROOT: "sdk-app/fixtures/docs",
    SDK_APP_AUDIT_LOG: "/tmp/smoke-audit.jsonl",
    SDK_APP_APPROVALS_LOG: "/tmp/smoke-approvals.jsonl",
    SDK_APP_MAX_TURNS: "6",
  },
  stdio: ["pipe", "pipe", "inherit"],
});

let buf = "";
const results: Record<string, boolean | string> = {};
const send = (s: string) => { console.log(`[smoke] >>> ${s}`); child.stdin.write(s + "\n"); };
const waitFor = (re: RegExp, ms: number, label: string) => new Promise<boolean>((resolve) => {
  const t0 = Date.now();
  const iv = setInterval(() => {
    if (re.test(buf)) { clearInterval(iv); resolve(true); }
    else if (Date.now() - t0 > ms) { clearInterval(iv); console.log(`[smoke] TIMEOUT waiting for ${label}`); resolve(false); }
  }, 200);
});

child.stdout.on("data", (d) => { const s = d.toString(); buf += s; process.stdout.write(s); });

await waitFor(/you> /, 60000, "harness ready");
if (!process.env.SMOKE_SKIP_DOCS) {
  send("How do I roll back a deploy? Cite the document you used.");
  results.docsAnswer = await waitFor(/revert the release PR/i, 120000, "docs-grounded answer");
  results.citedDoc = /deploy-runbook/i.test(buf);
}

send("Open an issue in thediff-news/slack-agent-kit titled 'flaky browse tests' about installing the headless shell.");
const gotApproval = await waitFor(/\[approval needed\] (\S+):/i, 120000, "approval prompt");
results.approvalPrompt = gotApproval;
if (gotApproval) {
  const id = /\[approval needed\] (\S+):/i.exec(buf)![1];
  send(`approve ${id}`);
  results.dryRunExecuted = await waitFor(/dry-run.*would create issue/i, 120000, "dry-run issue creation");
}
send("quit");
await new Promise((r) => child.on("exit", r));

const audit = readFileSync("/tmp/smoke-audit.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));
const costs = audit.filter((e: any) => e.kind === "turn_cost").map((e: any) => e.detail.cost_usd);
console.log("\n[smoke] VERDICT", JSON.stringify(results));
console.log("[smoke] turn costs:", costs, "total actual:", costs.reduce((a: number, b: number) => a + (b || 0), 0).toFixed(6));
console.log("[smoke] proxy cumulative bound:", proxy.spentBoundUsd().toFixed(4));
proxy.close();
process.exit(0);
