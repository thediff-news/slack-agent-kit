# sdk-app — the kit, rebuilt natively on the Claude Agent SDK

The Claude Agent SDK's `query()` loop **is** the agent runtime. There is no
kit pipeline, no per-stage planner, no custom orchestration: a user message
goes into an SDK session, the model drives, and the app only renders text
and collects human decisions.

## Architecture

```
Slack message (Bolt socket mode)  or  CLI harness (verification)
        |                                   |
        +-------------> AgentCore <---------+
                        |  one SDK session per thread (resume)
                        v
              Claude Agent SDK query()  (claude-sonnet-5-5)
                        |
        +---------------+----------------+
        |                                |
  in-process MCP server "kit"      canUseTool permission gate
  - search_docs (read)             - read tools: auto-allow
  - get_doc (read)                 - mutating tools: human approval
  - github_create_issue (MUTATING) - anything else (Bash etc.): DENY
        |                                |
   kit connectors (fs/GitHub)      ApprovalStore (JSONL, resolve-once,
                                   pending resurfaced after restart)
        |
   AuditLog (append-only JSONL: messages, tool calls, decisions, per-turn cost)
```

## What carries over from the kit (and what doesn't)

| kit guarantee | sdk-app |
|---|---|
| agent loop: custom factory pipeline | **SDK `query()` loop, sessions resumed per thread** |
| tools: bespoke skills | in-process SDK MCP tools over the same connectors |
| approval gate: durable core approvals | `canUseTool` + ApprovalStore (JSONL ledger, resolve-once, resurface on restart) |
| audit: hash-chained JSONL | append-only JSONL (hash chain not yet ported) |
| RBAC | not yet ported (single-user trust model for now) |
| durable execution / replay | SDK session resume; pi-durable not ported |

## Running

Verification (never posts anywhere): `npx tsx sdk-app/src/cli.ts`
Slack (needs approval + tokens): `SLACK_BOT_TOKEN=… SLACK_APP_TOKEN=… npx tsx sdk-app/src/slack.ts`

Env: `SDK_APP_MODEL` (default claude-sonnet-5-5), `SDK_APP_DOCS_ROOT`,
`SDK_APP_GITHUB_REPOS`, `SDK_APP_MAX_TURNS` (default 8),
`SDK_APP_DRY_RUN=0` arms the mutating tool (default: simulate),
`ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` (budget proxy) are passed to sessions.

## Factory workflow gates (enforced, not prompted)

A bug-fix case collects evidence from ACTUAL tool calls into a per-case ledger
(app state dir, never inside the clone where repo code could forge it):

- source edits are refused until reproduction evidence exists: a failing test
  run (real exit code) captured while the source is untouched, or - for UI
  cases (screenshot attached, or the clone was served/rendered) - browser
  interaction + screenshot evidence against the factory's loopback server,
  plus a `factory_record_ui_state` observation the app independently re-reads
  from the live page and rejects when it does not match;
- `factory_create_pr` refuses without: repro evidence, a passing full test run
  on the FINAL diff, and (UI cases) fresh after-fix screenshot + verified
  observation on the final diff. Freshness is a git tree hash (HEAD + full
  diff incl. untracked), so edits made outside the tools still invalidate it.

Non-UI bugs prove out with the failing test alone; test files are always
writable (the failing regression test is the first step, never deadlocked).

## Verification

- `npx tsx --test sdk-app/tests/*.test.ts` — no API calls.
- Fresh clone setup: `npm ci && npm rebuild better-sqlite3 && npx playwright install chromium-headless-shell`
  (skipping the rebuild leaves the RAG store without native bindings; skipping
  the browser install fails every browse test).
- Live smoke through the budget proxy: see PR description.
