/** Factory, SDK-native: the old pipeline (triage->plan->implement->test->PR)
 * is replaced by the SDK loop driving these tools conversationally. The
 * mechanics are preserved: work happens in an isolated clone, tests come
 * from the repo's own scripts, diffs are scanned for secrets, and creating
 * a PR is approval-gated + dry-run unless armed. Never merges, never
 * pushes to main. */
import { execFile } from "node:child_process";
import { checkEvalCommand, lockdownInvocation, EVAL_SAFE_CMD, type SandboxKind } from "./eval-lockdown.js";
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

/** Test files are writable at any time (writing the failing regression test
 * is the FIRST step); the repro gate only guards non-test writes. */
const TEST_PATH = /(^|\/)(tests?|__tests__|spec)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$/;
/** Commands that count as "the repo's own test suite" for green/red evidence. */
const TEST_CMD = /^(npm test|npm run test|npx tsx --test)\b/;

/** Evidence the workflow gate records FROM ACTUAL TOOL CALLS (never from model
 * claims): failing/passing test runs with their real exit codes, and browser
 * interaction + screenshot evidence against the factory's own loopback servers.
 * Every record binds a git TREE HASH of the clone (HEAD + full diff, untracked
 * included): any later change - by tool, shell or git - makes evidence stale.
 * Reproduction records must be captured while the tree has no non-test changes
 * vs the case base, so "before" evidence cannot be faked after the fix.
 * The ledger lives in the APP state dir, never inside the clone: repo code
 * (test scripts, hooks) runs with filesystem access and could forge a file
 * inside its own .git. */
export type UiEvidence = { kind: "browse" | "screenshot"; at: string; tree: string };
export type WorkflowState = {
  caseId: string;
  baseSha: string;
  /** The ref the clone started from (branch/tag the case targets), if any:
   * the PR opens against it instead of the repo default branch. */
  baseRef?: string;
  /** Tree hash at clone time: the untouched base the case forked from. */
  baseTree: string;
  /** UI case: a screenshot rode in with the report, or the clone was served/
   * rendered. UI cases need real before+after browser evidence; non-UI cases
   * prove out with a failing test alone. */
  uiCase: boolean;
  /** Fast-feedback counters for the write gate (the PR gate re-derives truth
   * from git, so shell-side writes cannot bypass freshness). */
  writes: number;
  sourceWrites: number;
  reproTest?: { cmd: string; exitCode: number; at: string };
  reproUi?: UiEvidence;
  reproInteract?: UiEvidence;
  greenRun?: { cmd: string; at: string; tree: string };
  afterUi?: UiEvidence;
  /** The model's reasoned read of the UI, independently re-checked by the app
   * against the live page (or the rendered HTML) at record time. */
  beforeAssertion?: { observed: string; meaning: string; at: string };
  afterAssertion?: { observed: string; meaning: string; at: string; tree: string };
  /** What made this a UI case: an image in the report demands the real browse
   * path (interaction + screenshot + assertion); "serve"/"render" may also use
   * the repo's own render command (factory_screenshot) as evidence. */
  uiOrigin?: "image" | "serve" | "render";
};

