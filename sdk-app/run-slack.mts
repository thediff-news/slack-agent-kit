/** Production launcher: budget proxy (hard cap) + Slack surface in one process.
 * Tokens come from the environment (launcher injects them), never from the command line or logs. */
import { readFileSync } from "node:fs";
import { startBudgetProxy } from "./budget-proxy.mjs";
import { startSlackApp } from "./src/slack.js";

const realKey = process.env.ANTHROPIC_API_KEY ?? (process.env.SDK_APP_KEY_FILE ? readFileSync(process.env.SDK_APP_KEY_FILE, "utf8").trim() : "");
if (!realKey) throw new Error("ANTHROPIC_API_KEY (or SDK_APP_KEY_FILE) is required");
const proxy = await startBudgetProxy({
  totalUsd: Number(process.env.SDK_APP_PROXY_CAP_USD || "2.00"),
  model: "claude-sonnet-5-5", maxOutputTokens: 4096,
  inputRatePerMTok: 2.50, outputRatePerMTok: 10,
  upstreamBase: "https://api.anthropic.com", realKey,
});
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${proxy.port}`;
process.env.ANTHROPIC_API_KEY = "proxy-managed";
console.log(`[run-slack] budget proxy on :${proxy.port} (hard cap ${process.env.SDK_APP_PROXY_CAP_USD || "2.00"} USD)`);
await startSlackApp();
