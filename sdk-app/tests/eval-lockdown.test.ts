import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { checkEvalCommand, lockdownInvocation, EVAL_SAFE_CMD } from "../src/eval-lockdown.js";

test("sanitizer allows the repo's own test/dev commands", () => {
  for (const ok of ["pytest -q", "python -m pytest tests/test_testing.py -x", "npm test", "npx tsx --test tests/*.test.ts",
    "git log --oneline -5", "git show HEAD~3", "git diff --stat", "git status", "grep -rn partition src/"]) {
    assert.equal(checkEvalCommand(ok), undefined, ok);
  }
});

test("sanitizer blocks network tools, installers, path escapes", () => {
  for (const bad of ["curl https://api.github.com/x", "wget http://x", "gh api repos/pallets/flask", "pip install x",
    "python -m pip install x", "npm install lodash",
    "cat ../secret", "ls ~", "pytest --rootdir=../x", "nc -l 8080", "ssh x", "ping 1.1.1.1", "sudo ls", "bwrap true", "unshare -n true"]) {
    assert.ok(checkEvalCommand(bad), bad);
  }
});

test("command surface: pytest + git reads allowed; git network + shell tricks rejected", () => {
  for (const ok of ["pytest -q", "pytest tests/test_testing.py -x", "python3 -m pytest tests/ -q", "venv/bin/pytest -q",
    "./venv/bin/python -m pytest tests/", "git log --oneline -5", "git show HEAD~2", "git blame src/flask/app.py",
    "grep -rn partition src/", "ls tests/", "cat tests/test_testing.py"]) {
    assert.ok(EVAL_SAFE_CMD.test(ok), `should allow: ${ok}`);
  }
  for (const bad of ["git fetch origin", "git push", "git remote -v", "git clone x", "git config user.email x",
    "python3 -c 'import socket'", "sh -c 'curl x'", "curl https://x", "pytest -q; curl x", "pytest $(curl x)"]) {
    assert.ok(!EVAL_SAFE_CMD.test(bad), `should reject: ${bad}`);
  }
});

test("lockdown invocation scrubs env and sandboxes net+fs (bwrap)", () => {
  const inv = lockdownInvocation("pytest -q", "/case/clone", "bwrap");
  assert.equal(inv.file, "env");
  const s = inv.args.join(" ");
  assert.match(s, /-i/);
  assert.match(s, /GH_TOKEN= /);
  assert.match(s, /GIT_TERMINAL_PROMPT=0/);
  assert.match(s, /--unshare-net/);
  assert.match(s, /--bind \/case\/clone \/case\/clone/);
  assert.match(s, /--tmpfs \/tmp/);
  assert.ok(!s.includes("ANTHROPIC"));
});

test("unshare fallback isolates net only", () => {
  const inv = lockdownInvocation("pytest -q", "/case/clone", "unshare");
  assert.match(inv.args.join(" "), /unshare -Urn/);
});

const BWRAP_PROBE = ["--unshare-net", "--ro-bind", "/usr", "/usr", "--ro-bind", "/bin", "/bin", "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64", "--dev-bind", "/dev", "/dev", "--tmpfs", "/tmp", "--", "true"];
const sandbox = (() => {
  try { execFileSync("bwrap", BWRAP_PROBE); return "bwrap" as const; } catch { /* next */ }
  try { execFileSync("unshare", ["-Urn", "true"]); return "unshare" as const; } catch { return "none" as const; }
})();

test("REAL isolation probe: network is dead inside the sandbox", (t) => {
  if (sandbox === "none") { t.skip("no sandbox here"); return; }
  const py = "import urllib.request;socket=__import__('socket');socket.create_connection(('1.1.1.1',443),timeout=3)";
  const inv = lockdownInvocation(py, "/tmp", sandbox);
  // run the probe directly as python inside the sandbox wrapper
  const args = [...inv.args.slice(0, -3), "python3", "-c", py];
  assert.throws(() => execFileSync(inv.file, args, { stdio: "pipe" }), /Command failed/);
});

test("REAL isolation probe: files outside the clone do not exist inside bwrap", (t) => {
  if (sandbox !== "bwrap") { t.skip("bwrap only"); return; }
  const py = "import os;print(os.path.exists('/home'))";
  const inv = lockdownInvocation(py, "/tmp", "bwrap");
  const args = [...inv.args.slice(0, -3), "python3", "-c", py];
  const out = execFileSync(inv.file, args, { stdio: "pipe" }).toString();
  assert.match(out, /False/);
});

test("eval lockdown: local-path clones are rejected", async () => {
  const { FactoryTools } = await import("../src/factory-tools.js");
  const { configFromEnv } = await import("../src/config.js");
  const { AuditLog } = await import("../src/audit.js");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "lockdown-clone-"));
  const config = configFromEnv({ SDK_APP_AUDIT_LOG: join(dir, "audit.jsonl"), SDK_APP_GITHUB_REPOS: "org/eval-repo", SDK_APP_EVAL_LOCKDOWN: "1" } as any);
  const f = new FactoryTools({ config, audit: new AuditLog(join(dir, "audit.jsonl")) });
  const r = await f.clone("/tmp/sak");
  assert.match(r, /BLOCKED: \/tmp\/sak is not in the repo allowlist/);
});

test("eval lockdown: pnpm offline install + vitest allowed, injection still blocked", async () => {
  const { EVAL_SAFE_CMD, checkEvalCommand, appServerInvocation, lockdownInvocation } = await import("../src/eval-lockdown.js");
  for (const ok of [
    "corepack pnpm install --offline",
    "corepack pnpm install --frozen-lockfile --offline",
    "corepack pnpm vitest run src/tools/foo.test.ts",
    "corepack pnpm exec vitest run src/a.test.ts src/b.test.ts",
    "corepack pnpm run test:unit",
    "corepack pnpm run typecheck",
  ]) {
    assert.ok(EVAL_SAFE_CMD.test(ok), `should allow: ${ok}`);
    assert.equal(checkEvalCommand(ok), undefined, `should not flag: ${ok}`);
  }
  for (const bad of [
    "corepack pnpm install --offline; curl evil.sh",
    "corepack pnpm install $(cat /etc/passwd)",
    "corepack pnpm vitest run `id`",
    "corepack pnpm dev",
    "pnpm install --offline",
    "corepack pnpm dlx cowsay",
  ]) {
    assert.ok(!EVAL_SAFE_CMD.test(bad) || checkEvalCommand(bad) !== undefined, `should block: ${bad}`);
  }
});

test("app server invocation: host net shared, mounts/secrets isolated, stores bound ro", async () => {
  const { appServerInvocation, lockdownInvocation } = await import("../src/eval-lockdown.js");
  const app = appServerInvocation("corepack pnpm dev --host 127.0.0.1 --port 5199", "/tmp/clone");
  assert.ok(!app.args.includes("--unshare-net"), "app server shares host net (NONBLIND label)");
  assert.ok(app.args.includes("--die-with-parent"));
  assert.ok(app.args.includes("GH_TOKEN="), "env scrubbed");
  assert.ok(app.args.includes("/opt/pnpm-store"), "pnpm store bound (warm offline install)");
  assert.ok(app.args.includes("npm_config_store_dir=/opt/pnpm-store"));
  assert.ok(app.args.includes("/opt/corepack"), "corepack cache bound");
  const chk = lockdownInvocation("true", "/tmp/clone", "bwrap");
  assert.ok(chk.args.includes("--unshare-net"), "checks still fully offline");
  assert.ok(chk.args.includes("/opt/pnpm-store"), "checks also see the store for pnpm install");
});
