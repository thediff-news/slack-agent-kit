import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { checkEvalCommand, lockdownInvocation } from "../src/eval-lockdown.js";

test("sanitizer allows the repo's own test/dev commands", () => {
  for (const ok of ["pytest -q", "python -m pytest tests/test_testing.py -x", "npm test", "npx tsx --test tests/*.test.ts",
    "git log --oneline -5", "git show HEAD~3", "git diff --stat", "git status", "grep -rn partition src/"]) {
    assert.equal(checkEvalCommand(ok), undefined, ok);
  }
});

test("sanitizer blocks network tools, installers, git remotes, path escapes", () => {
  for (const bad of ["curl https://api.github.com/x", "wget http://x", "gh api repos/pallets/flask", "pip install x",
    "python -m pip install x", "npm install lodash", "git fetch origin", "git push", "git remote -v", "git clone x",
    "cat ../secret", "cat /etc/passwd", "ls ~", "pytest --rootdir=/tmp", "nc -l 8080", "ssh x", "ping 1.1.1.1", "sudo ls"]) {
    assert.ok(checkEvalCommand(bad), bad);
  }
});

test("lockdown invocation scrubs env and wraps in a network namespace", () => {
  const inv = lockdownInvocation("pytest -q", "/tmp/x.sh");
  assert.equal(inv.file, "env");
  const s = inv.args.join(" ");
  assert.match(s, /-i/);
  assert.match(s, /GH_TOKEN= /);
  assert.match(s, /GIT_TERMINAL_PROMPT=0/);
  assert.match(s, /unshare -Urn/);
  assert.ok(!s.includes("ANTHROPIC"));
});

test("REAL isolation probe: python socket + urllib fail inside the sandbox", (t) => {
  try { execFileSync("unshare", ["-Urn", "true"]); } catch { t.skip("no userns here"); return; }
  const py = "import socket,urllib.request;\n" +
    "socket.create_connection(('1.1.1.1',443),timeout=3)\n";
  assert.throws(() => execFileSync("env", ["-i", "PATH=/usr/bin:/bin:/usr/local/bin", "unshare", "-Urn", "python3", "-c", py], { stdio: "pipe" }), /ENETUNREACH|Network is unreachable|ENOENT|Errno 101|Command failed/);
  const url = "import urllib.request;urllib.request.urlopen('https://api.github.com/repos/pallets/flask/pulls/6096',timeout=3)";
  assert.throws(() => execFileSync("env", ["-i", "PATH=/usr/bin:/bin:/usr/local/bin", "unshare", "-Urn", "python3", "-c", url], { stdio: "pipe" }));
});
