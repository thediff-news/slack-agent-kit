import type { AgentEvent } from "../core/events.js";
import type { Skill, SkillContext, SkillResult } from "../core/skills.js";
import { actionKey } from "../core/runtime.js";

const CATEGORIES: [RegExp, string][] = [
  [/bill|invoice|refund|charge|payment/i, "billing"],
  [/error|broken|crash|bug|fail|500/i, "bug"],
  [/how do i|how to|where is|can i/i, "how-to"],
  [/cancel|delete my|close account/i, "account"],
];

/**
 * Reference skill: support-ticket triage.
 * Trigger: a message starting with `ticket:` (as a helpdesk webhook or a
 * forwarded message would produce). Classifies the ticket, drafts a reply
 * grounded in the knowledge base (permissions-aware), and proposes posting
 * it as a GATED action - a human approves every word a customer receives.
 */
export class SupportTriageSkill implements Skill {
  name = "support-triage";
  description = "Classify a support ticket, draft a KB-grounded reply, propose posting it.";
  tier = "mutating" as const;

  matches(event: AgentEvent): boolean {
    return /^ticket[:#]/im.test(event.text.trim());
  }

  async handle(event: AgentEvent, ctx: SkillContext): Promise<SkillResult> {
    const body = event.text.replace(/^ticket[:#]\s*/i, "").trim();
    const category = CATEGORIES.find(([re]) => re.test(body))?.[1] ?? "general";
    // Customer-facing drafts use PUBLIC knowledge only. Retrieving with the
    // operator's ACLs could leak restricted docs (finance, internal) into a
    // reply that leaves the company.
    const kb = await ctx.rag.retrieve(body, 3, ["public"]);
    const grounded = kb.length > 0;

    const draft = [
      `Hi, thanks for reporting this.`,
      grounded ? `\n${kb[0].text.slice(0, 300)}` : "\nI'm looking into this and will follow up with details.",
      `\n- the support team`,
    ].join("\n");

    const findings = [
      `*Ticket triage* - category: *${category}*${grounded ? "" : " (no KB grounding)"}`,
      grounded ? `Grounded in: ${kb.map((h) => `\`${h.source}\``).join(", ")}` : "No matching knowledge - drafting a holding reply only.",
      "",
      "*Draft reply (needs approval before anything is sent):*",
      "```",
      draft,
      "```",
    ].join("\n");

    return {
      findings,
      actions: [{
        key: actionKey("ticket-reply", body.slice(0, 64)),
        tier: "mutating",
        summary: `Post the drafted ${category} reply to the requester`,
        run: async () => {
          await ctx.store.set("support", `replied:${Date.now()}`, draft);
          return `reply posted (category: ${category})`;
        },
      }],
    };
  }
}
