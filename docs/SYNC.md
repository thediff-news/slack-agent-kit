# Automatic connector sync

Configured connectors are crawled on a schedule; the knowledge base follows
the sources without anyone typing `ingest`. Enabled via `sync:` in the kit
config:

```yaml
sync:
  intervalMinutes: 15       # how often the crawl runs (default 15)
  notifyChannel: C0123ABCD  # where first-sync / ACL-change approvals are posted
```

The Slack adapter runs the first pass ~5s after boot, then every
`intervalMinutes`. Sync only exists in adapters that wire it (Slack today).

## Approval policy (decided, applies to every sync run)

1. **Configured connectors sync with no per-document approval.** An admin
   already delegated the read scope by configuring the connector; every doc
   is indexed under the connector's configured ACL, and source text can
   never widen it (an inline `acl:` line in fetched content is ignored on
   the sync path, same as on manual ingest).
2. **The first sync of a connector is gated - once.** A connector appearing
   in config is a new scope being granted to the knowledge base, so the
   first crawl needs one durable human approval (posted to `notifyChannel`,
   same Approve/Deny buttons as skill actions). After approval, sync runs
   automatically. A denial backs off re-asking for 24h.
3. **Re-tagging an indexed doc to a different ACL is gated per doc.** This
   can only happen after a config change; the old ACL stays in effect until
   a human approves the re-tag. Undecided re-tags back off for 1h.
4. **Deletions apply immediately, no approval.** Dropping a doc from the
   index only ever narrows access - the safe direction.

Every run is audit-logged (`sync_enabled`, `sync_ingested`, `sync_deleted`,
`sync_completed`, `sync_failed`).

## Change detection and deletions per connector

| Connector | Incremental marker | Full listing | Deletions reconciled |
|---|---|---|---|
| jira | `updated` (JQL `updated >=`) | first crawl + every 10th run | yes, on full listings |
| confluence | `version.when` (CQL `lastmodified >=`) | first crawl + every 10th run | yes, on full listings |
| notion | `last_edited_time` (search sort) | first crawl + every 10th run | yes, on full listings |
| slack-history | newest message ts (rolling 200-message doc per channel) | every run | channel-level only |
| github | issue `updated_at` (`?since=`) | never (capped: 30 issues/repo initial, 100 on incrementals) | **no** - deleted issues stay indexed until removed manually |

Webhooks are not used: none of the free plans of these services offers a
cheap push channel the kit can receive without a public URL, and the bot
runs Socket Mode precisely to avoid one. Polling with `updated`-style
cursors is the honest cheap incremental.

## Failure behavior

A connector that throws or is unreachable is audit-logged (`sync_failed`)
and skipped; the other connectors still sync. The index keeps the last good
copy of every doc.
