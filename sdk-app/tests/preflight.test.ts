import { test } from "node:test";
import assert from "node:assert/strict";
import { configFromEnv, evalPreflightProblems } from "../src/config.js";

const goodEnv = {
  SDK_APP_EVAL_LOCKDOWN: "1",
  SDK_APP_GITHUB_REPOS: "org/case-repo", SDK_APP_CASE_CHANNEL: "C0CASE",
  SDK_APP_CASE_THREAD: "1700000000.0001", SDK_APP_GITHUB_EXPECTED_USER: "eval-bot",
  SDK_APP_APPROVERS: "U1",
  SDK_APP_USER_ACLS: '{"U1":["operator"]}',
  SDK_APP_DRY_RUN: "0",
  SDK_APP_RBAC_USERS: '{"U1":"operator"}',
  SDK_APP_RBAC_ROLES: '{"operator":["propose","execute","approve"]}',
} as any;

test("eval preflight: complete config yields no problems", () => {
  process.env.SDK_APP_PROXY_CAP_USD = "4.00";
  process.env.SDK_APP_PROXY_STATE = "/tmp/x.json";
  process.env.SDK_APP_CHECKPOINT_REMOTE = "file:///tmp/x-checkpoints.git";
  assert.deepEqual(evalPreflightProblems(configFromEnv(goodEnv)), []);
});

test("eval preflight: every missing critical setting is named", () => {
  delete process.env.SDK_APP_PROXY_CAP_USD;
  delete process.env.SDK_APP_PROXY_STATE;
  delete process.env.SDK_APP_CHECKPOINT_REMOTE;
  const problems = evalPreflightProblems(configFromEnv({ SDK_APP_EVAL_LOCKDOWN: "1" } as any));
  assert.ok(problems.some((p) => p.includes("GITHUB_REPOS")));
  assert.ok(problems.some((p) => p.includes("APPROVERS")));
  assert.ok(problems.some((p) => p.includes("USER_ACLS")));
  assert.ok(problems.some((p) => p.includes("DRY_RUN")));
  assert.ok(problems.some((p) => p.includes("PROXY_CAP_USD")));
  assert.ok(problems.some((p) => p.includes("PROXY_STATE")));
  assert.ok(problems.some((p) => p.includes("RBAC")));
  assert.ok(problems.some((p) => p.includes("CASE_THREAD")));
  assert.ok(problems.some((p) => p.includes("GITHUB_EXPECTED_USER")));
});

test("githubTargetProblems: auth identity, exact repo identity, privacy and push permission", async () => {
  const { githubTargetProblems } = await import("../src/config.js");
  const opts = { expectedUser: "eval-bot", requirePrivate: true, requirePush: true };
  const repoJson = (over: any = {}) => JSON.stringify({ full_name: "o/n", private: true, permissions: { push: true, pull: true }, ...over });
  const mk = (user: { code: number; stdout: string; stderr: string }, repo: { code: number; stdout: string; stderr: string }) =>
    async (args: string[]) => args[1] === "user" ? user : repo;
  const okU = { code: 0, stdout: "eval-bot\n", stderr: "" };
  // clean target: no problems
  assert.deepEqual(await githubTargetProblems(["o/n"], mk(okU, { code: 0, stdout: repoJson(), stderr: "" }), opts), []);
  // auth unreadable
  const noAuth = await githubTargetProblems(["o/n"], mk({ code: 1, stdout: "", stderr: "no token" }, { code: 0, stdout: repoJson(), stderr: "" }), opts);
  assert.match(noAuth.join(" "), /gh auth/);
  // identity mismatch
  const wrongUser = await githubTargetProblems(["o/n"], mk({ code: 0, stdout: "someone-else\n", stderr: "" }, { code: 0, stdout: repoJson(), stderr: "" }), opts);
  assert.match(wrongUser.join(" "), /does not match intended identity/);
  // repo unreadable
  const noRepo = await githubTargetProblems(["o/missing"], mk(okU, { code: 1, stdout: "", stderr: "Not Found" }), opts);
  assert.match(noRepo.join(" "), /o\/missing.*not readable/);
  // public repo
  const pub = await githubTargetProblems(["o/n"], mk(okU, { code: 0, stdout: repoJson({ private: false }), stderr: "" }), opts);
  assert.match(pub.join(" "), /not private/);
  // no push permission
  const noPush = await githubTargetProblems(["o/n"], mk(okU, { code: 0, stdout: repoJson({ permissions: { push: false } }), stderr: "" }), opts);
  assert.match(noPush.join(" "), /lack push/);
  // wrong repo identity (e.g. renamed)
  const renamed = await githubTargetProblems(["o/n"], mk(okU, { code: 0, stdout: repoJson({ full_name: "o/renamed" }), stderr: "" }), opts);
  assert.match(renamed.join(" "), /does not match intended target/);
});

