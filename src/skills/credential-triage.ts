import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent } from "../core/events.js";
import type { Skill, SkillContext, SkillResult, ProposedAction } from "../core/skills.js";
import { actionKey } from "../core/runtime.js";

const run = promisify(execFile);
const ASSIGNMENT_RE = /(?<name>[A-Z][A-Z0-9_]{2,}(?:KEY|TOKEN|SECRET))\s*[:=]\s*["'](?<value>[A-Za-z0-9_\-]{12,})["']/;

interface Hit { path: string; line: number; text: string }

/**
 * Example skill: triage a leaked credential.
 * Trigger: an alert/mention whose text contains `key_hint: <substring>`.
 * Investigates a target repo (locate -> usage map -> owner -> blast radius),
 * enriches the report with the org's rotation policy from the RAG, and
 * proposes a mutating action (open rotation PR) that only runs after a
 * human approves. Ported from the verified leaked-credential-triage demo.
 */
export class CredentialTriageSkill implements Skill {
  name = "credential-triage";
  description = "Locate a leaked credential, map usage and blast radius, propose a rotation.";
  tier = "mutating" as const;

  constructor(private targetRepoPath: string) {}

  matches(event: AgentEvent): boolean {
    return /key_hint\s*:/i.test(event.text);
  }

  private async grep(needle: string): Promise<Hit[]> {
    try {
      const { stdout } = await run("git", ["grep", "-n", "-I", "-F", "-e", needle], { cwd: this.targetRepoPath });
      return stdout.trim().split("\n").map((l) => {
        const [path, line, ...rest] = l.split(":");
        return { path, line: Number(line), text: rest.join(":").trim() };
      });
    } catch {
      return []; // git grep exits 1 on no matches
    }
  }

  private codeowners(): [string, string[]][] {
    for (const p of [".github/CODEOWNERS", "CODEOWNERS"]) {
      const full = join(this.targetRepoPath, p);
      if (existsSync(full)) {
        return readFileSync(full, "utf8").split("\n")
          .filter((l) => l.trim() && !l.startsWith("#"))
          .map((l) => {
            const [pattern, ...owners] = l.trim().split(/\s+/);
            return [pattern.replace(/^\//, ""), owners] as [string, string[]];
          });
      }
    }
    return [];
  }

  private classify(path: string): string {
    const p = path.toLowerCase();
    if (p.includes("prod")) return "production";
    if (p.includes("stag")) return "staging";
    if (/\.(ya?ml|env|tf|ini|cfg|json)$/.test(p)) return "config";
    return "source";
  }

  async handle(event: AgentEvent, ctx: SkillContext): Promise<SkillResult> {
    const hint = /key_hint\s*:\s*(\S+)/i.exec(event.text)?.[1] ?? "";
    const hintHits = await this.grep(hint);
    let name: string | undefined;
    let value: string | undefined;
    for (const h of hintHits) {
      const m = ASSIGNMENT_RE.exec(h.text);
      if (m?.groups) { name = m.groups.name; value = m.groups.value; break; }
    }
    if (!name && /^[A-Z][A-Z0-9_]+$/.test(hint)) name = hint;

    const literalHits = value ? await this.grep(value) : [];
    const varHits = name ? (await this.grep(name)).filter((h) => !literalHits.some((l) => l.path === h.path && l.line === h.line)) : [];
    if (literalHits.length + varHits.length === 0) {
      return { findings: `No occurrence of \`${hint}\` found - already rotated, or bad hint.`, actions: [] };
    }

    const rules = this.codeowners();
    const ownerOf = (path: string) =>
      rules.filter(([pat]) => path.startsWith(pat.replace(/\/$/, ""))).map(([, o]) => o.join(", ")).pop() ?? "(unowned)";
    const affected = [...new Set([...literalHits, ...varHits].map((h) => h.path))].sort();
    const byClass = new Map<string, string[]>();
    for (const p of affected) {
      const c = this.classify(p);
      byClass.set(c, [...(byClass.get(c) ?? []), p]);
    }
    const masked = value ? (value.length <= 20 ? value : `${value.slice(0, 16)}...${value.slice(-4)}`) : "(not in source)";

    // RAG enrichment: pull the org's rotation policy so the report cites it.
    const policy = await ctx.enrich(`credential rotation policy ${name ?? hint}`);

    const findings = [
      `*Credential triage: \`${name ?? hint}\`*`,
      `Value: \`${masked}\` - production exposure: ${byClass.has("production") || (literalHits.length > 0 && byClass.has("source")) ? "YES" : "no"}`,
      "",
      "*Where it lives (literal):*",
      ...literalHits.map((h) => `- \`${h.path}:${h.line}\` ${h.text}`),
      "*All references:*",
      ...varHits.map((h) => `- \`${h.path}:${h.line}\` (${this.classify(h.path)}) ${h.text}`),
      "*Ownership:*",
      ...affected.map((p) => `- \`${p}\` - ${ownerOf(p)}`),
      "*Blast radius:*",
      ...[...byClass.entries()].map(([c, ps]) => `- *${c}*: ${ps.map((p) => `\`${p}\``).join(", ")}`),
      policy ? `\n*Relevant policy from knowledge base:*\n${policy}` : "",
    ].join("\n");

    const actions: ProposedAction[] = [];
    if (value && literalHits.length > 0) {
      actions.push({
        key: actionKey("rotate", name!, value!),
        tier: "mutating",
        summary: `Open draft rotation PR removing the hardcoded \`${name}\` literal from ${literalHits.map((h) => h.path).join(", ")}`,
        run: async () => {
          // The actual rotation: same mechanical edit as the verified demo.
          for (const h of literalHits) {
            const full = join(this.targetRepoPath, h.path);
            let src = readFileSync(full, "utf8");
            if (h.path.endsWith(".py")) {
              src = src.replace(`"${value}"`, `os.environ["${name}"]`).replace(`'${value}'`, `os.environ["${name}"]`);
              if (!src.includes("import os")) src = `import os\n\n${src}`;
            } else {
              src = src.replaceAll(value!, `\${${name}}`);
            }
            writeFileSync(full, src);
          }
          return `rotation applied to ${literalHits.length} file(s); open the PR with: cd ${this.targetRepoPath} && git diff`;
        },
      });
    }
    return { findings, actions };
  }
}
