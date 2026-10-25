import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalStore } from "../src/approvals.js";

const dir = () => mkdtempSync(join(tmpdir(), "appr-"));

test("approval resolves exactly once; decision promise settles", async () => {
  const s = new ApprovalStore(join(dir(), "a.jsonl"));
  const { req, decision } = s.request("github_create_issue", { repo: "o/r", title: "t" }, "github_create_issue(repo=o/r)", "thread-1");
  assert.equal(s.list().length, 1);
  assert.equal(s.resolve(req.id, true, "tester", "thread-1"), "resolved");
  assert.equal(await decision, true);
  assert.equal(s.resolve(req.id, false, "tester", "thread-1"), "unknown", "second resolve must be rejected");
  assert.equal(s.list().length, 0);
});

test("deny settles the decision with false", async () => {
  const s = new ApprovalStore(join(dir(), "a.jsonl"));
  const { req, decision } = s.request("t", {}, "x", "thread-1");
  s.resolve(req.id, false, "tester", "thread-1");
  assert.equal(await decision, false);
});

test("pending approvals resurface from the log after a restart", () => {
  const p = join(dir(), "a.jsonl");
  const s1 = new ApprovalStore(p);
  const { req } = s1.request("t", {}, "summary-x", "thread-1");
  const resolved = s1.request("t2", {}, "summary-y", "thread-1");
  s1.resolve(resolved.req.id, true, "tester", "thread-1");
  const s2 = new ApprovalStore(p); // "restart"
  const list = s2.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, req.id);
  assert.equal(list[0].summary, "summary-x");
  assert.equal(s2.resolve(resolved.req.id, true, "tester", "thread-1"), "unknown", "already-resolved stays resolved across restart");
});

test("a resolution from another thread is rejected (thread binding)", async () => {
  const s = new ApprovalStore(join(dir(), "a.jsonl"));
  const { req, decision } = s.request("t", {}, "x", "thread-A");
  assert.equal(s.resolve(req.id, true, "mallory", "thread-B"), "wrong-thread");
  assert.equal(s.list().length, 1, "still pending after cross-thread attempt");
  assert.equal(s.resolve(req.id, true, "alice", "thread-A"), "resolved");
  assert.equal(await decision, true);
});

test("payload hash binds the exact approved input", () => {
  const s = new ApprovalStore(join(dir(), "a.jsonl"));
  const { req } = s.request("t", { a: 1, b: "x" }, "x", "thread-1");
  assert.equal(s.payloadMatches(req.id, { b: "x", a: 1 }), true, "key order irrelevant");
  assert.equal(s.payloadMatches(req.id, { a: 2, b: "x" }), false, "changed payload does not match");
});
