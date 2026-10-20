import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/core/store-sqlite.js";

test("pending approvals survive a store restart and late decisions resolve once", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "kit-approval-restart-")), "s.db");
  const first = new SqliteStore(path);
  await first.createApproval({
    id: "approval-1",
    actionKey: "action-1",
    summary: "approve the action",
    requestedBy: "requester",
    requestedAt: new Date().toISOString(),
    status: "pending",
  });
  await first.close();

  // A new store instance represents the restarted runtime. The persisted
  // approval, rather than an in-memory waiter registry, remains authoritative.
  const restarted = new SqliteStore(path);
  assert.deepEqual((await restarted.pendingApprovals()).map((a) => a.id), ["approval-1"]);
  assert.equal(await restarted.resolveApproval("approval-1", "approved", "approver"), true);
  assert.equal((await restarted.getApproval("approval-1"))?.status, "approved");

  // Repeated decisions and unknown IDs must not alter durable state.
  assert.equal(await restarted.resolveApproval("approval-1", "denied", "other-approver"), false);
  assert.equal(await restarted.resolveApproval("unknown-approval", "approved", "approver"), false);
  assert.equal((await restarted.getApproval("approval-1"))?.status, "approved");
  await restarted.close();
});

test("Slack registers an approval waiter before posting its card", () => {
  const source = readFileSync(new URL("../src/adapters/slack.ts", import.meta.url), "utf8");
  const requestStart = source.indexOf("async requestApproval(approval");
  const register = source.indexOf("pending.set(approval.id, resolveDecision)", requestStart);
  const post = source.indexOf("await app.client.chat.postMessage", requestStart);

  assert.notEqual(requestStart, -1, "requestApproval hook exists");
  assert.notEqual(register, -1, "waiter registration exists");
  assert.notEqual(post, -1, "approval card is posted");
  assert.ok(register < post, "a click must find its waiter even before postMessage returns");
});
