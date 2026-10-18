import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentEvent } from "../core/events.js";
import type { Skill, SkillContext, SkillResult } from "../core/skills.js";
import { actionKey } from "../core/runtime.js";

const run = promisify(execFile);

/**
 * Reference skill: incident/error triage.
 * Trigger: an alert containing a traceback or an `incident:` prefix.
 * Parses the trace for implicated files, asks git for the last change to
 * each (the usual root cause), enriches with the runbook from the knowledge
 * base, and proposes a GATED draft fix. The agent points at the suspect
 * commit; a human decides to fix.
 */
export class IncidentTriageSkill implements Skill {
  name = "incident-triage";
  description = "Parse an error report, find the suspect commit via git, propose a gated fix.";
  tier = "mutating" as const;

  constructor(private targetRepoPath: string) {}

  matches(event: AgentEvent): boolean {
    return /incident:|Traceback|Error:|Exception/i.test(event.text);
  }

  private async git(...args: string[]): Promise<string> {
    try {
      const { stdout } = await run("git", args, { cwd: this.targetRepoPath });
      return stdout.trim();
    } catch {
      return "";
    }
  }

  async handle(event: AgentEvent, ctx: SkillContext): Promise<SkillResult> {
    const files = [...event.text.matchAll(/File "([^"]+)", line (\d+)/g)].map((m) => ({ path: m[1], line: Number(m[2]) }));
    const errorLine = event.text.split("\n").find((l) => /^(TypeError|ValueError|\w+Error|Exception)/.test(l.trim()))?.trim() ?? "(no error line parsed)";
    if (files.length === 0) {
      return { findings: `Incident noted but I could not parse a stack trace. Error line: ${errorLine}`, actions: [] };
    }

    const suspects: { path: string; commit: string; summary: string }[] = [];
    for (const f of files) {
      const commit = await this.git("log", "-1", "--format=%h %an %ad", "--", f.path);
      const summary = await this.git("log", "-1", "--format=%s", "--", f.path);
      if (commit && !suspects.some((s) => s.path === f.path)) suspects.push({ path: f.path, commit, summary });
    }
    const deepest = files[files.length - 1]; // where it actually threw
    const diff = deepest ? await this.git("log", "-1", "-p", "--format=%h %s", "--", deepest.path) : "";

    const runbook = await ctx.enrich(`incident response runbook ${errorLine.split(":")[0]}`);

    const findings = [
      `*Incident triage*`,
      `Error: \`${errorLine}\``,
      "",
      "*Implicated frames (deepest first):*",
      ...files.reverse().map((f) => `- \`${f.path}:${f.line}\``),
      "",
      "*Suspect commits (last change per file):*",
      ...suspects.map((s) => `- \`${s.path}\` - ${s.commit} - "${s.summary}"`),
      diff ? `\n*Last change to the throwing file:*\n\`\`\`\n${diff.slice(0, 1500)}\n\`\`\`` : "",
      runbook ? `\n*Runbook from knowledge base:*\n${runbook}` : "",
      "\n_Root-cause hypothesis: the most recent commit touching the throwing frame. A human confirms; I do not._",
    ].join("\n");

    const bad = suspects.find((s) => s.path === deepest.path);
    const actions = bad
      ? [{
          key: actionKey("incident-fix", bad.commit, errorLine),
          tier: "mutating" as const,
          summary: `Draft a fix for ${errorLine} in \`${deepest.path}\` (suspect: ${bad.commit} "${bad.summary}")`,
          run: async () => `fix drafted for ${deepest.path} (demo: review \`git show ${bad.commit.split(" ")[0]}\` in ${this.targetRepoPath} and apply the revert or guard)`,
        }]
      : [];
    return { findings, actions };
  }
}
