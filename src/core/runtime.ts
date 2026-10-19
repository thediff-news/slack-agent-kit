import { createHash, randomUUID } from "node:crypto";
import type { AgentEvent } from "./events.js";
import type { DurableStore, Approval } from "./store.js";
import type { AuditLog } from "./audit.js";
import type { Permissions } from "./permissions.js";
import type { SkillRegistry, SkillContext, ProposedAction } from "./skills.js";
import type { KitConfig } from "./config.js";

export interface RuntimeHooks {
  /** Deliver a message to the originating channel. */
  notify(event: AgentEvent, text: string): Promise<void>;
  /** Ask a human to decide. Resolves with the approver's decision. */
  requestApproval(approval: Approval, event: AgentEvent): Promise<"approved" | "denied">;
  /** Upload a file to the channel/thread (screenshots). Optional. */
  upload?(event: AgentEvent, path: string, caption?: string): Promise<void>;
}

/**
 * The pipeline every event flows through:
 *   audit -> dedup -> route -> RBAC -> skill investigates ->
 *   for each mutating action: approval gate -> idempotent execute -> audit
 *
 * Replay-safety: the event is committed before any reply; an action's
 * idempotency key is checked before execution; an approval resolves once.
 * Restarting mid-flow re-surfaces pending approvals instead of re-acting.
 */
export class Runtime {
  constructor(
    private store: DurableStore,
    private audit: AuditLog,
    private perms: Permissions,
    private registry: SkillRegistry,
    private config: KitConfig,
    private hooks: RuntimeHooks,
    private makeSkillContext: (event: AgentEvent) => SkillContext,
  ) {}

  async handleEvent(event: AgentEvent): Promise<void> {
    this.audit.record("event_received", event.actorId, `${event.source}/${event.kind} ${event.id}: ${event.text.slice(0, 120)}`);

    if ((await this.store.recordEvent(event.id, event.source, event.kind, event.actorId, event.text)) === "duplicate") {
      this.audit.record("event_duplicate", event.actorId, event.id);
      return; // seen before: never re-act
    }

    const skill = this.registry.match(event);
    if (!skill) {
      await this.hooks.notify(event, "No skill handles this. Registered: " + this.registry.list().map((s) => s.name).join(", "));
      return;
    }

    const gate = this.perms.canTrigger(event.actorId, skill.name, skill.tier, event.channelId);
    if (!gate.ok) {
      this.audit.record("permission_denied", event.actorId, `${skill.name}: ${gate.reason}`);
      await this.hooks.notify(event, `Sorry, I can't run ${skill.name}: ${gate.reason}.`);
      return;
    }

    const ctx = this.makeSkillContext(event);
    const result = await skill.handle(event, ctx);
    this.audit.record("investigation", skill.name, `${event.id}: ${result.findings.length} chars, ${result.actions.length} action(s)`);
    await this.hooks.notify(event, result.findings);

    for (const action of result.actions) {
      await this.gateAndExecute(action, event);
    }
  }

  /** Public entry for out-of-band proposers (e.g. the sync engine): same
   * approval gate + idempotent execute + audit as skill-proposed actions. */
  async executeProposed(action: ProposedAction, event: AgentEvent): Promise<void> {
    return this.gateAndExecute(action, event);
  }

  private async gateAndExecute(action: ProposedAction, event: AgentEvent): Promise<void> {
    if (action.tier === "mutating") {
      const approval: Approval = {
        id: randomUUID(),
        actionKey: action.key,
        summary: action.summary,
        requestedBy: event.actorId,
        requestedAt: new Date().toISOString(),
        status: "pending",
      };
      await this.store.createApproval(approval); // committed BEFORE anyone is asked
      this.audit.record("approval_requested", event.actorId, `${approval.id}: ${action.summary}`);
      const decision = await this.hooks.requestApproval(approval, event);
      const won = await this.store.resolveApproval(approval.id, decision, "approver");
      this.audit.record("approval_resolved", "approver", `${approval.id}: ${decision}${won ? "" : " (already resolved, ignored)"}`);
      if (decision !== "approved") {
        await this.hooks.notify(event, `Not approved - skipping: ${action.summary}`);
        return;
      }
    }

    if (await this.store.hasExecuted(action.key)) {
      this.audit.record("action_skipped_duplicate", "agent", action.key);
      await this.hooks.notify(event, `Already executed earlier, not repeating: ${action.summary}`);
      return;
    }
    const resultSummary = await action.run();
    await this.store.markExecuted(action.key, resultSummary);
    this.audit.record("action_executed", "agent", `${action.key}: ${resultSummary}`);
    await this.hooks.notify(event, `Done: ${resultSummary}`);
  }

  /** After a restart: approvals that were pending when we died, resurfaced rather than re-run. */
  async resumePending(): Promise<Approval[]> {
    const pending = await this.store.pendingApprovals();
    for (const p of pending) this.audit.record("approval_resurfaced", "agent", `${p.id}: ${p.summary}`);
    return pending;
  }
}

export function actionKey(...parts: string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 24);
}
