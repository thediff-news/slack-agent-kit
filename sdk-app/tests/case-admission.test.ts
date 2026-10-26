import { test } from "node:test";
import assert from "node:assert/strict";
import { admitEvent } from "../src/case-admission.js";

const cfg = { caseChannel: "C1", caseMarker: "EVAL CASE" };

test("unrelated channels and threads are dropped with zero forwarding", () => {
  const st: { boundThread?: string } = {};
  assert.equal(admitEvent({ channel: "C2", ts: "1", text: "EVAL CASE x" }, cfg, st), "drop"); // wrong channel
  assert.equal(admitEvent({ channel: "C1", ts: "2", text: "hello" }, cfg, st), "drop"); // no marker
  assert.equal(admitEvent({ channel: "C1", ts: "3", thread_ts: "9", text: "EVAL CASE quoted in a reply" }, cfg, st), "drop"); // reply never binds
  assert.deepEqual(st, {}); // nothing bound
});

test("the case message binds its thread; only that thread is admitted afterwards", () => {
  const st: { boundThread?: string } = {};
  assert.equal(admitEvent({ channel: "C1", ts: "100.1", text: "EVAL CASE (uptime-kuma): fix it" }, cfg, st), "bind-and-admit");
  assert.equal(st.boundThread, "100.1");
  assert.equal(admitEvent({ channel: "C1", ts: "101", thread_ts: "100.1", text: "go" }, cfg, st), "admit"); // case reply
  assert.equal(admitEvent({ channel: "C1", ts: "100.1", text: "EVAL CASE (uptime-kuma): fix it" }, cfg, st), "admit"); // the root itself
  assert.equal(admitEvent({ channel: "C1", ts: "200.1", text: "EVAL CASE another case" }, cfg, st), "drop"); // a second case post can never rebind
  assert.equal(admitEvent({ channel: "C1", ts: "102", thread_ts: "999", text: "old thread unread" }, cfg, st), "drop"); // old thread
  assert.equal(admitEvent({ channel: "C2", ts: "103", thread_ts: "100.1", text: "other channel" }, cfg, st), "drop");
});

test("restored binding (daemon restart) admits only the bound thread", () => {
  const st = { boundThread: "100.1" };
  assert.equal(admitEvent({ channel: "C1", ts: "104", thread_ts: "100.1", text: "resume" }, cfg, st), "admit");
  assert.equal(admitEvent({ channel: "C1", ts: "105", text: "EVAL CASE repost" }, cfg, st), "drop");
});

test("no case channel configured: open surface (non-eval behavior unchanged)", () => {
  assert.equal(admitEvent({ channel: "C9", ts: "1", text: "hi" }, { caseChannel: "", caseMarker: "" }, {}), "admit");
});
