import { createHash } from "node:crypto";
import type { AgentEvent } from "../core/events.js";
import type { Skill, SkillContext, SkillResult } from "../core/skills.js";
import { actionKey } from "../core/runtime.js";

/**
 * Reference skill: alert dedup + routing.
 * Trigger: a message starting with `alert:` (what monitoring webhooks post).
 * Fingerprints the alert (numbers/timestamps stripped), counts occurrences
 * durably, routes the first occurrence to the service owner from the kit
 * config's routing table, and proposes a GATED escalation when an alert
 * keeps refiring (default threshold: 3).
 */
export class AlertRouterSkill implements Skill {
  name = "alert-router";
  description = "Deduplicate repeated alerts, route to owners, escalate refiring alerts.";
  tier = "mutating" as const;

  constructor(private routing: Record<string, string>, private escalateThreshold = 3) {}

  matches(event: AgentEvent): boolean {
    return /^alert:/im.test(event.text.trim());
  }

  private fingerprint(text: string): { name: string; fp: string } {
    const name = text.replace(/^alert:\s*/i, "").replace(/[0-9]+/g, "N").replace(/\s+/g, " ").trim().slice(0, 80);
    return { name, fp: createHash("sha256").update(name.toLowerCase()).digest("hex").slice(0, 12) };
  }

  async handle(event: AgentEvent, ctx: SkillContext): Promise<SkillResult> {
    const { name, fp } = this.fingerprint(event.text);
    const key = `alert:${fp}`;
    const count = Number((await ctx.store.get("alerts", key)) ?? "0") + 1;
    await ctx.store.set("alerts", key, String(count));

    const service = Object.keys(this.routing).find((s) => name.toLowerCase().includes(s.toLowerCase()));
    const owner = service ? this.routing[service] : "(no owner in routing table)";

    if (count > 1) {
      const escalate = count >= this.escalateThreshold;
      return {
        findings: [
          `Duplicate alert \`${fp}\` - occurrence *${count}*: "${name}"`,
          escalate ? `Refired ${count} times - proposing escalation.` : `Still routed to ${owner}. No new noise.`,
        ].join("\n"),
        actions: escalate ? [{
          key: actionKey("escalate", fp, `occ${count}`),
          tier: "mutating",
          summary: `Escalate refiring alert ${fp} ("${name}") to ${owner} - occurrence ${count}`,
          run: async () => `escalated ${fp} to ${owner} at occurrence ${count}`,
        }] : [],
      };
    }

    return {
      findings: `*Alert routed* \`${fp}\`: "${name}"\nService: ${service ?? "unknown"} - owner: *${owner}*\nFirst occurrence. Repeats of this fingerprint will be deduplicated.`,
      actions: [],
    };
  }
}
