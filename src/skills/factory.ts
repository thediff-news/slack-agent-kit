/**
 * Factory skill: "factory <request>" - end-to-end software factory.
 * Triage -> analyze -> plan (gated) -> implement -> test -> PR -> report.
 * Target repos come from the admin allowlist in config (skills.factory.repos).
 */
import type { Skill, SkillContext, SkillResult } from "../core/skills.js";
import type { AgentEvent } from "../core/events.js";
import { runFactory, type FactoryHooks } from "../factory/pipeline.js";

export interface FactorySkillOptions {
  repos?: string[]; // admin allowlist: "owner/name"
  defaultRepo?: string;
  maxEditRounds?: number;
}

const CMD = /^factory\s+(.+)/is;
const MENTION = /^(?:<@[A-Z0-9]+>\s*)+/i;

export class FactorySkill implements Skill {
  name = "factory";
  description = "End-to-end: triage a report, plan, implement, test, open a PR";
  tier = "mutating" as const;

  constructor(private opts: FactorySkillOptions = {}) {}

  matches(event: AgentEvent): boolean {
    return CMD.test(event.text.trim().replace(MENTION, ""));
  }

  async handle(event: AgentEvent, ctx: SkillContext): Promise<SkillResult> {
    const request = event.text.trim().replace(MENTION, "").match(CMD)![1].trim();
    if (!ctx.llm) return { findings: "factory needs an LLM (OPENAI_API_KEY not configured)", actions: [] };
    if (!ctx.askApproval) return { findings: "factory needs an approval-capable runtime", actions: [] };

    const repos = this.opts.repos ?? [];
    // explicit repo override: "factory [owner/repo] <request>"
    const rm = /^\[([\w.-]+\/[\w.-]+)\]\s+(.*)$/s.exec(request);
    const repo = rm ? rm[1] : this.opts.defaultRepo ?? repos[0];
    const body = rm ? rm[2] : request;
    if (!repo || !repos.includes(repo)) {
      return { findings: `factory: repo ${repo ?? "(none)"} is not on the admin allowlist (${repos.join(", ") || "empty"})`, actions: [] };
    }

    const hooks: FactoryHooks = {
      audit: (ev, detail) => ctx.audit.record(`factory:${ev}`, event.actorId, detail),
      approvePlan: (text) => ctx.askApproval!(text),
      note: (text) => ctx.reply(text),
    };

    const result = await runFactory({
      repo, request: body, llm: ctx.llm, hooks,
      maxEditRounds: this.opts.maxEditRounds ?? 4,
    });

    const lines = [
      result.ok ? `*Factory done:* ${result.summary}` : `*Factory stopped (${result.stage}):* ${result.summary}`,
      result.prUrl ? `PR: ${result.prUrl}` : "",
      result.branch ? `branch: \`${result.branch}\` (PR only - never merged, main untouched)` : "",
      result.testOutput ? "```" + result.testOutput.slice(-1_200) + "```" : "",
    ].filter(Boolean).join("\n");
    return { findings: lines, actions: [] };
  }
}
