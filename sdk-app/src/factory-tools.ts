/** Factory, SDK-native: the old pipeline (triage->plan->implement->test->PR)
 * is replaced by the SDK loop driving these tools conversationally. The
 * mechanics are preserved: work happens in an isolated clone, tests come
 * from the repo's own scripts, diffs are scanned for secrets, and creating
 * a PR is approval-gated + dry-run unless armed. Never merges, never
 * pushes to main. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import type { AppConfig } from "./config.js";
import type { AuditLog } from "./audit.js";

const run = promisify(execFile);

/** Commands the agent may run inside the clone: the repo's own checks only. */
const SAFE_CMD = /^(npm (test|run (test|typecheck|build))|npx (tsc|tsx --test\b.*)|git (status|diff|log|add|commit|checkout)\b.*)$/;

const SECRET_PATTERNS = [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bAKIA[0-9A-Z]{16}\b/, /\b(?:sk|xoxb|xoxp|ghp|github_pat)[-_][A-Za-z0-9_-]{20,}\b/, /ANTHROPIC_API_KEY\s*=\s*\S+/];

export type FactoryDeps = { config: AppConfig; audit: AuditLog };

export class FactoryTools {
  private workRoot: string;
  constructor(private deps: FactoryDeps) {
    this.workRoot = deps.config.auditLog.replace(/[^/]+$/, "factory-clones");
    mkdirSync(this.workRoot, { recursive: true });
  }

  private cloneDir(repo: string): string {
    return join(this.workRoot, repo.replace(/[^\w.-]+/g, "_"));
  }

  /** repo is "owner/name" (cloned via gh, must be in SDK_APP_GITHUB_REPOS) or an absolute local path (tests/fixtures). */
  async clone(repo: string): Promise<string> {
    const allowed = this.deps.config.githubRepos.includes(repo) || repo.startsWith("/");
    if (!allowed) return `BLOCKED: ${repo} is not in the repo allowlist (SDK_APP_GITHUB_REPOS). Ask a human to add it.`;
    const dir = this.cloneDir(repo);
    if (!existsSync(dir)) {
      if (repo.startsWith("/")) await run("git", ["clone", "-q", repo, dir]);
      else await run("gh", ["repo", "clone", repo, dir, "--", "-q", "--depth", "50"]);
    } else {
      await run("git", ["-C", dir, "fetch", "--quiet", "origin", "HEAD"]).catch(() => {});
    }
    const branch = `factory/sdk-${Date.now().toString(36)}`;
    await run("git", ["-C", dir, "checkout", "-q", "-B", branch]);
    this.deps.audit.write("tool_call", { tool: "factory_clone", repo, dir, branch });
    return `cloned ${repo} -> ${dir} on branch ${branch}`;
  }

  private guardPath(repo: string, rel: string): string {
    const base = resolve(this.cloneDir(repo));
    const p = resolve(base, normalize(rel));
    if (!p.startsWith(base + "/") && p !== base) throw new Error(`path escapes the clone: ${rel}`);
    return p;
  }

  async readFile(repo: string, path: string): Promise<string> {
    const p = this.guardPath(repo, path);
    return readFileSync(p, "utf8").slice(0, 20000);
  }

  async writeFile(repo: string, path: string, content: string): Promise<string> {
    const p = this.guardPath(repo, path);
    writeFileSync(p, content);
    this.deps.audit.write("tool_call", { tool: "factory_write_file", repo, path, bytes: content.length });
    return `wrote ${path} (${content.length} bytes)`;
  }

  async listFiles(repo: string, subdir = "."): Promise<string> {
    const base = this.guardPath(repo, subdir);
    const out: string[] = [];
    const walk = (d: string, depth: number) => {
      if (depth > 3) return;
      for (const e of readdirSync(d)) {
        if (e.startsWith(".") || e === "node_modules") continue;
        const f = join(d, e);
        out.push(f.slice(this.cloneDir(repo).length + 1));
        try { walk(f, depth + 1); } catch { /* file, not dir */ }
      }
    };
    walk(base, 0);
    return out.slice(0, 200).join("\n");
  }

  async runChecks(repo: string, cmd: string): Promise<string> {
    if (!SAFE_CMD.test(cmd)) return `BLOCKED: command not in the factory allowlist (repo's own test/typecheck/build/git commands only): ${cmd}`;
    const dir = this.cloneDir(repo);
    this.deps.audit.write("tool_call", { tool: "factory_run", repo, cmd });
    try {
      const { stdout, stderr } = await run("sh", ["-c", cmd], { cwd: dir, timeout: 240_000, maxBuffer: 4 * 1024 * 1024 });
      return (stdout + stderr).slice(-4000) || "(no output, exit 0)";
    } catch (e: any) {
      return `EXIT ${e.code ?? "?"}:\n${String(e.stdout ?? "").slice(-2000)}\n${String(e.stderr ?? "").slice(-2000)}`;
    }
  }

  /** Scan the working diff for secrets (kit semantics: never PR a secret). */
  async scanDiff(repo: string): Promise<{ clean: boolean; findings: string[] }> {
    const dir = this.cloneDir(repo);
    // intent-to-add so UNTRACKED files are scanned too (a plain diff misses them)
    await run("git", ["-C", dir, "add", "-N", "-A"]);
    const { stdout } = await run("git", ["-C", dir, "diff", "HEAD"]);
    const findings: string[] = [];
    for (const line of stdout.split("\n")) {
      if (!line.startsWith("+") || line.startsWith("+++")) continue;
      for (const pat of SECRET_PATTERNS) if (pat.test(line)) findings.push(`${pat.source} in: ${line.slice(1, 60)}...`);
    }
    this.deps.audit.write("tool_call", { tool: "factory_scan_diff", repo, findings: findings.length });
    return { clean: findings.length === 0, findings };
  }

  /** GATED + armed-only. dry-run returns the exact plan without executing. */
  async createPr(repo: string, title: string, body: string): Promise<string> {
    if (repo.startsWith("/")) return "BLOCKED: PRs only for GitHub repos, not local fixtures.";
    const dir = this.cloneDir(repo);
    const scan = await this.scanDiff(repo);
    if (!scan.clean) return `BLOCKED: secrets in the diff: ${scan.findings.join("; ")}`;
    const { stdout: stat } = await run("git", ["-C", dir, "diff", "--stat", "HEAD"]);
    const branch = (await run("git", ["-C", dir, "branch", "--show-current"])).stdout.trim();
    if (this.deps.config.dryRun) {
      return `[dry-run] would commit on ${branch}, push, and open a PR in ${repo}:\nTITLE: ${title}\nDIFF STAT:\n${stat}\nArm with SDK_APP_DRY_RUN=0 to execute.`;
    }
    await run("git", ["-C", dir, "add", "-A"]);
    await run("git", ["-C", dir, "commit", "-q", "-m", title]);
    await run("git", ["-C", dir, "push", "-q", "-u", "origin", branch]);
    const { stdout } = await run("gh", ["pr", "create", "--repo", repo, "--title", title, "--body", body, "--draft"]);
    this.deps.audit.write("tool_call", { tool: "factory_create_pr", repo, title, url: stdout.trim() });
    return `PR created: ${stdout.trim()}`;
  }
}
