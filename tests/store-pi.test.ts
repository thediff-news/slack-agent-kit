import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiDurableStore } from "../src/core/store-pi.js";

test("pi-durable store: dedup, one-decision approvals, execution idempotency, crash resume", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "kit-pi-")), "state.sqlite");
  let s = await PiDurableStore.open(path);
  assert.equal(await s.recordEvent("e1", "slack", "alert", "u1", "x"), "new");
  assert.equal(await s.recordEvent("e1", "slack", "alert", "u1", "x"), "duplicate");
  await s.createApproval({ id: "a1", actionKey: "k1", summary: "rotate key", requestedBy: "u1", requestedAt: new Date().toISOString(), status: "pending" });
  assert.equal((await s.pendingApprovals()).length, 1);

  // crash: close and reopen - the pending approval must still be there
  await s.close();
  s = await PiDurableStore.open(path);
  assert.equal((await s.pendingApprovals()).length, 1);
  assert.equal(await s.recordEvent("e1", "slack", "alert", "u1", "x"), "duplicate"); // survived reopen

  assert.equal(await s.resolveApproval("a1", "approved", "boss"), true);
  assert.equal(await s.resolveApproval("a1", "denied", "other"), false);
  assert.equal(await s.hasExecuted("k1"), false);
  await s.markExecuted("k1", "done");
  assert.equal(await s.hasExecuted("k1"), true);
  await s.set("skill", "k", "v");
  assert.equal(await s.get("skill", "k"), "v");
  await s.close();
});
