# Threat model (short)

The bot holds credentials (Slack tokens, GitHub token) and can propose
mutating actions. That is exactly the case the approval design exists for.

1. **A leaked key alert may itself be an attack.** A stranger who can post in
   a watched channel can make the agent investigate a chosen string. RBAC
   (channel allow-lists + user roles) limits who can trigger what; all
   investigations and triggers are in the tamper-evident audit log.
2. **The agent must never act alone.** Mutating actions need a named
   approver's durable decision. Approvals are single-use; the agent cannot
   approve, and "execute" is gated on an approval record, not on the agent's
   own judgment.
3. **Duplicate / replayed alerts must not re-fire side effects.** Event
   idempotency keys + execution keys + single-resolution approvals.
4. **Tokens live in the environment, never in the repo or the RAG.** The
   GitHub connector shells out to `gh` with the caller's auth; connectors are
   read-only by construction.
5. **The audit log is the source of truth** for "who asked, what the agent
   found, who approved, what ran" - hash-chained so quiet edits break it.
6. **The RAG is a disclosure surface.** Only ingest documents the bot's
   audience may read; retrieval results are posted to the channel.
