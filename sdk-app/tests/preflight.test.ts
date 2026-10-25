import { test } from "node:test";
import assert from "node:assert/strict";
import { configFromEnv, evalPreflightProblems } from "../src/config.js";

const goodEnv = {
  SDK_APP_EVAL_LOCKDOWN: "1",
  SDK_APP_GITHUB_REPOS: "org/case-repo",
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
});
