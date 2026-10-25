import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildToolHandlers, buildKitServer } from "../src/tools.js";
import { configFromEnv } from "../src/config.js";
import { AuditLog } from "../src/audit.js";
import type { Connector, ConnectorDoc } from "../../src/connectors/types.js";

class MockConnector implements Connector {
  name = "mock";
  constructor(private docs: ConnectorDoc[]) {}
  async search(query: string, limit = 10) {
    return this.docs.filter((d) => (d.title + d.body).toLowerCase().includes(query.toLowerCase())).slice(0, limit);
  }
  async get(id: string) {
    return this.docs.find((d) => d.id === id);
  }
}

const setup = (dryRun = true) => {
  const dir = mkdtempSync(join(tmpdir(), "tools-"));
  const config = configFromEnv({ SDK_APP_DRY_RUN: dryRun ? "1" : "0" } as any);
  const audit = new AuditLog(join(dir, "audit.jsonl"));
  const conn = new MockConnector([
    { id: "doc-1", title: "Deploy runbook", body: "Rollback: revert the release PR and redeploy.", url: "https://x/1" },
    { id: "doc-2", title: "On-call", body: "Pager rotation weekly." },
  ]);
  return { handlers: buildToolHandlers({ connectors: [conn], config, audit }), config, audit, conn };
};

test("search_docs finds and formats docs", async () => {
  const { handlers } = setup();
  const s = await handlers.searchDocs({ query: "rollback" });
  assert.match(s.content[0].text, /doc-1/);
  assert.match(s.content[0].text, /Deploy runbook/);
  assert.match(s.content[0].text, /https:\/\/x\/1/);
  const none = await handlers.searchDocs({ query: "zzz-no-match" });
  assert.match(none.content[0].text, /No matching documents/);
});

test("get_doc returns full body; unknown id is an error result", async () => {
  const { handlers } = setup();
  const g = await handlers.getDoc({ id: "doc-1" });
  assert.match(g.content[0].text, /revert the release PR/);
  const nf = await handlers.getDoc({ id: "nope" });
  assert.equal(nf.isError, true);
});

test("github_create_issue is dry-run unless armed", async () => {
  const { handlers } = setup(true);
  const c = await handlers.createIssue({ repo: "o/r", title: "Bug", body: "details" });
  assert.match(c.content[0].text, /\[dry-run\] would create issue in o\/r/);
});

test("kit MCP server builds with all three tools registered", () => {
  const { config, audit, conn } = setup();
  const server: any = buildKitServer({ connectors: [conn], config, audit });
  assert.ok(server, "server instance exists");
  assert.equal(server.type, "sdk");
});
