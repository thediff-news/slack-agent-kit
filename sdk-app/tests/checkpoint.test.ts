import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureCheckpoint, syncCheckpoints } from "../src/checkpoint.js";

const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Fake case clone: base commit + a tracked fix + an untracked test + an evidence image. */
function fixture() {
  const tmp = mkdtempSync(join(tmpdir(), "checkpoint-"));
  const dir = join(tmp, "case");
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "app.js"), "export const x = 1;\n");
  git(dir, "add", ".");
  git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "base");
  writeFileSync(join(dir, "app.js"), "export const x = 2;\n"); // tracked fix
  mkdirSync(join(dir, "test"), { recursive: true });
  writeFileSync(join(dir, "test", "regression.test.js"), "// agent's untracked regression test\n");
  const img = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
  writeFileSync(join(tmp, "shot-1.png"), img);
  const stateDir = join(tmp, "state");
  mkdirSync(stateDir, { recursive: true });
  return { tmp, dir, stateDir, img };
}

test("capture: worktree patch + untracked bytes + evidence bytes + cost, index untouched", async () => {
  const { dir, stateDir, img } = fixture();
  const before = git(dir, "status", "--porcelain");
  const res = await captureCheckpoint({
    stateDir, repo: "o/n", dir, reason: "pre-approval",
    evidenceFiles: [join(dir, "..", "shot-1.png")],
    cost: { cumulative: 9.63, unknownReqIds: ["bp-1"], held: 0.5 },
  });
  assert.equal(res.ok, true, JSON.stringify(res.refused));
  const cp = JSON.parse(readFileSync(res.file!, "utf8"));
  assert.match(cp.patch, /export const x = 2/);
  assert.equal(cp.untracked.length, 1);
  assert.equal(cp.untracked[0].path, "test/regression.test.js");
  assert.equal(cp.untracked[0].sha256, sha256(readFileSync(join(dir, "test", "regression.test.js"))));
  assert.equal(cp.evidence[0].sha256, sha256(img));
  assert.equal(Buffer.from(cp.evidence[0].b64, "base64").compare(img), 0);
  assert.deepEqual(cp.cost.unknownReqIds, ["bp-1"]);
  assert.equal(cp.cost.held, 0.5);
  // the agent's git index was NOT modified (no intent-to-add side effects)
  assert.equal(git(dir, "status", "--porcelain"), before);
  assert.match(git(dir, "status", "--porcelain"), /^\?\? test\/$/m);
});

test("capture: allowlist denies state/env/audit files and skips non-source extensions", async () => {
  const { dir, stateDir } = fixture();
  mkdirSync(join(dir, "state"), { recursive: true });
  writeFileSync(join(dir, "state", "audit.jsonl"), "{}");
  writeFileSync(join(dir, ".env"), "SECRET=1");
  writeFileSync(join(dir, "notes.bin"), Buffer.from([1, 2]));
  const res = await captureCheckpoint({ stateDir, repo: "o/n", dir, reason: "mutation" });
  assert.equal(res.ok, true);
  assert.deepEqual(res.skipped!.sort(), [".env", "notes.bin", "state/audit.jsonl"].sort());
  const cp = JSON.parse(readFileSync(res.file!, "utf8"));
  assert.equal(cp.untracked.length, 1); // only the test file
});

test("capture: REFUSES and writes nothing when a secret-like string enters an allowlisted file", async () => {
  const { dir, stateDir } = fixture();
  writeFileSync(join(dir, "test", "leak.test.js"), "const k = 'ghp_abcdefghijklmnopqrstuvwxyz123456';\n");
  const res = await captureCheckpoint({ stateDir, repo: "o/n", dir, reason: "mutation" });
  assert.equal(res.ok, false);
  assert.match(res.refused!.join(" "), /secret-like content/);
  assert.equal(existsSync(join(stateDir, "checkpoints")), false);
});

test("sync: FAILS CLOSED (ok:false, acked:false) when the remote write fails", async () => {
  const { dir, stateDir } = fixture();
  const res = await captureCheckpoint({ stateDir, repo: "o/n", dir, reason: "pre-restart" });
  assert.equal(res.ok, true);
  const sync = await syncCheckpoints({ stateDir, remote: "file:///nonexistent/should-fail.git", branch: "cp", author: { name: "t", email: "t@t" } });
  assert.equal(sync.ok, false);
  assert.equal(sync.acked, false);
});

test("restore proof: delete scratch, restore from checkpoint remote, exact bytes/hash/cost match", async () => {
  const { tmp, dir, stateDir, img } = fixture();
  const cap = await captureCheckpoint({
    stateDir, repo: "o/n", dir, reason: "pre-restart",
    evidenceFiles: [join(dir, "..", "shot-1.png")],
    cost: { cumulative: 9.63, unknownReqIds: [], held: null },
  });
  assert.equal(cap.ok, true);
  // bare "remote" (local file:// - the test's private remote)
  const remote = join(tmp, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", remote]);
  const sync = await syncCheckpoints({ stateDir, remote, branch: "cp", author: { name: "t", email: "t@t" } });
  assert.equal(sync.ok, true, sync.error);
  assert.equal(sync.acked, true);
  // destroy ALL scratch: the case clone AND the local state
  rmSync(dir, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
  assert.equal(existsSync(dir), false);
  // restore: clone the checkpoint remote, rebuild the worktree
  const restore = join(tmp, "restore");
  execFileSync("git", ["clone", "-q", "-b", "cp", remote, restore]);
  const cpFile = execFileSync("find", [restore, "-name", "*.json"], { encoding: "utf8" }).trim();
  const cp = JSON.parse(readFileSync(cpFile, "utf8"));
  const dir2 = join(tmp, "case2");
  mkdirSync(dir2, { recursive: true });
  git(dir2, "init", "-q", "-b", "main");
  writeFileSync(join(dir2, "app.js"), "export const x = 1;\n");
  git(dir2, "add", ".");
  git(dir2, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "base");
  writeFileSync(join(dir2, "fix.patch"), cp.patch);
  git(dir2, "apply", "fix.patch");
  for (const f of cp.untracked) {
    mkdirSync(join(dir2, f.path, ".."), { recursive: true });
    writeFileSync(join(dir2, f.path), Buffer.from(f.b64, "base64"));
  }
  // EXACT byte/hash verification of restored code + untracked tests + evidence + cost
  assert.equal(readFileSync(join(dir2, "app.js"), "utf8"), "export const x = 2;\n");
  assert.equal(sha256(readFileSync(join(dir2, "test", "regression.test.js"))), cp.untracked[0].sha256);
  assert.equal(sha256(Buffer.from(cp.evidence[0].b64, "base64")), sha256(img));
  assert.ok(cp.cost.cumulative <= 9.64 && cp.cost.cumulative >= 9.63);
});
