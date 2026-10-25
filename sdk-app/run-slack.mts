/** Production launcher: budget proxy (hard cap) + Slack surface in one process.
 * Tokens come from the environment (launcher injects them), never from the command line or logs. */
import { readFileSync } from "node:fs";
import { startBudgetProxy } from "./budget-proxy.mjs";
import { startSlackApp } from "./src/slack.js";
import { configFromEnv, evalPreflightProblems } from "./src/config.js";

const realKey = process.env.ANTHROPIC_API_KEY ?? (process.env.SDK_APP_KEY_FILE ? readFileSync(process.env.SDK_APP_KEY_FILE, "utf8").trim() : "");
if (!realKey) throw new Error("ANTHROPIC_API_KEY (or SDK_APP_KEY_FILE) is required");
const model0 = process.env.SDK_APP_PROXY_MODELS || "claude-sonnet-5-5";
const rates0 = (() => { try { return JSON.parse(process.env.SDK_APP_PROXY_RATES || "{}") } catch { return {}; } })();
const proxy = await startBudgetProxy({
  totalUsd: Number(process.env.SDK_APP_PROXY_CAP_USD || "2.00"),
  // comma-separated allowlist; every non-first model needs a verified price in
  // SDK_APP_PROXY_RATES (JSON: {"model-id": {"input": <$/MTok>, "output": <$/MTok>}});
  // a rates entry for the FIRST model overrides the fallback reserve price below.
  model: model0, maxOutputTokens: 4096,
  inputRatePerMTok: rates0[model0]?.input ?? 2.50, outputRatePerMTok: rates0[model0]?.output ?? 10,
  rates: rates0,
  upstreamBase: "https://api.anthropic.com", realKey,
  statePath: process.env.SDK_APP_PROXY_STATE || undefined,
  journalPath: process.env.SDK_APP_PROXY_JOURNAL || (process.env.SDK_APP_PROXY_STATE ? process.env.SDK_APP_PROXY_STATE.replace(/\.json$/, '') + '-journal.jsonl' : undefined),
  basisUsd: Number(process.env.SDK_APP_PROXY_BASIS_USD || "0"),
});
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${proxy.port}`;
process.env.ANTHROPIC_API_KEY = "proxy-managed";
console.log(`[run-slack] budget proxy on :${proxy.port} (hard cap ${process.env.SDK_APP_PROXY_CAP_USD || "2.00"} USD)`);
const cfg = configFromEnv();
if ((process.env.SDK_APP_EVAL_LOCKDOWN || "") === "1") {
  const problems = evalPreflightProblems(cfg);
  if (problems.length) { console.error("[run-slack] EVAL PREFLIGHT FAILED:\n - " + problems.join("\n - ")); process.exit(1); }
  console.log(`[run-slack] EVAL PREFLIGHT OK: repos=${cfg.githubRepos.join(",")} approvers=${cfg.approvers.length} acls=${Object.keys(cfg.userAcls).length} dryRun=${cfg.dryRun} maxTurns=${cfg.maxTurnsPerMessage} browseAllowlist=${cfg.browseAllowlist.join(",")} proxyState=${process.env.SDK_APP_PROXY_STATE}`);
}
await startSlackApp();
