# Live testing

What has been verified against real services, and what is still mock-only.
Newest results first. "Live" means a real external service answered; the
bot ran in Socket Mode against a real Slack workspace with real approvals
clicked in the Slack client.

## 2026-10-19 - full E2E in the "Slacking" workspace (#general, bot @agent-kit)

Config: `kit.config.live.yaml` (gitignored - real workspace/user IDs). Slack
admin/approver is the workspace owner member ID; #general's channel ID is in
`permissions.channels` with `allow: ["*"]`. Bot runs with `SLACK_BOT_TOKEN`,
`SLACK_APP_TOKEN`, `GH_TOKEN` (repo-scope PAT) in the environment; keyless
(no OpenAI key), hashing embedder.

Live-verified flows, all in #general:

- Real `@agent-kit` mention -> company-brain, honest "I don't know" on an
  empty KB, ACL list correct for the admin role.
- `ingest rotation-policy.md` (filesystem) -> approval buttons -> Approve ->
  grounded answer with citation, freshness, ACL scope.
- Deny path: `ingest refund-policy.md` -> Deny -> "Denied by @zive",
  "Not approved - skipping", nothing ingested.
- `ingest github:thediff-news/slack-agent-kit/README.md` -> live `gh api`
  fetch, 10 chunks ingested.
- `ingest github:thediff-news/slack-agent-kit/issues/1` -> real issue
  (created for the demo) ingested via the issues API.
- `ingest web:<The Diff issue 016 URL>` -> live page fetch (16.5 KB) ->
  "what did The Diff No. 016 cover?" answered from real page content.
- `ingest web:<The Diff feed.xml>` -> live RSS ingest (newest items).
- `ingest slack-history:<channel>/<ts>` -> real Slack message ingested via
  conversations.history (bot token, channels:history scope from the
  manifest - no scope changes needed).
- incident: with a real traceback -> suspect commit from the fixture repo's
  real git history (guard-removing commit named, diff quoted) -> gated fix
  -> Approve -> done.
- alert: x3 with varying percentages -> same fingerprint, occurrence 2
  deduped, occurrence 3 proposed escalation -> Approve -> escalated.
- Multi-source answer: "what do we know about the checkout coupon
  incident?" cited the live GitHub issue AND the real Slack-history
  message, with per-source ACLs and freshness.

Bugs found live and fixed:

- `747d0aa` (feature): web/RSS + slack-history connectors, GitHub
  issues/PRs in the connector.
- `c28ef62` + `0a8adb4`: Slack auto-linkifies URLs into `<https://x>`
  mrkdwn; `ingest web:<url>` reached the web connector still bracketed and
  failed. Unwrap now runs after connector-prefix splitting; regression test
  covers `ingest docs:<page.md>` and `<url|label>` forms.

Mock-only (needs free accounts; signups authorized by the repo owner,
not yet done): Jira, Confluence (one Atlassian account covers both),
Notion. Connectors are unit-tested against recorded API shapes only.

## 2026-10-18 / 19 - earlier rounds

- CLI demo harness, credential-triage demo, ACL hardening (f678d6a),
  display fixes (4941c67), approval buttons replaced with a decision line
  after click (d94abf0), data-dir creation on first run (8b22abc).
