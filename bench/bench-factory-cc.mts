/**
 * Bench: factory code stage via Claude Agent SDK in the srt sandbox.
 * Same factory task / caps / PASS standard as the Oct 20 baseline and the
 * opencode spike: PASS = harness test suite green after the edit rounds.
 * Usage: npx tsx bench/bench-factory-cc.mts [model] [maxTurns]
 * Env: OPENAI_API_KEY (triage/plan/repro stages), ANTHROPIC_API_KEY (code stage).
 */
import { runFactory } from "../src/factory/pipeline.js";
import { openAiFromEnv } from "../src/llm/openai.js";
import { writeFileSync } from "node:fs";

const model = process.argv[2] || "claude-sonnet-5-5"; // user-steered 2026-10-25
const maxTurns = Number(process.argv[3] || "8"); // output-capped turns keep context inside verified pricing region
// budget guards (SDK estimate stop per round + cumulative total with in-flight reserve)
const roundBudget = Number(process.env.CLAUDE_ROUND_BUDGET_USD || "0.60");
const totalBudget = Number(process.env.CLAUDE_TOTAL_BUDGET_USD || "1.90");
// FACTORY_STUB_STAGES=1: deterministic non-code stages (CHANGED benchmark
// conditions, zero paid OpenAI calls); otherwise live gpt-5 stages.
import { stubLlm } from "./stub-llm.mjs";
const useStub = process.env.FACTORY_STUB_STAGES === "1";
const base = useStub ? null : openAiFromEnv()!.llm;
const llm = useStub
  ? stubLlm()
  : { model: process.env.OPENAI_CHAT_MODEL ?? "gpt-5", get lastUsage() { return base!.lastUsage; }, chat: (msgs: any, _opts?: any) => base!.chat(msgs, { reasoningEffort: "low" as any }) };
const stageLlms = useStub ? { triage: stubLlm(), plan: stubLlm(), repro: stubLlm(), review: stubLlm() } : undefined;
const audit: { ts: number; event: string; detail: string }[] = [];
const t0 = Date.now();
const request = "the browse planner (HttpPlanner in src/browse/planner.ts) calls the model endpoint with fetch but sets no timeout. If the endpoint accepts the connection and never replies, plan() hangs forever and the whole browse run stalls until the loop time cap. Expected: plan() gives up after a configurable timeout (env BROWSE_MODEL_TIMEOUT_MS, default around 60s) and returns a fail step with the timeout in the reason.";
try {
  const res = await Promise.race([
    runFactory({
      repo: "thediff-news/slack-agent-kit", request, llm: llm as any, ...(stageLlms ? { llms: stageLlms as any } : {}), maxEditRounds: 3,
      codeEngine: "claude" as const, claudeModel: model, claudeMaxTurns: maxTurns, claudeSandbox: true, claudeMaxBudgetUsd: roundBudget, claudeTotalBudgetUsd: totalBudget,
      hooks: { audit: (event, detail) => audit.push({ ts: Date.now() - t0, event, detail }), approvePlan: async () => true, note: () => {} },
      openPr: async () => "bench://no-pr",
    }),
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error("bench timeout 20m")), 1_200_000)),
  ]);
  writeFileSync(`/tmp/bench-cc-${model}.json`, JSON.stringify({ model, maxTurns, roundBudget, totalBudget, sandbox: true, wallMs: Date.now() - t0, ok: res.ok, stage: res.stage, summary: res.summary, reproTest: res.reproTest, audit }, null, 2));
  console.log("DONE", model, res.ok, res.stage, Date.now() - t0);
  process.exit(0);
} catch (e) {
  writeFileSync(`/tmp/bench-cc-${model}.json`, JSON.stringify({ model, maxTurns, roundBudget, totalBudget, sandbox: true, wallMs: Date.now() - t0, ok: false, stage: "bench-error", summary: (e as Error).message, audit }, null, 2));
  console.log("ERROR", model, (e as Error).message.slice(0, 200));
  process.exit(1);
}
