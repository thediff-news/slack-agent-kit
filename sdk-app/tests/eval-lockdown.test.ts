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
