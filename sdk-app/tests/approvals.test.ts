import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalStore } from "../src/approvals.js";

const dir = () => mkdtempSync(join(tmpdir(), "appr-"));

test("approval resolves exactly once; decision promise settles", async () => {
  const s = new ApprovalStore(join(dir(), "a.jsonl"));
  const { req, decision } = s.request("github_create_issue", { repo: "o/r", title: "t" }, "github_create_issue(repo=o/r)");
  assert.equal(s.list().length, 1);
  assert.equal(s.resolve(req.id, true, "tester"), true);
  assert.equal(await decision, true);
  assert.equal(s.resolve(req.id, false, "tester"), false, "second resolve must be rejected");
  assert.equal(s.list().length, 0);
});

test("deny settles the decision with false", async () => {
  const s = new ApprovalStore(join(dir(), "a.jsonl"));
  const { req, decision } = s.request("t", {}, "x");
  s.resolve(req.id, false, "tester");
  assert.equal(await decision, false);
});

test("pending approvals resurface from the log after a restart", () => {
  const p = join(dir(), "a.jsonl");
  const s1 = new ApprovalStore(p);
  const { req } = s1.request("t", {}, "summary-x");
  const resolved = s1.request("t2", {}, "summary-y");
  s1.resolve(resolved.req.id, true, "tester");
  const s2 = new ApprovalStore(p); // "restart"
  const list = s2.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, req.id);
  assert.equal(list[0].summary, "summary-x");
  assert.equal(s2.resolve(resolved.req.id, true, "tester"), false, "already-resolved stays resolved across restart");
});
