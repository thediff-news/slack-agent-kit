import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRagStore } from "../src/rag-store.js";

test("syncDocsRoot indexes text files; retrieve ranks by relevance", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rag-"));
  writeFileSync(join(dir, "a.md"), "# Deploys\nRollback: revert the release PR, redeploy the previous tag.");
  writeFileSync(join(dir, "b.md"), "# Vacation policy\nRequest leave two weeks ahead in the HR portal.");
  const store = openRagStore(join(dir, "r.db"));
  assert.equal(await store.syncDocsRoot(dir), 2);
  assert.ok(store.rag.count() >= 2);
  // the kit's guard requires at least one EXACT shared content token
  const hits = await store.rag.retrieve("revert release PR redeploy", 2);
  assert.ok(hits.length >= 1);
  assert.match(hits[0].source, /a\.md$/, "deploy doc ranks first");
  assert.match(hits[0].text, /revert the release PR/);
  // fuzzy phrasing with no shared token surfaces nothing at the Rag layer -
  // search_docs compensates with its connector-scan fallback (tested there)
  assert.equal((await store.rag.retrieve("how do I roll back a deploy", 2)).length, 0);
  const none = await store.rag.retrieve("quantum entanglement", 2);
  assert.equal(none.length, 0, "shared-token guard blocks pure collisions");
  store.rag.close();
});
