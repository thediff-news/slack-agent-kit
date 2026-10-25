/** Factory, SDK-native: the old pipeline (triage->plan->implement->test->PR)
 * is replaced by the SDK loop driving these tools conversationally. The
 * mechanics are preserved: work happens in an isolated clone, tests come
 * from the repo's own scripts, diffs are scanned for secrets, and creating
 * a PR is approval-gated + dry-run unless armed. Never merges, never
 * pushes to main. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { dirname } from "node:path";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, normalize, resolve } from "node:path";
import type { AppConfig } from "./config.js";
import type { AuditLog } from "./audit.js";

const run = promisify(execFile);

/** Commands the agent may run inside the clone: the repo's own checks plus
 * read-only git and EXACT path-scoped index hygiene. No blanket destructive
 * git: no bare reset/restore, no `checkout -- <path>`, no `add -A/-u/.`. */
/** `gh repo clone` leaves a plain https remote; git itself has no credentials.
 * Push through gh as the credential helper so GH_TOKEN (or gh login) is used. */
const GH_CRED = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"];

const SAFE_CMD = new RegExp(
  "^(" +
    "npm (test|run (test|typecheck|build|report|render))" +
    "|npx (tsc|tsx --test\\b.*)" +
    "|git (status|diff|log|show)\\b[^\\n]*" +
    "|git add(?!.*\\s(-A|--all|-u))(?!.*\\s\\.(\\s|$)) -- [^\\n;|&]+" +
    "|git commit\\b[^\\n;|&]*" +
    "|git checkout\\s+(-[bB]\\s+)?[\\w.][\\w./-]*\\s*" +
    "|git rm --cached( -f)? -- [^\\n;|&]+" +
    "|git restore --staged -- [^\\n;|&]+" +
    "|git reset -q -- [^\\n;|&]+" +
  ")$",
);

