# slack-agent-kit

Generic infrastructure for **approval-gated chat agents**: a bot that lives in
Slack, investigates with your internal sources, answers with evidence, and
never takes a mutating action without a human's approval.

Built on [`@earendil-works/pi-durable`](https://github.com/earendil-works/pi)
(MIT) for replay-safe durable state; the Slack surface follows the
architecture of [vercel-labs/eve-sre-agent-template](https://github.com/vercel-labs/eve-sre-agent-template)
(MIT, architecture reference only - no Vercel platform dependency here).
The evaluation and tradeoffs are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

```
Slack mention / watched channel / webhook / CLI
        |
        v
  normalize event (idempotency key)
        |
        v
  dedup ---- duplicate? -> drop, audit, done
        |
        v
  route to skill -> RBAC check -> investigate
        |                     (connectors + RAG)
        v
  findings posted with source links
        |
        v
  mutating action? -> APPROVAL GATE (durable, survives restarts)
        |                     |
     denied               approved
        |                     |
       stop          idempotent execute -> audit
```

## What's in the box

- **Slack adapter** (`src/adapters/slack.ts`) - Bolt in Socket Mode: listens on
  channels, triggers on mentions, approval buttons in-thread. No public URL.
- **Durable core** (`src/core/`) - event dedup by idempotency key, approvals
  that resolve exactly once, executions that never repeat, pending approvals
  resurfaced after a crash. Two store drivers: `sqlite` (default) and
  `pi-durable`.
- **Connectors** (`src/connectors/`) - read-only pluggable sources: filesystem
  (docs, runbooks, cloned repos), GitHub (`gh` CLI), Jira (JQL issue search),
  Confluence (CQL page search) and Notion (search + page content). Add your
  own behind the `Connector` interface.
- **RAG** (`src/rag/`) - ingest -> chunk -> embed -> retrieve, fully local:
  hashing embedder + SQLite store, no API key. Idempotent ingestion. Swap the
  `Embedder` interface for sentence-transformers or a hosted API when needed.
- **RBAC** (`src/core/permissions.ts`) - roles per user, skill allow-lists per
  channel, named approvers. Mutating skills always require approval.
- **Approval gates** - the agent proposes, a human decides, the decision is
  durable and single-use. The agent never merges, deploys or revokes on its own.
- **Audit log** (`src/core/audit.ts`) - append-only JSONL with a hash chain;
  tampering breaks verification.
- **Five reference skills** (`src/skills/`), each a template for a common
  agent shape - see [docs/SKILLS.md](docs/SKILLS.md):
  - `credential-triage` - leaked key -> usage map, owner, blast radius, gated
    rotation. (Verified standalone version: [leaked-credential-triage](https://github.com/thediff-news/leaked-credential-triage).)
  - `company-brain` - ask anything from the ingested docs: answers with
    citations and source freshness, permissions-aware retrieval (ACLs per
    role), gated `ingest <path>` command, honest "I don't know" on a miss.
  - `incident-triage` - traceback -> implicated frames -> suspect commit from
    git history -> runbook enrichment -> gated draft fix.
  - `support-triage` - ticket -> classification -> reply drafted from
    public-only knowledge -> gated send.
  - `alert-router` - repeated alerts deduped by durable fingerprint, routed
    to owners from config, gated escalation on refiring.

## Run the demo (no Slack, no keys)

```bash
npm install
npm run demo            # asks before the mutating action
npm run demo -- --approve
npm test
```

The demo runs all five skills end to end: a knowledge question (admin vs
viewer ACLs), a gated ingest, a leaked-key alert, a production traceback, a
refund ticket, and the same alert three times (dedup -> escalation). It
finishes with the audit trail (hash chain verified) and a restart resuming
without re-executing.

## Run against real Slack

See [docs/SLACK_SETUP.md](docs/SLACK_SETUP.md). You create the Slack app from
the included manifest (we do not accept terms on your behalf), put the two
tokens in your environment, edit `kit.config.yaml` (users, channels, skills),
and `npm run slack`.


## Optional SaaS connectors: Jira, Confluence, Notion

Read-only REST connectors, verified against the current official API docs.
Honesty note: these are tested with mocked HTTP responses shaped like the
real payloads - they have not been run against a live tenant yet.

Config in `kit.config.yaml`:

```yaml
connectors:
  jira:       { type: jira, site: https://yourteam.atlassian.net, acl: engineering }
  confluence: { type: confluence, site: https://yourteam.atlassian.net, acl: internal }
  notion:     { type: notion, acl: internal }
```

### Atlassian (Jira + Confluence share credentials)

1. Create an API token at id.atlassian.com -> Security -> API tokens.
2. Export:
   ```bash
   export ATLASSIAN_SITE=https://yourteam.atlassian.net   # or set `site` per connector in config
   export ATLASSIAN_EMAIL=you@company.com
   export ATLASSIAN_API_TOKEN=...
   ```

Auth is HTTP Basic with `email:api-token` (per Atlassian's basic-auth doc).
A classic API token has **no scopes**: it acts with the full permissions of
the Atlassian account that created it. Use a dedicated service account with
read-only project/space access. (For reference, the equivalent OAuth 2.0
scopes are `read:jira-work` for Jira issue search and
`read:confluence-content.all` for Confluence content search.)

Endpoints used: Jira `GET /rest/api/3/search/jql` (the old
`GET /rest/api/3/search` is being removed by Atlassian) and
`GET /rest/api/3/issue/{key}`; Confluence
`GET /wiki/rest/api/content/search` (CQL) and
`GET /wiki/rest/api/content/{id}`.

### Notion

1. Create an internal integration at www.notion.so/profile/integrations
   with the default **read content** capability (no write or user
   capabilities needed).
2. Share the pages or databases the bot may read with the integration -
   the API only returns explicitly shared content.
3. `export NOTION_API_KEY=ntn_...` (`NOTION_API_VERSION` optional,
   defaults to the stable `2022-06-28`).

Endpoints used: `POST /v1/search`, `GET /v1/pages/{id}`,
`GET /v1/blocks/{id}/children`.

### ACLs and ingest

Connectors are read-only; nothing here maps source-side permissions (Jira
issue security, Confluence restrictions, Notion sharing) into the kit.
Instead every document from a connector is tagged with that connector's
configured default `acl`, which is then enforced by the usual
permissions-aware retrieval (`roleAcls` in `kit.config.yaml`). A
connector with no `acl` configured defaults to a tag named after the
connector type (`jira`, `confluence`, `notion`), which no role sees until
you grant it.

Search prefixes: `jira:`/`cql:` pass raw JQL/CQL, anything else is a
text search. Ingest any connector doc through the gated command:
`ingest jira:PROJ-123`, `ingest confluence:98765`,
`ingest notion:<page-id>` (plain `ingest <path>` still uses the docs
connector). An explicit `acl:` first line in the document body overrides
the connector default.

## Where the LLM plugs in

The kit runs keyless and deterministic by default. An optional OpenAI
provider (`src/llm/openai.ts`) is wired in and enabled purely by environment
- no key, no change in behavior, and keys never live in the repo
(`.env` is gitignored; see `.env.example`):

```bash
export OPENAI_API_KEY=sk-...        # enables hosted chat for skills
export OPENAI_CHAT_MODEL=gpt-4o-mini          # optional override
export OPENAI_EMBEDDINGS=1          # replace the local hashing embedder
export OPENAI_EMBEDDING_MODEL=text-embedding-3-small  # optional
# OPENAI_BASE_URL=...               # optional API-compatible endpoint
```

With a key set, `SkillContext.llm` is available to every skill; the
company-brain skill uses it to compose prose answers from the retrieved
chunks (ACL scoping and the honest "I don't know" are unchanged). With
`OPENAI_EMBEDDINGS=1`, retrieval uses hosted embeddings - point
`rag.dbPath` at a fresh database when switching embedders, since vectors
from different providers are not comparable.

The same insertion points remain open for other providers: `Embedder`
(`src/rag/embed.ts`) for embeddings and the `Llm` interface
(`src/llm/openai.ts`) for chat.

## Not included (deliberately)

No auto-merge, no provider revocation calls, no stored tokens, no Vercel
account, no terms accepted on your behalf. No real credentials anywhere -
the fixture key is fake.
