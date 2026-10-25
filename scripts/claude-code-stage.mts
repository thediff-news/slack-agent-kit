/**
 * Claude Agent SDK code-stage wrapper (spike).
 *
 * Runs ONE factory edit round with the Claude Agent SDK (Claude Code's agent
 * loop as a library). This process is meant to run INSIDE the Anthropic
 * Sandbox Runtime (`srt`): the pipeline spawns it as
 *   srt --settings <file> -- tsx scripts/claude-code-stage.mts ...
 * so the whole agent - model loop, Read/Edit/Write tools, and every Bash
 * command - is confined by the OS-level sandbox, not just its shell commands.
 *
 * Input:  --dir <workdir> --prompt-file <path> --result-file <path>
 *         --model <alias|id> --max-turns <n> [--max-budget-usd <n>]
 * Output: result JSON written to --result-file:
 *   { ok, subtype, resultText, numTurns, durationMs, totalCostUsd, usage,
 *     sessionId, toolUseCounts, peakInputSideTokens, errors }
 * Progress lines go to stdout (captured by the pipeline for audit).
 *
 * Enforced cost bounds (all verified against the installed SDK/CLI):
 *  - CLAUDE_CODE_MAX_OUTPUT_TOKENS=8192 caps output per request (thinking
 *    counts inside output tokens).
 *  - Tool-result caps (file reads 4096 tokens, bash 4096 chars) bound
 *    per-turn context growth.
 *  - disallowedTools removes server-billed tools (WebSearch) and subagents
 *    (Task) whose per-request usage would escape the measured guard.
 *  - Measured-context guard: if any response shows >150k input-side tokens
 *    (input+cache read+cache write), the query is interrupted before the
 *    next request. Bounds the worst in-flight request to ~188k tokens, inside
 *    the verified (un-tiered) pricing region.
 *  - maxBudgetUsd (SDK estimate stop between requests) + maxTurns + the
 *    pipeline's 480s process-group kill.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface StageArgs {
  dir: string;
  promptFile: string;
  resultFile: string;
  model: string;
  maxTurns: number;
  maxBudgetUsd?: number;
}

export function parseArgs(argv: string[]): StageArgs {
  const get = (flag: string, dflt?: string): string => {
    const i = argv.indexOf(flag);
    if (i >= 0 && argv[i + 1]) return argv[i + 1];
    if (dflt !== undefined) return dflt;
    throw new Error(`missing ${flag}`);
  };
  return {
    dir: resolve(get("--dir")),
    promptFile: get("--prompt-file"),
    resultFile: get("--result-file"),
    model: get("--model", "claude-sonnet-5-5"),
    maxTurns: Number(get("--max-turns", "8")),
    ...(argv.includes("--max-budget-usd") ? { maxBudgetUsd: Number(get("--max-budget-usd")) } : {}),
  };
}

const CONTEXT_HARD_TOKENS = 150_000;

export async function runStage(args: StageArgs): Promise<void> {
  const prompt = readFileSync(args.promptFile, "utf8");
  // HOME inside the sandbox must be writable and confined: the CLI writes
  // session state under ~/.claude. Point it at a dir inside the workdir.
  const home = join(args.dir, ".claude-home");
  mkdirSync(home, { recursive: true });
  const env: Record<string, string> = {
    ...process.env,
    HOME: home,
    // keep non-API chatter (telemetry/error reporting) out of the way of the
    // network allowlist, which admits api.anthropic.com only
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    // enforced per-request bounds (names verified in the bundled CLI)
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: "8192",
    CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS: "4096",
    BASH_MAX_OUTPUT_LENGTH: "4096",
  } as Record<string, string>;

  const out: Record<string, unknown> = {
    ok: false, subtype: "no_result", resultText: "", numTurns: 0,
    durationMs: 0, totalCostUsd: null, usage: null, sessionId: null,
    toolUseCounts: {} as Record<string, number>, peakInputSideTokens: 0,
    errors: [] as string[],
  };
  const toolUseCounts = out.toolUseCounts as Record<string, number>;
  const errors = out.errors as string[];
  const t0 = Date.now();
  let peakInputSide = 0;

  const q = query({
    prompt,
    options: {
      model: args.model,
      cwd: args.dir,
      maxTurns: args.maxTurns,
      ...(args.maxBudgetUsd ? { maxBudgetUsd: args.maxBudgetUsd } : {}), // estimate stop between requests: error_max_budget_usd
      permissionMode: "bypassPermissions", // autonomous factory round; the srt sandbox is the boundary
      disallowedTools: ["WebSearch", "WebFetch", "Task", "Agent"], // no server-billed tools / subagents
      env,
      settingSources: [], // hermetic: ignore user/project/local settings files
    },
  });

  try {
    for await (const message of q) {
      const m = message as any;
      if (m.type === "assistant") {
        const u = m.message?.usage;
        if (u) {
          const inputSide = Number(u.input_tokens ?? 0) + Number(u.cache_read_input_tokens ?? 0) + Number(u.cache_creation_input_tokens ?? 0);
          peakInputSide = Math.max(peakInputSide, inputSide);
          if (inputSide > CONTEXT_HARD_TOKENS) {
            errors.push(`context-guard: input-side ${inputSide} tokens > ${CONTEXT_HARD_TOKENS}; interrupting before next request`);
            try { await q.interrupt(); } catch { /* single-input mode may not support control requests */ }
            break; // ends iteration; Query.return() tears down the CLI child
          }
        }
        for (const block of m.message?.content ?? []) {
          if (block?.type === "tool_use") {
            toolUseCounts[block.name] = (toolUseCounts[block.name] ?? 0) + 1;
            console.log(`[claude-stage] tool ${block.name} ${JSON.stringify(block.input ?? {}).slice(0, 160)}`);
          } else if (block?.type === "text" && block.text) {
            console.log(`[claude-stage] text ${String(block.text).slice(0, 200)}`);
          }
        }
      } else if (m.type === "result") {
        out.subtype = m.subtype;
        out.ok = m.subtype === "success" && !m.is_error;
        out.resultText = typeof m.result === "string" ? m.result : "";
        out.numTurns = m.num_turns ?? 0;
        out.durationMs = m.duration_ms ?? (Date.now() - t0);
        out.totalCostUsd = m.total_cost_usd ?? null;
        out.usage = m.usage ?? null;
        out.sessionId = m.session_id ?? null;
        if (m.is_error) errors.push(`result is_error: ${m.subtype}`);
        console.log(`[claude-stage] result ${m.subtype} turns=${out.numTurns} cost=${out.totalCostUsd}`);
      } else if (m.type === "system" && m.subtype === "init") {
        out.sessionId = m.session_id ?? out.sessionId;
        console.log(`[claude-stage] init model=${m.model ?? "?"} tools=${(m.tools ?? []).length}`);
      }
    }
  } catch (e) {
    errors.push((e as Error).message.slice(0, 2000));
    console.log(`[claude-stage] exception ${(e as Error).message.slice(0, 300)}`);
  }
  out.peakInputSideTokens = peakInputSide;
  out.durationMs = (out.durationMs as number) || Date.now() - t0;
  writeFileSync(args.resultFile, JSON.stringify(out, null, 2));
  if (!out.ok) process.exitCode = 1;
}

if (process.argv[1] && process.argv[1].endsWith("claude-code-stage.mts")) {
  await runStage(parseArgs(process.argv.slice(2)));
}
