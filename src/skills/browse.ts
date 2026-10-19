/**
 * Browse skill: "browse <goal>" drives a real Chromium via the agent loop.
 * Guardrails: per-workspace domain allowlist (additions gated), irreversible
 * clicks gated, page content treated as untrusted, every step audited,
 * screenshots posted back in-thread.
 */
import { randomUUID } from "node:crypto";
import type { Skill, SkillContext, SkillResult } from "../core/skills.js";
import type { AgentEvent } from "../core/events.js";
import { BrowserSession } from "../browse/browser.js";
import { runLoop } from "../browse/loop.js";
import { HeuristicPlanner, HttpPlanner } from "../browse/planner.js";

export interface BrowseSkillOptions {
  allowlist?: string[];
  maxSteps?: number;
  maxDurationMs?: number;
  profileDir?: string;
  screenshotDir?: string;
  cdpEndpoint?: string; // hosted browser; defaults to env BROWSE_CDP_URL
}

const CMD = /^browse\s+(.+)/is;
const MENTION = /^(?:<@[A-Z0-9]+>\s*)+/i;

function goalOf(text: string): string | undefined {
  const clean = text
    .trim()
    .replace(MENTION, "")
    .replace(/<(https?:\/\/[^>|]+)(\|[^>]*)?>/g, "$1"); // unwrap Slack link markup
  return CMD.exec(clean)?.[1].trim();
}

export class BrowseSkill implements Skill {
  name = "browse";
  description = "Drive a real browser: navigate sites, click, fill forms, read pages, screenshot";
  tier = "mutating" as const; // browsing can commit actions; guardrails gate the risky clicks

  constructor(private opts: BrowseSkillOptions = {}) {}

  matches(event: AgentEvent): boolean {
    return goalOf(event.text) !== undefined;
  }

  async handle(event: AgentEvent, ctx: SkillContext): Promise<SkillResult> {
    const goal = goalOf(event.text)!;
    if (!ctx.askApproval) {
      return { findings: "browse needs an approval-capable runtime (askApproval missing)", actions: [] };
    }

    // per-workspace allowlist: config seed + persisted additions
    const stored = await ctx.store.get("browse", "allowlist");
    const allowlist = stored ? (JSON.parse(stored) as string[]) : [...(this.opts.allowlist ?? [])];
    const before = allowlist.join(",");

    const planner = HttpPlanner.fromEnv(this.opts.maxSteps ?? 20) ?? new HeuristicPlanner();
    const shotDir = this.opts.screenshotDir ?? "/tmp/browse-shots";
    let session: BrowserSession | undefined;
    try {
      session = await BrowserSession.launch({
        cdpEndpoint: this.opts.cdpEndpoint ?? process.env.BROWSE_CDP_URL,
        profileDir: this.opts.profileDir,
        downloadsDir: shotDir,
      });
    } catch (e) {
      return { findings: `browser failed to start: ${(e as Error).message.split("\n")[0]}`, actions: [] };
    }

    ctx.audit.record("browse_start", event.actorId, `${event.id}: ${goal.slice(0, 200)} (planner: ${planner.name})`);
    try {
      const result = await runLoop(session, planner, goal, {
        maxSteps: this.opts.maxSteps ?? 20,
        maxDurationMs: this.opts.maxDurationMs ?? 180_000,
        screenshotDir: shotDir,
        allowlist,
        gate: (reason) => ctx.askApproval!(reason),
        audit: (ev, detail) => ctx.audit.record(ev, event.actorId, detail),
      });

      if (allowlist.join(",") !== before) {
        await ctx.store.set("browse", "allowlist", JSON.stringify(allowlist));
      }

      // post screenshots in-thread; upload failure must never eat the findings
      let uploadsFailed = false;
      for (const shot of result.screenshots.slice(0, 6)) {
        try {
          await ctx.replyFile?.(shot, `browse step screenshot`);
        } catch (e) {
          uploadsFailed = true;
          ctx.audit.record("browse_upload_failed", event.actorId, (e as Error).message.slice(0, 200));
        }
      }

      const logText = result.steps
        .map((s) => `${s.step}. ${s.action} -> ${s.result.slice(0, 140)}`)
        .join("\n");
      const findings = [
        result.ok ? `*Browse done:* ${result.summary}` : `*Browse stopped:* ${result.summary}`,
        `_planner: ${planner.name} - ${result.steps.length} step(s)${result.blockedReason ? ` - blocked: ${result.blockedReason}` : ""}_`,
        logText ? "```" + logText.slice(0, 2800) + "```" : "",
        uploadsFailed ? `_(${result.screenshots.length} screenshot(s) taken but upload failed - the Slack app needs the files:write scope)_` : "",
      ].filter(Boolean).join("\n");
      ctx.audit.record("browse_end", event.actorId, `${event.id}: ok=${result.ok} steps=${result.steps.length} ${result.summary.slice(0, 120)}`);
      return { findings, actions: [] };
    } finally {
      await session.close();
    }
  }
}

export function newApprovalId(): string {
  return randomUUID();
}
