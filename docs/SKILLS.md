# Adding a skill

A skill is a class implementing `Skill` (`src/core/skills.ts`):

```ts
export class MySkill implements Skill {
  name = "my-skill";            // used in RBAC allow-lists and the audit log
  description = "what it does";
  tier = "read";                // "read" if it only reports; "mutating" forces a propose-capable user

  matches(event: AgentEvent): boolean {
    return /my-trigger/i.test(event.text);   // cheap routing check
  }

  async handle(event: AgentEvent, ctx: SkillContext): Promise<SkillResult> {
    // investigate with ctx.connectors, ctx.rag, git, whatever
    return {
      findings: "markdown posted back to the channel",
      actions: [{
        key: actionKey("my-action", /* stable parts */),  // idempotency key
        tier: "mutating",                                  // -> approval gate
        summary: "what a human is approving",
        run: async () => "result summary for the audit log",
      }],
    };
  }
}
```

Register it in `src/kit.ts` (`registry.register(new MySkill())`) and allow it
per channel in `kit.config.yaml` (`permissions.channels.<id>.allow`).

## The rules that keep a skill safe

1. **Read and mutate are different tiers.** A skill that only answers is
   `tier = "read"`. The moment it wants to change something, it returns a
   `ProposedAction` with `tier: "mutating"` - the runtime gates it. The skill
   itself can stay `read`; the gate is on the action.
2. **Actions carry stable idempotency keys.** `actionKey(...)` over the
   logical identity of the change, so retries never re-execute.
3. **Never fake an answer.** No retrieval hits, no parse, no evidence ->
   say so in `findings` and return no actions.
4. **Outbound content uses public knowledge only.** See support-triage:
   customer-facing drafts retrieve with `["public"]`, not the operator's
   ACLs. Internal answers use `ctx.aclsFor(event.actorId)`.
5. **Everything is audited for free.** The runtime records the trigger, the
   investigation, the approval, and the execution. Skills never write to the
   audit log directly.

## The reference skills

| Skill | Trigger | Shows |
|---|---|---|
| `credential-triage` | `key_hint: <substr>` | repo investigation, CODEOWNERS, blast radius, gated rotation |
| `company-brain` | a question, `what do we know...`, `ingest <path>` | RAG with citations + freshness, ACL-aware retrieval, gated ingest |
| `incident-triage` | `incident:` / traceback | trace parsing, suspect commit via git history, runbook enrichment, gated fix |
| `support-triage` | `ticket: ...` | classification, public-only KB grounding, gated customer reply |
| `alert-router` | `alert: ...` | durable fingerprint dedup, owner routing, threshold escalation |

Per-skill config lives under `skills:` in `kit.config.yaml` (see
`alert-router`'s routing table and escalation threshold).

## Testing recipe

`tests/skills-new.test.ts` shows the pattern: build a real `SqliteStore`,
`Rag` and `FilesystemConnector` in a temp dir, call `skill.handle()` with a
`cliEvent`, assert on `findings` and on the tier of proposed actions, and
`run()` the action to verify its effect. No mocks for the store - the point
is that durability semantics stay real in tests.
