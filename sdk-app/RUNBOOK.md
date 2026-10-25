# sdk-app: running the SDK-native kit

The SDK-native rebuild of slack-agent-kit: the Claude Agent SDK `query()` loop
is the agent runtime; the kit's capabilities are exposed as an in-process MCP
server ("kit") with permission gates. Surfaces: Slack (Bolt socket mode) and a
local CLI; both drive the same AgentCore.

## Prerequisites

- Node 22+, `npm install` at the repo root, `npx playwright install chromium-headless-shell` (browse tools only).
- Env: `SLACK_BOT_TOKEN` (xoxb-), `SLACK_APP_TOKEN` (xapp-, socket mode), `ANTHROPIC_API_KEY`.
- Optional SaaS reads: `ATLASSIAN_SITE` (with https://), `ATLASSIAN_EMAIL`, `ATLASSIAN_API_TOKEN`, `NOTION_API_KEY`.

## Run

```sh
npx tsx sdk-app/run-slack.mts        # Slack surface + budget proxy in one process
npx tsx sdk-app/cli.ts               # local operator CLI (same AgentCore)
```

`run-slack.mts` starts a localhost budget proxy with a hard dollar cap
(`SDK_APP_PROXY_CAP_USD`, default 2.00) and points the SDK at it. The Slack
surface is socket mode: outbound websocket only, no inbound ports or public
URL needed - any always-on machine (a laptop under pm2/systemd, a home box, a
VM) can host it.

## Configuration (all env, no secrets in code)

| env | meaning | default |
|---|---|---|
| `SDK_APP_MODEL` | agent model | `claude-sonnet-5-5` |
| `SDK_APP_DOCS_ROOT` | filesystem docs root | `docs` |
| `SDK_APP_GITHUB_REPOS` | comma-separated repos the github connector reads | - |
| `SDK_APP_CONNECTORS` | JSON array: filesystem/github/web/slack-history/jira/confluence/notion | legacy fs+github |
| `SDK_APP_AUDIT_LOG` / `SDK_APP_APPROVALS_LOG` | append-only audit + approval ledger paths | `sdk-app/state/` |
| `SDK_APP_RAG_DB` | retrieval index path | `sdk-app/state/rag.db` |
| `SDK_APP_DRY_RUN` | `1` = mutating tools simulate | `1` |
| `SDK_APP_APPROVERS` | comma-separated Slack user IDs with approval authority | empty (locked) |
| `SDK_APP_USER_ACLS` | JSON `{userId: [extra retrieval tags]}` | `{}` |
| `SDK_APP_RBAC_USERS` / `SDK_APP_RBAC_ROLES` / `SDK_APP_RBAC_ROLE_ACLS` | JSON role model (kit permissions port) | `{}` |
| `SDK_APP_CHANNEL_POLICIES` | JSON `{channelId: {allow: [tool names]}}` (`*` = all) | `{}` |
| `SDK_APP_PUBLIC_SYNC` | `1` lets unenrolled users run sync_docs | off |
| `SDK_APP_BROWSE_ALLOWLIST` | seed hosts for the persisted browse allowlist | - |
| `SDK_APP_PROXY_CAP_USD` | hard spend cap for the budget proxy | `2.00` |

## Safety model

- Unknown Slack user: `search_docs` + `get_doc` on `public` docs only.
- Enrolled identity (ACL map / approvers / RBAC role): capabilities per role -
  `read` for doc reads, `propose` for sync/factory/browse/mutating tools.
- Approval authority: `SDK_APP_APPROVERS` or a role with the explicit
  `approve` capability. The ACL map never grants it.
- Every mutating tool call needs a human approval, resolved by a named
  approver in the SAME Slack thread; approvals survive restarts and resolve once.
- Browse: persisted host allowlist; new hosts and irreversible clicks need approval.
- Channel policies restrict which tools run in which channels.
- All tool calls and decisions land in a hash-chained audit log (`AuditLog.verify`).

## Slack usage

- Mention @botname or DM. `approve <id>` / `deny <id>` answer a gate in-thread.
- `stop` cancels the current turn in that thread.
- Long answers are chunked; errors render as plain-language messages.

## Tests

`cd sdk-app && npx tsx --test tests/*.test.ts`
