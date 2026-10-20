import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/core/store-sqlite.js";

test("a persisted pending approval can be decided after restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kit-approval-restart-"));
  const db = join(dir, "store.db");
  const approval = {
    id: "approval-after-restart",
    actionKey: "action-1",
    summary: "approve the action",
    requestedBy: "user-1",
    requestedAt: new Date().toISOString(),
    status: "pending" as const,
  };

  const firstStore = new SqliteStore(db);
  await firstStore.createApproval(approval);
  await firstStore.close();

  const restartedStore = new SqliteStore(db);
  assert.deepEqual(await restartedStore.pendingApprovals(), [approval]);

  // Slack's action handler must resolve the durable record, not require the
  // callback that was held only in the previous process's in-memory Map.
  const slack = readFileSync(new URL("../src/adapters/slack.ts", import.meta.url), "utf8");
  assert.doesNotMatch(slack, /if\s*\(!pending\.has\(id\)\)\s*return;/);
  await restartedStore.close();
});