export type FactoryDeps = {
  config: AppConfig;
  audit: AuditLog;
  /** Independent read of the browser's current state, wired by the runtime:
   * factory_record_ui_state checks the model's claimed observation against
   * what the app itself sees on the page. */
  pageState?: () => Promise<{ url: string; text: string } | undefined>;
};

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
  async clone(repo: string, ref?: string, turnCtx?: { threadKey?: string; hasImages?: boolean }): Promise<string> {
    // eval lockdown: local paths are out of the eval boundary - allowlisted remotes only
    const allowed = this.deps.config.githubRepos.includes(repo) || (!this.deps.config.evalLockdown && repo.startsWith("/"));
    if (!allowed) return `BLOCKED: ${repo} is not in the repo allowlist (SDK_APP_GITHUB_REPOS). Ask a human to add it.`;
    if (this.deps.config.evalLockdown) {
      // fail closed: eval runs are not "blind" without OS-level isolation
      const kind = await this.sandboxKind();
      if (kind === "none") return "BLOCKED: eval lockdown is on but no sandbox works here (bwrap/userns) - refusing an unisolated eval run. Unset SDK_APP_EVAL_LOCKDOWN only for non-eval work.";
    }
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
    // fresh case: reset the workflow evidence ledger. A report that carried a
    // screenshot starts as a UI case; serving/rendering the clone flips it too.
    this.saveWf(repo, { caseId: branch, baseSha, baseRef: ref, baseTree: await this.treeHash(dir), uiCase: Boolean(turnCtx?.hasImages), uiOrigin: turnCtx?.hasImages ? "image" : undefined, writes: 0, sourceWrites: 0 });
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

  private _sandbox: SandboxKind | undefined;
  private async sandboxKind(): Promise<SandboxKind> {
    if (this._sandbox) return this._sandbox;
    if (await run("bwrap", ["--unshare-net", "--ro-bind", "/usr", "/usr", "--ro-bind", "/bin", "/bin", "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64", "--dev-bind", "/dev", "/dev", "--tmpfs", "/tmp", "--", "true"]).then(() => true).catch(() => false)) return (this._sandbox = "bwrap");
    if (await run("unshare", ["-Urn", "true"]).then(() => true).catch(() => false)) return (this._sandbox = "unshare");
    return (this._sandbox = "none");
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

  private wfPath(repo: string): string {
    const dir = join(dirname(this.deps.config.auditLog), "factory-workflow");
    mkdirSync(dir, { recursive: true });
    return join(dir, repo.replace(/[^\w.-]+/g, "_") + ".json");
  }

  private loadWf(repo: string): WorkflowState {
    try {
      return JSON.parse(readFileSync(this.wfPath(repo), "utf8")) as WorkflowState;
    } catch {
      return { caseId: "", baseSha: "", baseTree: "", uiCase: false, writes: 0, sourceWrites: 0 };
    }
  }

  private saveWf(repo: string, st: WorkflowState): void {
    try { writeFileSync(this.wfPath(repo), JSON.stringify(st, null, 2)); } catch { /* pre-clone: no dir yet */ }
  }

  /** Content hash of the clone's full state: HEAD + complete diff vs HEAD with
   * untracked files intent-to-added. Any change - tool, shell, git - moves it. */
  private async treeHash(dir: string): Promise<string> {
    await run("git", ["-C", dir, "add", "-N", "-A"]);
    const head = await run("git", ["-C", dir, "rev-parse", "HEAD"]).then((r) => r.stdout.trim()).catch(() => "");
    const { stdout: diff } = await run("git", ["-C", dir, "diff", "HEAD"], { maxBuffer: 64 * 1024 * 1024 });
    return createHash("sha256").update(head + "\n" + diff).digest("hex");
  }

  /** True when nothing but test files differ from the case base: "before-fix"
   * evidence is only honest while the source is untouched. */
  private async sourceClean(dir: string): Promise<boolean> {
    const { stdout } = await run("git", ["-C", dir, "status", "--porcelain"]);
    return stdout.split("\n").filter(Boolean).every((l) => TEST_PATH.test(l.slice(3)));
  }

  /** Browse tools report interactions and screenshots; when the URL is one of
   * this factory's loopback servers it counts as UI evidence for that case.
   * A screenshot alone is not reproduction: an interaction (click/type) and a
   * screenshot, both while the source is untouched, make the before-evidence. */
  async noteBrowseEvidence(url: string, kind: "interact" | "screenshot"): Promise<void> {
    let origin = "";
    try { origin = new URL(url).origin; } catch { return; }
    if (!origin) return;
    for (const [key, entry] of this.servers) {
      try {
        if (new URL(entry.url).origin !== origin) continue;
      } catch { continue; }
      await this.recordUiEvidence(key.split("|")[0], "browse", kind);
    }
  }

  private async recordUiEvidence(repo: string, kind: "browse" | "screenshot", phase: "interact" | "screenshot"): Promise<void> {
    const dir = this.cloneDir(repo);
    if (!existsSync(join(dir, ".git"))) return;
    const st = this.loadWf(repo);
    const tree = await this.treeHash(dir);
    const clean = await this.sourceClean(dir);
    const ev: UiEvidence = { kind, at: new Date().toISOString(), tree };
    if (clean) {
      if (phase === "interact") st.reproInteract = ev; else st.reproUi = ev;
    } else if (phase === "screenshot") {
      st.afterUi = ev;
    }
    st.uiCase = true;
    st.uiOrigin = st.uiOrigin ?? (kind === "screenshot" ? "render" : "serve");
    this.saveWf(repo, st);
    this.deps.audit.write("tool_call", { tool: "factory_evidence", repo, kind, phase, sourceClean: clean });
  }

  /** What blocks the first non-test write, or undefined when source edits may proceed. */
  private missingRepro(st: WorkflowState): string | undefined {
    if (st.sourceWrites > 0) return undefined; // gate already passed for this case
    if (st.uiCase) {
      if (!st.reproUi) {
        return "no BEFORE-FIX UI evidence recorded for this UI case. Reproduce the broken behavior first: factory_serve the clone, browse_open the returned 127.0.0.1 URL, interact with browse_type/browse_click, and capture browse_screenshot (or run factory_screenshot on the repo's own render command). Evidence is recorded automatically from those calls; this refusal clears once it exists.";
      }
      return undefined;
    }
    if (!st.reproTest && !st.reproUi) {
      return "no reproduction evidence recorded. Prove the bug before editing source: add a regression test (test files are writable now) and run it with factory_run_checks (npm test) to capture the failing state, or reproduce a UI issue in the browser (factory_serve + browse_screenshot).";
    }
    return undefined;
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
    const st = this.loadWf(repo);
    const isTest = TEST_PATH.test(path);
    if (!isTest) {
      const missing = this.missingRepro(st);
      if (missing) {
        this.deps.audit.write("tool_call", { tool: "factory_write_file", repo, path, refused: "no-repro-evidence" });
        return `BLOCKED: ${missing}`;
      }
    }
    writeFileSync(p, content);
    st.writes++;
    if (!isTest) st.sourceWrites++;
    this.saveWf(repo, st);
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
    const lockdown = this.deps.config.evalLockdown;
    const cmdOk = lockdown ? EVAL_SAFE_CMD.test(cmd.trim()) : SAFE_CMD.test(cmd);
    if (!cmdOk) return `BLOCKED: command not in the ${lockdown ? "eval" : "factory"} allowlist (repo's own test/typecheck/build/git commands only): ${cmd}`;
    const dir = this.cloneDir(repo);
    this.deps.audit.write("tool_call", { tool: "factory_run", repo, cmd });
    const isTest = TEST_CMD.test(cmd.trim());
    let runFile = "sh";
    let runArgs = ["-c", cmd];
    if (lockdown) {
      const blocked = checkEvalCommand(cmd);
      if (blocked) {
        this.deps.audit.write("tool_call", { tool: "factory_run", repo, cmd, refused: "eval-lockdown" });
        return `BLOCKED: ${blocked}`;
      }
      const kind = await this.sandboxKind();
      if (kind === "none") {
        this.deps.audit.write("tool_call", { tool: "factory_run", repo, cmd, refused: "eval-lockdown-no-sandbox" });
        return "BLOCKED: eval lockdown needs a sandbox (bwrap or user namespaces) and none works here - refusing an unisolated eval command. Unset SDK_APP_EVAL_LOCKDOWN only for non-eval work.";
      }
      // the command goes to sh -c as ONE argv element - no script file,
      // which would have to live inside the sandboxed mount set anyway
      const inv = lockdownInvocation(cmd, dir, kind);
      runFile = inv.file;
      runArgs = inv.args;
      this.deps.audit.write("tool_call", { tool: "factory_run", repo, sandbox: kind });
    }
    const record = async (exitCode: number) => {
      if (!isTest) return;
      const st = this.loadWf(repo);
      const at = new Date().toISOString();
      if (exitCode !== 0) {
        // red-state evidence counts only while the source is untouched;
        // a failing run after edits is just a failing run.
        if ((await this.sourceClean(dir)) && !st.reproTest) st.reproTest = { cmd, exitCode, at };
      } else {
        st.greenRun = { cmd, at, tree: await this.treeHash(dir) };
      }
      this.saveWf(repo, st);
    };
    try {
      const { stdout, stderr } = await run(runFile, runArgs, { cwd: dir, timeout: 240_000, maxBuffer: 4 * 1024 * 1024 });
      await record(0);
      return (stdout + stderr).slice(-4000) || "(no output, exit 0)";
    } catch (e: any) {
      await record(typeof e.code === "number" ? e.code : 1);
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
    const st = this.loadWf(repo);
    if (!st.uiCase) { st.uiCase = true; st.uiOrigin = st.uiOrigin ?? "serve"; this.saveWf(repo, st); }
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
    this.lastRenderHtml = html;
    await this.recordUiEvidence(repo, "screenshot", "screenshot");
    return { path, log };
  }

  /** The model records what it observed in the UI and what it means; the app
   * INDEPENDENTLY re-reads the live page (or the last rendered HTML) and
   * confirms the observed string is really there. A claim that does not match
   * the app's own read is rejected with the app's own excerpt. */
  async recordUiState(repo: string, phase: "before" | "after", observed: string, meaning: string): Promise<string> {
    const dir = this.cloneDir(repo);
    if (!existsSync(join(dir, ".git"))) return "BLOCKED: no factory clone for this repo.";
    const st = this.loadWf(repo);
    let pageText = "";
    let where = "";
    const ps = this.deps.pageState ? await this.deps.pageState().catch(() => undefined) : undefined;
    if (ps) {
      let servedHere = false;
      try {
        const origin = new URL(ps.url).origin;
        for (const [key, entry] of this.servers) {
          if (key.split("|")[0] !== repo) continue;
          try { if (new URL(entry.url).origin === origin) servedHere = true; } catch { /* ignore */ }
        }
      } catch { /* bad url */ }
      if (servedHere) { pageText = ps.text; where = `live page ${ps.url}`; }
    }
    if (!pageText && this.lastRenderHtml && existsSync(this.lastRenderHtml) && this.lastRenderHtml.startsWith(dir)) {
      // Same visibility semantics as the live-page path: rendered VISIBLE text
      // (body.innerText), not raw HTML - hidden elements must not false-pass a claim.
      try {
        const { chromium } = await import("playwright");
        const browser = await chromium.launch({ headless: true });
        try {
          const page = await browser.newPage();
          await page.goto(`file://${this.lastRenderHtml}`);
          pageText = await page.locator("body").innerText({ timeout: 5_000 });
        } finally {
          await browser.close();
        }
      } catch { pageText = ""; }
      if (pageText) where = `rendered ${this.lastRenderHtml.slice(dir.length + 1)}`;
    }
    if (!pageText) return "BLOCKED: the app cannot independently see the UI state: open the served page in the browser (browse_open on the factory_serve URL) or run factory_screenshot first.";
    const norm = (t: string) => t.replace(/\s+/g, " ");
    if (!norm(pageText).includes(norm(observed))) {
      this.deps.audit.write("tool_call", { tool: "factory_record_ui_state", repo, phase, observed: observed.slice(0, 120), verified: false });
      return `REJECTED: your claimed observation "${observed.slice(0, 120)}" is NOT on the ${where} as the app itself reads it. The app's read includes: ${norm(pageText).slice(0, 400)}`;
    }
    const at = new Date().toISOString();
    if (phase === "before") {
      if (!(await this.sourceClean(dir))) return "BLOCKED: before-state must be recorded while the source is untouched; the clone already has non-test changes.";
      st.beforeAssertion = { observed: observed.slice(0, 500), meaning: meaning.slice(0, 500), at };
      st.uiCase = true;
    } else {
      st.afterAssertion = { observed: observed.slice(0, 500), meaning: meaning.slice(0, 500), at, tree: await this.treeHash(dir) };
    }
    this.saveWf(repo, st);
    this.deps.audit.write("tool_call", { tool: "factory_record_ui_state", repo, phase, observed: observed.slice(0, 120), verified: true });
    return `verified: "${observed.slice(0, 120)}" is present on the ${where}; recorded as ${phase}-evidence.`;
  }

  private lastRenderHtml?: string;

  /** Test support: seed a complete, genuinely-valid workflow ledger for a
   * hand-built clone. Hashes are computed from git, so this fakes nothing -
   * it only skips driving the tool calls a real case would have made. */
  async __seedWorkflowForTests(repo: string, uiCase = false): Promise<void> {
    const dir = this.cloneDir(repo);
    const tree = await this.treeHash(dir);
    const at = new Date().toISOString();
    const st: WorkflowState = {
      caseId: "test-seed", baseSha: "", baseTree: tree, uiCase, writes: 1, sourceWrites: 1,
      reproTest: { cmd: "npm test", exitCode: 1, at },
      greenRun: { cmd: "npm test", at, tree },
    };
    if (uiCase) {
      st.reproUi = { kind: "browse", at, tree };
      st.reproInteract = { kind: "browse", at, tree };
      st.afterUi = { kind: "browse", at, tree };
      st.beforeAssertion = { observed: "broken", meaning: "seeded", at };
      st.afterAssertion = { observed: "fixed", meaning: "seeded", at, tree };
    }
    this.saveWf(repo, st);
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
    const wf = this.loadWf(repo);
    {
      const currentTree = await this.treeHash(dir);
      const problems: string[] = [];
      const reproOk = wf.reproTest || wf.reproUi;
      if (!reproOk) problems.push("no reproduction evidence captured while the source was untouched (a failing test run, or before-fix UI evidence from factory_serve + browse interaction + browse_screenshot)");
      if (wf.uiCase) {
        if (!wf.reproUi) problems.push("UI case without BEFORE-fix screenshot evidence captured before source edits (factory_serve, then browse_screenshot the broken behavior)");
        // a report that arrived with a UI screenshot must be reproduced by
        // actually driving the page; the render-only path cannot substitute.
        if (wf.uiOrigin === "image" && wf.reproUi && wf.reproUi.kind !== "browse") problems.push("the report's screenshot came from a real UI: reproduce it by driving the served page (browse_*), not only by rendering files");
        if (wf.reproUi && wf.reproUi.kind === "browse" && !wf.reproInteract) problems.push("BEFORE-fix evidence lacks interaction: reproduce by driving the UI (browse_type/browse_click on the served page), then screenshot the broken result");
        if (!wf.beforeAssertion) problems.push('no verified BEFORE-fix observation: call factory_record_ui_state(phase="before", observed=<exact broken text on the page>, meaning=<why it is wrong>) - the app independently re-reads the page');
        if (!(wf.afterAssertion && wf.afterAssertion.tree === currentTree)) {
          problems.push(wf.afterAssertion
            ? 'the verified AFTER-fix observation is STALE: files changed since; re-record factory_record_ui_state(phase="after") on the final diff'
            : 'no verified AFTER-fix observation on the final diff (factory_record_ui_state with phase="after")');
        }
        if (!(wf.afterUi && wf.afterUi.tree === currentTree)) {
          problems.push(wf.afterUi
            ? "after-fix UI evidence is STALE: files changed since it was captured; re-capture browse_screenshot/factory_screenshot on the final diff"
            : "no AFTER-fix UI evidence on the final diff (browse_screenshot the served UI or factory_screenshot)");
        }
      }
      if (!(wf.greenRun && wf.greenRun.tree === currentTree)) {
        problems.push(wf.greenRun
          ? "the passing test run is STALE: files changed since; re-run the full tests on the final diff"
          : "no passing test run recorded (factory_run_checks: npm test on the final diff)");
      }
      if (problems.length) {
        this.deps.audit.write("tool_call", { tool: "factory_create_pr", repo, title, refused: "workflow-incomplete", problems });
        return `BLOCKED: factory workflow incomplete: ${problems.join("; ")}.`;
      }
    }
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
    const wfBase = this.loadWf(repo).baseRef;
    // --base needs a branch name; a SHA ref keeps the repo default base
    const baseArgs = wfBase && !/^[0-9a-f]{40}$/i.test(wfBase) ? ["--base", wfBase] : [];
    const { stdout } = await run("gh", ["pr", "create", "--repo", repo, "--head", branch, ...baseArgs, "--title", title, "--body", body, "--draft"]);
    this.deps.audit.write("tool_call", { tool: "factory_create_pr", repo, title, url: stdout.trim() });
    return `PR created: ${stdout.trim()}`;
  }
}