/** App/agent state must never enter a PR automatically (sdk-app/state/*). */
const NEVER_PR = /(^|\/)sdk-app\/state\//;

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
  async clone(repo: string, ref?: string): Promise<string> {
    const allowed = this.deps.config.githubRepos.includes(repo) || repo.startsWith("/");
    if (!allowed) return `BLOCKED: ${repo} is not in the repo allowlist (SDK_APP_GITHUB_REPOS). Ask a human to add it.`;
    const dir = this.cloneDir(repo);
    if (!existsSync(dir)) {
      if (repo.startsWith("/")) await run("git", ["clone", "-q", repo, dir]);
      else await run("gh", ["repo", "clone", repo, dir, "--", "-q", "--depth", "50"]);
    }
    if (ref) {
      // a fix may target a branch under review, not the default branch
      const resolved = await this.resolveRef(dir, ref, repo);
      if (!resolved) return `BLOCKED: ref ${ref} could not be resolved in ${repo}. Supply a branch, tag, or full 40-char SHA; short SHAs resolve when reachable from fetched history.`;
      await run("git", ["-C", dir, "checkout", "-q", resolved]);
    } else {
      await run("git", ["-C", dir, "fetch", "--quiet", "origin", "HEAD"]).catch(() => {});
    }
    // the PR diff base: exactly what the factory branch forked from
    const baseSha = (await run("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();
    writeFileSync(join(dir, ".git", "factory-base"), baseSha + "\n");
    const branch = `factory/sdk-${Date.now().toString(36)}`;
    await run("git", ["-C", dir, "checkout", "-q", "-B", branch]);
    await this.setupToolchain(dir);
    this.deps.audit.write("tool_call", { tool: "factory_clone", repo, dir, branch, ref });
    return `cloned ${repo}${ref ? ` @ ${ref}` : ""} -> ${dir} on branch ${branch}`;
  }

  /** Resolve a ref to a full commit SHA. Branches/tags are advertised refs and
   * fetch by name; a full 40-char SHA fetches by object id (GitHub serves
   * reachable objects); a short SHA is NOT an advertised ref, so it is
   * resolved as a real git object against progressively deepened history. */
  private async resolveRef(dir: string, ref: string, repo?: string): Promise<string | undefined> {
    const isSha = /^[0-9a-f]{7,40}$/i.test(ref);
    const local = () => run("git", ["-C", dir, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).then((r) => r.stdout.trim()).catch(() => "");
    if (isSha) {
      let sha = await local();
      if (sha) return sha;
      if (ref.length === 40) {
        await run("git", ["-C", dir, "fetch", "--quiet", "origin", ref]).catch(() => {});
        sha = await local();
        if (sha) return sha;
      } else if (repo && !repo.startsWith("/")) {
        // A short SHA is not an advertised ref and can sit outside the shallow
        // window. Resolve it through the GitHub API to its full SHA, then
        // fetch that object directly (GitHub serves reachable objects by full
        // SHA - the same path the 40-char branch above uses).
        const full = await run("gh", ["api", `repos/${repo}/commits/${ref}`, "--jq", ".sha"]).then((r) => r.stdout.trim()).catch(() => "");
        if (/^[0-9a-f]{40}$/i.test(full)) {
          await run("git", ["-C", dir, "fetch", "--quiet", "origin", full]).catch(() => {});
          sha = await local();
          if (sha) return sha;
        }
      }
      for (const deepen of ["--deepen=500", "--unshallow"]) {
        await run("git", ["-C", dir, "fetch", "--quiet", deepen, "origin"]).catch(() => {});
        sha = await local();
        if (sha) return sha;
      }
      return undefined;
    }
    const ok = await run("git", ["-C", dir, "fetch", "--quiet", "origin", ref]).then(() => true).catch(() => false);
    if (!ok) return undefined;
    return (await run("git", ["-C", dir, "rev-parse", "FETCH_HEAD"])).stdout.trim();
  }

  private async baseOf(dir: string): Promise<string> {
    try {
      const b = readFileSync(join(dir, ".git", "factory-base"), "utf8").trim();
      if (/^[0-9a-f]{40}$/.test(b)) return b;
    } catch { /* no recorded base */ }
    const mb = await run("git", ["-C", dir, "merge-base", "origin/HEAD", "HEAD"]).then((r) => r.stdout.trim()).catch(() => "");
    return /^[0-9a-f]{40}$/.test(mb) ? mb : "HEAD";
  }

  /** The clone must run the repo's own checks (`npx tsx --test ...`) without
   * a global npm resolve: the global prefix is read-only here, so a bare
   * `npx tsx` in a fresh clone dies with EACCES on npm-globals.lock. Reuse
   * the app's own installed toolchain via a node_modules symlink, smoke-check
   * it, and fall back to a clean `npm ci` when the symlink is unusable. */
  private async setupToolchain(dir: string): Promise<void> {
    const nm = join(dir, "node_modules");
    if (existsSync(nm) || !existsSync(join(dir, "package.json"))) return;
    const mainNm = fileURLToPath(new URL("../../node_modules", import.meta.url));
    try {
      symlinkSync(mainNm, nm, "dir");
      // a symlink is not a directory to git's exclude matching: "node_modules/"
      // in .gitignore does NOT match the symlink, so scan_diff's git add -N -A
      // would sweep the toolchain into the PR diff. Exclude it locally.
      appendFileSync(join(dir, ".git", "info", "exclude"), "\nnode_modules\n");
      await run("npx", ["--no-install", "tsx", "--version"], { cwd: dir });
    } catch {
      rmSync(nm, { force: true, recursive: true });
      await run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: dir });
    }
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

  private servers = new Map<string, { url: string; server: import("node:http").Server }>();

  /** Static, loopback-only file server over a clone directory, so the app's own
   * browser tools can exercise a UI built from the clone (before and after a fix). */
  async serve(repo: string, subdir = "."): Promise<string> {
    const root = this.guardPath(repo, subdir);
    const key = `${repo}|${root}`;
    const have = this.servers.get(key);
    if (have) return `serving ${subdir} of ${repo} at ${have.url} (already running)`;
    const http = await import("node:http");
    const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };
    const server = http.createServer((req, res) => {
      try {
        const u = decodeURIComponent((req.url ?? "/").split("?")[0]);
        let f = resolve(root, "." + (u.endsWith("/") ? u + "index.html" : u));
        if (!f.startsWith(root + "/") && f !== root) { res.writeHead(403).end("forbidden"); return; }
        if (!existsSync(f)) { res.writeHead(404).end("not found"); return; }
        const ext = f.slice(f.lastIndexOf("."));
        res.writeHead(200, { "content-type": types[ext] ?? "text/plain", "cache-control": "no-store" }).end(readFileSync(f));
      } catch { res.writeHead(500).end("error"); }
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const url = `http://127.0.0.1:${(server.address() as any).port}/`;
    this.servers.set(key, { url, server });
    this.deps.audit.write("tool_call", { tool: "factory_serve", repo, subdir, url });
    return `serving ${subdir} of ${repo} at ${url} (static, loopback only; reflects the clone's current files on each load)`;
  }

  async close(): Promise<void> {
    for (const { server } of this.servers.values()) server.close();
    this.servers.clear();
  }

  /** Evidence screenshot: run the repo's own render command in the clone, then
   * render the produced HTML file with headless Chromium. Returns the PNG path
   * (the caller shows the pixels to the model and posts them to the thread). */
  async screenshotEvidence(repo: string, cmd: string, htmlPath: string): Promise<{ path: string; log: string }> {
    const log = await this.runChecks(repo, cmd);
    if (/^BLOCKED|^EXIT /.test(log)) throw new Error(`render command failed: ${log.slice(0, 400)}`);
    const html = this.guardPath(repo, htmlPath);
    if (!existsSync(html)) throw new Error(`${htmlPath} was not produced by \`${cmd}\``);
    const outDir = join(dirname(this.deps.config.auditLog), "evidence");
    mkdirSync(outDir, { recursive: true });
    const path = join(outDir, `evidence-${Date.now()}.png`);
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
      await page.goto(`file://${html}`);
      await page.screenshot({ path, fullPage: true });
    } finally {
      await browser.close();
    }
    this.deps.audit.write("tool_call", { tool: "factory_screenshot", repo, cmd, html: htmlPath, file: path });
    return { path, log };
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

  private prStash?: { fingerprint: string };

  /** The exact review set for a PR: branch-vs-base (COMMITTED and working and
   * untracked), minus app/agent state paths. Fingerprint binds an approval to
   * precisely this diff + payload; a changed branch invalidates it. */
  private async prReviewSet(repo: string, title: string, body: string) {
    const dir = this.cloneDir(repo);
    const branch = (await run("git", ["-C", dir, "branch", "--show-current"])).stdout.trim();
    const base = await this.baseOf(dir);
    await run("git", ["-C", dir, "add", "-N", "-A"]); // intent-to-add: untracked join the diff
    const EXC = [":(exclude)sdk-app/state/*", ":(exclude)sdk-app/state"];
    const { stdout: fullDiff } = await run("git", ["-C", dir, "diff", base, "--", ".", ...EXC]);
    const { stdout: stat } = await run("git", ["-C", dir, "diff", "--stat", base, "--", ".", ...EXC]);
    const { stdout: committedStat } = await run("git", ["-C", dir, "diff", "--stat", base, "HEAD", "--", ".", ...EXC]);
    const { stdout: stateFiles } = await run("git", ["-C", dir, "diff", "--name-only", base, "--", "sdk-app/state"]);
    const fingerprint = createHash("sha256").update(`${branch}\n${base}\n${title}\n${body}\n${fullDiff}`).digest("hex");
    return { dir, branch, base, fullDiff, stat, committedStat, stateFiles: stateFiles.trim(), fingerprint };
  }

  /** Called by the approval gate BEFORE the human decides: records the exact
   * diff fingerprint the approval covers, for createPr to verify at execution. */
  async prFingerprint(repo: string, title: string, body: string): Promise<string> {
    const rs = await this.prReviewSet(repo, title, body);
    this.prStash = { fingerprint: rs.fingerprint };
    return rs.fingerprint;
  }

  /** GATED + armed-only. dry-run returns the exact plan without executing. */
  async createPr(repo: string, title: string, body: string): Promise<string> {
    if (repo.startsWith("/")) return "BLOCKED: PRs only for GitHub repos, not local fixtures.";
    const dir = this.cloneDir(repo);
    const scan = await this.scanDiff(repo);
    if (!scan.clean) return `BLOCKED: secrets in the diff: ${scan.findings.join("; ")}`;
    const rs = await this.prReviewSet(repo, title, body);
    const { branch, base, stat, committedStat, fingerprint } = rs;
    // Approval binding: when the gate stashed a fingerprint, this execution
    // must match it exactly - any branch/diff change after approval invalidates.
    if (this.prStash) {
      const stashed = this.prStash.fingerprint;
      this.prStash = undefined;
      if (stashed !== fingerprint) {
        this.deps.audit.write("tool_call", { tool: "factory_create_pr", repo, title, refused: "diff-changed-after-approval" });
        return `REFUSED: the branch changed after approval (diff-hash was ${stashed.slice(0, 12)}, now ${fingerprint.slice(0, 12)}). Request approval again for the new diff.`;
      }
    }
    // Idempotency: an open PR for this exact branch already exists -> return
    // it instead of double-pushing/double-opening on a retried turn.
    const existing = await run("gh", ["pr", "list", "--repo", repo, "--head", branch, "--state", "open", "--json", "url", "--jq", ".[0].url"]).then((r) => r.stdout.trim()).catch(() => "");
    const hasCommitted = Boolean(committedStat.trim());
    const hasWorking = Boolean(stat.trim()) && stat.trim() !== committedStat.trim();
    if (!stat.trim() && !existing) return `No changes on ${branch} vs base ${base.slice(0, 7)} and no open PR - nothing to do.`;
    const excludedNote = rs.stateFiles ? `\nEXCLUDED (never auto-PR'd state): ${rs.stateFiles}` : "";
    if (this.deps.config.dryRun) {
      return `[dry-run] would ${hasWorking ? "commit the working-tree files on the branch, then " : ""}${hasCommitted || hasWorking ? `push ${branch} and ` : ""}${existing ? "re-use the existing open PR" : "open a PR"} in ${repo}:\nTITLE: ${title}\nDIFF STAT (vs base ${base.slice(0, 7)}, committed + working):\n${stat || "(no diff)"}${excludedNote}\nDIFF HASH: ${fingerprint.slice(0, 12)}${existing ? `\nEXISTING PR: ${existing}` : ""}\nArm with SDK_APP_DRY_RUN=0 to execute.`;
    }
    if (stat.trim()) {
      // commit only the reviewed set - never app/agent state paths
      await run("git", ["-C", dir, "add", "-A", "--", ".", ":(exclude)sdk-app/state/*", ":(exclude)sdk-app/state"]);
      const { stdout: staged } = await run("git", ["-C", dir, "diff", "--cached", "--name-only"]);
      if (staged.trim()) {
        await run("git", ["-C", dir, "commit", "-q", "-m", title]);
        await run("git", ["-C", dir, ...GH_CRED, "push", "-q", "-u", "origin", branch]);
      } else if (hasCommitted) {
        await run("git", ["-C", dir, ...GH_CRED, "push", "-q", "-u", "origin", branch]);
      }
    }
    if (existing) {
      this.deps.audit.write("tool_call", { tool: "factory_create_pr", repo, title, url: existing, idempotent: true });
      return `PR already open for ${branch}: ${existing} (no duplicate created).`;
    }
    const { stdout } = await run("gh", ["pr", "create", "--repo", repo, "--head", branch, "--title", title, "--body", body, "--draft"]);
    this.deps.audit.write("tool_call", { tool: "factory_create_pr", repo, title, url: stdout.trim() });
    return `PR created: ${stdout.trim()}`;
  }
}
