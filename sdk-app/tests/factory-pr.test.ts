import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FactoryTools } from "../src/factory-tools.js";
import { configFromEnv } from "../src/config.js";
import { AuditLog } from "../src/audit.js";

const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });

/** Build a fake clone dir (owner/name) with a recorded factory base. */
function fixtureClone(withStateFile: boolean) {
  const tmp = mkdtempSync(join(tmpdir(), "factory-pr-"));
  const config = configFromEnv({ SDK_APP_AUDIT_LOG: join(tmp, "state", "audit.jsonl"), SDK_APP_APPROVALS_LOG: join(tmp, "state", "approvals.jsonl") } as any);
  const tools = new FactoryTools({ config, audit: new AuditLog(join(tmp, "state", "audit.jsonl")) });
  const dir = join(tmp, "state", "factory-clones", "owner_name");
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base");
  const base = git(dir, "rev-parse", "HEAD").trim();
  writeFileSync(join(dir, ".git", "factory-base"), base + "\n");
  git(dir, "checkout", "-q", "-B", "factory/sdk-test");
  // the fix: committed already (the reviewer-driven flow that used to break)
  writeFileSync(join(dir, "fix.ts"), "export const fix = 1;\n");
  git(dir, "add", "--", "fix.ts");
  git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "the fix");
  if (withStateFile) {
    mkdirSync(join(dir, "sdk-app", "state"), { recursive: true });
    writeFileSync(join(dir, "sdk-app", "state", "sessions.json"), '{"t":"s"}\n');
  }
  return { tools, dir, base };
}

test("createPr: committed-but-unpushed work is a real PR, not 'nothing to do'", async () => {
  const { tools } = fixtureClone(false);
  await tools.__seedWorkflowForTests("owner/name");
  const out = await tools.createPr("owner/name", "t", "b"); // dry-run default
  assert.doesNotMatch(out, /nothing to do/);
  assert.match(out, /would push factory\/sdk-test and open a PR/);
  assert.match(out, /fix\.ts/);
  assert.match(out, /DIFF HASH: [0-9a-f]{12}/);
});

test("createPr: app state files never enter the PR and are named as excluded", async () => {
  const { tools } = fixtureClone(true);
  await tools.__seedWorkflowForTests("owner/name");
  const out = await tools.createPr("owner/name", "t", "b");
  assert.match(out, /EXCLUDED \(never auto-PR'd state\): sdk-app\/state\/sessions\.json/);
  assert.doesNotMatch(out.split("EXCLUDED")[0], /sessions\.json/); // not in the stat
});

test("createPr: approval binds the exact diff - a changed branch invalidates it", async () => {
  const { tools, dir } = fixtureClone(false);
  const fp = await tools.prFingerprint("owner/name", "t", "b");
  // note: prFingerprint itself needs no workflow evidence
  assert.match(fp, /^[0-9a-f]{64}$/);
  writeFileSync(join(dir, "fix.ts"), "export const fix = 2;\n"); // branch changes after approval
  await tools.__seedWorkflowForTests("owner/name"); // fresh evidence on the changed tree
  const refused = await tools.createPr("owner/name", "t", "b");
  assert.match(refused, /REFUSED: the branch changed after approval/);
  // unchanged branch passes the binding and returns the plan
  await tools.prFingerprint("owner/name", "t", "b");
  await tools.__seedWorkflowForTests("owner/name");
  const ok = await tools.createPr("owner/name", "t", "b");
  assert.match(ok, /DIFF HASH/);
});

test("factory_run allowlist: exact path-scoped index hygiene, no blanket destructive git", async () => {
  const { tools } = fixtureClone(false);
  assert.match(await tools.runChecks("owner/name", "git rm --cached -f -- sdk-app/state/sessions.json"), /rm|fatal|did not match/i);
  assert.match(await tools.runChecks("owner/name", "git restore --staged -- fix.ts"), /./);
  assert.match(await tools.runChecks("owner/name", "git reset -q -- fix.ts"), /./);
  for (const bad of ["git reset --hard", "git checkout -- fix.ts", "git add -A", "git add .", "git clean -fd"]) {
    assert.match(await tools.runChecks("owner/name", bad), /^BLOCKED/, bad);
  }
  assert.match(await tools.runChecks("owner/name", "git add -- fix.ts"), /./); // path-scoped add fine
});
