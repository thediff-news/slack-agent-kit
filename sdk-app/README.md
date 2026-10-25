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

## Verification

- `npx tsx --test sdk-app/tests/*.test.ts` — 9 tests, no API calls:
  approvals resolve-once/deny/restart-resurface, tool handlers, session
  resume, streaming, per-turn cost audit, mutating-tool gate
  (approve→allow, deny→deny), built-in Bash default-denied.
- Live smoke through the budget proxy: see PR description (cost, turns,
  approval flow exercised end-to-end against the real model).
