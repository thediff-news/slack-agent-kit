# Spike: Claude Agent SDK code stage in a verified sandbox

Status: implementation complete, sandbox isolation verified; live bench BLOCKED on an Anthropic API key (no credential in authorized scope as of 2026-10-25).

## What this adds

A new factory code-stage engine `codeEngine: "claude"` (default remains `"llm"`):

- `scripts/claude-code-stage.mts` - one edit round via the Claude Agent SDK
  (`@anthropic-ai/claude-agent-sdk`, Claude Code's agent loop as a library).
  Captures turns, tool-use counts, duration, and `total_cost_usd` from the SDK
  result message into `.claude-stage-result.json`.
- The whole agent process tree (model loop + Read/Edit/Write/Grep/Bash tools)
  runs INSIDE the Anthropic Sandbox Runtime (`srt`,
  `@anthropic-ai/sandbox-runtime`), wrapped by the pipeline:
  `srt --settings <file> -- tsx scripts/claude-code-stage.mts ...`
- `buildSrtSettings()` confines each round:
  - read: the workdir + this repo's `node_modules` (SDK/CLI binaries); the rest
    of `$HOME` is denied (bubblewrap: those paths are not even visible)
  - write: the workdir + OS tmpdir only
  - network: `api.anthropic.com` only (the SDK's one required egress)
- `claudeSandboxEnv()` scopes the environment: only PATH/HOME/TMPDIR/LANG and
  `ANTHROPIC_API_KEY` (+ optional `ANTHROPIC_BASE_URL`) enter the sandbox.
  Pipeline secrets (`OPENAI_API_KEY`, `GITHUB_TOKEN`, ...) never do.
- `permissionMode: "bypassPermissions"` for autonomous rounds; the srt sandbox
  is the security boundary, not interactive prompts. `settingSources: []` keeps
  runs hermetic (no user/project settings leak in).
- Same caps as the opencode spike: 480 s process-group kill per round,
  `maxEditRounds`, and a per-round turn cap (`claudeMaxTurns`, default 30).

## Isolation evidence (verified, not claimed)

`npx tsx scripts/claude-sandbox-probe.mts` runs six checks through the exact
settings the pipeline uses. Result on this bench container (2026-10-25):

```
PASS  read $HOME canary blocked      (file invisible inside the sandbox)
PASS  read workdir file works
PASS  write outside workdir blocked  (verified: no file created)
PASS  write inside workdir works
PASS  api.anthropic.com reachable    (HTTP 401 through the sandbox proxy)
PASS  example.com blocked            (proxy refuses CONNECT)
ALL 6 CHECKS PASSED
```

Unlike the opencode spike (external CLI, no isolation beyond the prompt) and
Claude Code's built-in sandboxed Bash tool (shell commands only), here the
ENTIRE agent - including its file read/edit tools - is OS-confined. A
prompt-injected agent cannot read credentials outside the workdir, write
outside the workdir, or exfiltrate to any host but the Anthropic API.

## Sources (owning docs, fetched 2026-10-25)

- SDK overview: https://docs.claude.com/en/api/agent-sdk/overview
- Quickstart (auth = ANTHROPIC_API_KEY): https://code.claude.com/docs/en/agent-sdk/quickstart
- Configuration (options: model, maxTurns, env, settingSources): https://code.claude.com/docs/en/agent-sdk/configuration
- Sandboxed Bash tool / sandbox settings: https://code.claude.com/docs/en/sandboxing
- Sandbox environments comparison: https://code.claude.com/docs/en/sandbox-environments
- Sandbox runtime: https://github.com/anthropics/sandbox-runtime
- Pricing: https://docs.claude.com/en/docs/about-claude/pricing
  (Sonnet 5: $2/MTok in, $10/MTok out; Haiku 4.5: $1/$5; Opus 5: $5/$25)

## Tradeoffs / notes

- Running the whole agent in the sandbox means the API key lives inside the
  sandboxed env. Mitigation: network allowlist admits only api.anthropic.com,
  so the key can only leave toward Anthropic itself.
- Claude Code's built-in sandboxed-Bash layer is NOT stacked on top (nested
  bubblewrap); the outer srt boundary already confines every Bash child.
- The `srt` CLI parses flags until `--`; commands with their own flags must
  follow a `--` separator (pipeline does this).
- Wall-clock timings on the bench host are meaningless (host suspends);
  the 480 s round cap is process time. The SDK's own `duration_ms` and
  `total_cost_usd` are the trustworthy measurements.

## Bench (pending API key)

`npx tsx bench/bench-factory-cc.mts [model] [maxTurns]` runs the same factory
task (HttpPlanner missing-timeout bug) with the same PASS standard as the
Oct 20 baseline and the opencode spike: harness suite green after edit rounds,
correctness of the fix checked independently. Env: `OPENAI_API_KEY`
(triage/plan/repro stages stay on the kit's OpenAI llm) and `ANTHROPIC_API_KEY`.

## 2026-10-25 PM: smoke PASS, factory bench BUDGET-STOPPED (FAIL)

Smoke: full stack (srt + budget proxy + SDK, Sonnet 5.5) answered
SANDBOX_SMOKE_OK in 1 turn, 2.7s SDK duration, $0.030209 actual.
Bench (HttpPlanner timeout task, stubbed non-code stages, changed conditions):
3 rounds, all budget-stopped in exploration, no diff, FAIL. Exact costs and the
reservation analysis: bench/results/2026-10-25-claude-sonnet-5-5-budget-stopped.md.

Budget-proxy lessons (both fixed):
- Per-request bound reserves worst case (provider-enforced max_tokens output
  ceiling + count_tokens input priced twice - billing undocumented - at
  cache-write rate + 15% padding). Reservation/actual ratio measured 15-45x.
  Size round caps against the bound structure, not expected actuals.
- The per-round proxy reset cumulative reservation; cross-round guarantee came
  only from the pipeline's actuals gate. Fixed: each round's proxy cap now
  carries prior reservation (min(round budget, total cap - bound so far)), so
  total reserved <= total cap as well as total actual <= total cap.
- count_tokens rejects request bodies containing newer fields (per-message
  output_config on Sonnet 5.5): strip them for the count call only; a failed
  count fails CLOSED (request rejected).
- Node 22 https: request-level createConnection is ignored with agent:false;
  override agent.createConnection for CONNECT-tunneled upstreams inside srt.
