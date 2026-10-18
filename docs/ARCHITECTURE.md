# Architecture and foundation evaluation

## Why this foundation (evaluated 2026-10-18)

| Candidate | License | Activity | Verdict |
|---|---|---|---|
| [earendil-works/pi](https://github.com/earendil-works/pi) + `@earendil-works/pi-durable` | MIT | 116k stars, pushed daily; durable pkg 1.3.0, 16 releases in 4 weeks, ~552k npm downloads/mo | **Foundation.** Purpose-built replay-safe durability: state committed before shown, resume after crash, no repeated side effects. |
| [vercel-labs/eve-sre-agent-template](https://github.com/vercel-labs/eve-sre-agent-template) | MIT | Official Vercel Labs, small (12 stars) | **Architecture reference** for the Slack surface (mention / channel watch / webhook triggers, evidence-linked findings). Not used as code: Vercel-locked (Connect, Blob, deploy flow), read-only by design, no approval gates or RAG. |
| [disler/durable-pi](https://github.com/disler/durable-pi) | MIT | 2 weeks old, 181 stars, one author | **Pattern reference** for the approval gate (agent waits for deploy approval, survives restart). Too young to build on. |

### Tradeoffs

1. **pi-durable is self-declared experimental** ("API changes without notice").
   Mitigation: all kit state goes through the small `DurableStore` interface
   (`src/core/store.ts`). Drivers: `sqlite` (default) and `pi-durable`
   (`src/core/store-pi.ts`). If the API shifts, one file changes.
2. **Vercel template would give managed connectors and zero-config deploy**,
   at the cost of platform lock-in, a Vercel account, and a read-only agent.
   We keep the trigger architecture and drop the platform.
3. **TypeScript/Node** (>=20) because both foundations are TS.

## The replay-safety rule

Borrowed from pi-durable and applied everywhere in the kit:

1. An event is committed to the store **before** any reply or action.
2. A mutating action's approval is committed **before** a human is asked.
3. An approval resolves **exactly once** (second decisions are rejected).
4. An action's idempotency key is checked **before** execution; retries and
   duplicate deliveries never re-execute.
5. On restart, pending approvals are **resurfaced**, not re-run.

## Components

- `src/core/events.ts` - normalized events; `id = sha256(source:sourceEventId)`.
- `src/core/runtime.ts` - the pipeline: audit -> dedup -> route -> RBAC ->
  investigate -> gate -> idempotent execute -> audit.
- `src/core/permissions.ts` - roles, channel allow-lists, approvers.
- `src/core/audit.ts` - append-only JSONL, SHA-256 hash chain.
- `src/connectors/` - read-only sources (filesystem, GitHub via `gh`).
- `src/rag/` - local chunk/embed/retrieve; `Embedder` interface for swaps.
- `src/skills/` - skills declare tier (read/mutating) + propose actions.
- `src/adapters/` - Slack (Bolt, Socket Mode) and CLI harness.
