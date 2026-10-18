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
  (docs, runbooks, cloned repos) and GitHub (`gh` CLI). Add your own behind
  the `Connector` interface.
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

## Where the LLM plugs in

The kit runs keyless and deterministic by default. Two insertion points:
- `Embedder` (`src/rag/embed.ts`) for hosted embeddings,
- skill `handle()` for generative investigation/summarization; pi-durable's
  own conversation/agent machinery (model providers via `@earendil-works/pi-ai`)
  is already a dependency and ready to host that loop.

## Not included (deliberately)

No auto-merge, no provider revocation calls, no stored tokens, no Vercel
account, no terms accepted on your behalf. No real credentials anywhere -
the fixture key is fake.
