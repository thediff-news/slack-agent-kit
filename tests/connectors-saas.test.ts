/**
 * Jira / Confluence / Notion connectors, tested against mocked HTTP only.
 * No live tenant is touched: global fetch is replaced with canned responses
 * shaped like the real API payloads, and assertions cover endpoints, auth
 * headers, pagination, and document mapping. Live behavior is unverified.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JiraConnector } from "../src/connectors/jira.js";
import { ConfluenceConnector } from "../src/connectors/confluence.js";
import { NotionConnector } from "../src/connectors/notion.js";
import { buildRuntime } from "../src/kit.js";
import { KnowledgeSkill } from "../src/skills/knowledge.js";
import { cliEvent } from "../src/adapters/cli.js";
import { SqliteStore } from "../src/core/store-sqlite.js";
import { AuditLog } from "../src/core/audit.js";
import { Rag } from "../src/rag/rag.js";
import { HashingEmbedder } from "../src/rag/embed.js";

type Call = { url: string; init?: RequestInit };
let calls: Call[] = [];
const realFetch = globalThis.fetch;

/** Install a fetch mock. `routes` matches on substring of the URL, in order. */
function mockFetch(routes: [string, unknown][]) {
  calls = [];
  globalThis.fetch = (async (url: any, init?: any) => {
    calls.push({ url: String(url), init });
    const hit = routes.find(([m]) => String(url).includes(m));
    if (!hit) return new Response("nope", { status: 404 });
    return new Response(JSON.stringify(hit[1]), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

beforeEach(() => { calls = []; });
afterEach(() => { globalThis.fetch = realFetch; });

const JIRA_ISSUE = {
  key: "PROJ-123",
  fields: {
    summary: "Checkout 500s on guest carts",
    status: { name: "Open" },
    priority: { name: "High" },
    issuetype: { name: "Bug" },
    updated: "2026-10-17T09:00:00.000+0000",
    description: {
      type: "doc", version: 1,
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Guests get a 500 at payment." }] },
        { type: "paragraph", content: [{ type: "text", text: "Started after the 2.4 deploy." }] },
      ],
    },
  },
};

test("jira: JQL search hits /rest/api/3/search/jql with basic auth, maps docs, paginates", async () => {
  mockFetch([
    ["search/jql", {}], // replaced per-call below
  ]);
  let n = 0;
  globalThis.fetch = (async (url: any, init?: any) => {
    calls.push({ url: String(url), init });
    n++;
    const body = n === 1
      ? { issues: [JIRA_ISSUE], isLast: false, nextPageToken: "tok2" }
      : { issues: [{ ...JIRA_ISSUE, key: "PROJ-124" }], isLast: true };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;

  const jira = new JiraConnector("https://acme.atlassian.net/", "bot@acme.com", "token-abc", "eng");
  const docs = await jira.search("checkout 500", 5);

  assert.equal(docs.length, 2);
  assert.equal(docs[0].id, "PROJ-123");
  assert.match(docs[0].title, /Checkout 500s/);
  assert.match(docs[0].body, /Guests get a 500 at payment\./);
  assert.match(docs[0].body, /Started after the 2\.4 deploy\./);
  assert.equal(docs[0].url, "https://acme.atlassian.net/browse/PROJ-123");
  assert.equal(docs[0].acl, "eng");

  assert.ok(calls[0].url.startsWith("https://acme.atlassian.net/rest/api/3/search/jql?"));
  assert.match(calls[0].url, /jql=text/);
  assert.match(calls[1].url, /nextPageToken=tok2/);
  const auth = (calls[0].init?.headers as Record<string, string>).Authorization;
  assert.equal(auth, "Basic " + Buffer.from("bot@acme.com:token-abc").toString("base64"));
});

test("jira: get fetches the issue resource; raw jql: prefix is passed through; 403 yields empty", async () => {
  mockFetch([["/rest/api/3/issue/PROJ-123", JIRA_ISSUE]]);
  const jira = new JiraConnector("https://acme.atlassian.net", "bot@acme.com", "token-abc");
  const doc = await jira.get("proj-123");
  assert.equal(doc?.id, "PROJ-123");
  assert.match(doc?.body ?? "", /Status: Open \| Priority: High/);

  await jira.search("jql: project = PROJ AND status = Open", 1);
  assert.match(calls[1].url, /jql=project/);

  globalThis.fetch = (async () => new Response("forbidden", { status: 403 })) as typeof fetch;
  assert.deepEqual(await jira.search("anything"), []);
  assert.equal(await jira.get("PROJ-999"), undefined);
});

test("confluence: CQL search hits /wiki/rest/api/content/search, strips storage XHTML, builds webui urls", async () => {
  mockFetch([
    ["content/search", {
      results: [{
        id: "98765", type: "page", title: "Refund policy",
        body: { storage: { value: "<h1>Refunds</h1><p>Duplicate charges are refunded in <strong>full</strong>.</p><ul><li>Within 5 days</li></ul>" } },
        _links: { webui: "/spaces/FIN/pages/98765/Refund+policy" },
      }],
      start: 0, limit: 25, size: 1, _links: {},
    }],
    ["content/98765", {
      id: "98765", title: "Refund policy",
      body: { storage: { value: "<p>Full body here.</p>" } },
      _links: { webui: "/spaces/FIN/pages/98765/Refund+policy" },
    }],
  ]);
  const conf = new ConfluenceConnector("https://acme.atlassian.net", "bot@acme.com", "token-abc", "finance");
  const docs = await conf.search("refund", 5);
  assert.equal(docs.length, 1);
  assert.equal(docs[0].id, "98765");
  assert.match(docs[0].body, /Duplicate charges are refunded in full\./);
  assert.match(docs[0].body, /Within 5 days/);
  assert.ok(!docs[0].body.includes("<strong>"));
  assert.equal(docs[0].url, "https://acme.atlassian.net/wiki/spaces/FIN/pages/98765/Refund+policy");
  assert.equal(docs[0].acl, "finance");
  assert.ok(calls[0].url.startsWith("https://acme.atlassian.net/wiki/rest/api/content/search?"));
  assert.match(calls[0].url, /cql=/);
  assert.match(calls[0].url, /expand=body\.storage/);

  const page = await conf.get("98765");
  assert.match(page?.body ?? "", /Full body here\./);
});

test("notion: search posts to /v1/search with bearer + version headers; get reads page + block children with pagination", async () => {
  const page = {
    id: "abc-123", url: "https://www.notion.so/Runbook-abc123",
    properties: { Name: { type: "title", title: [{ plain_text: "Incident runbook" }] } },
  };
  let blockPage = 0;
  globalThis.fetch = (async (url: any, init?: any) => {
    calls.push({ url: String(url), init });
    const u = String(url);
    if (u.endsWith("/search")) {
      return new Response(JSON.stringify({ object: "list", results: [page], has_more: false, next_cursor: null }), { status: 200 });
    }
    if (u.includes("/blocks/")) {
      blockPage++;
      const results = blockPage === 1
        ? [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "Revert first." }] } }]
        : [{ type: "to_do", to_do: { checked: true, rich_text: [{ plain_text: "Then fix in a PR." }] } }];
      return new Response(JSON.stringify({
        object: "list", results,
        has_more: blockPage === 1, next_cursor: blockPage === 1 ? "cursor-2" : null,
      }), { status: 200 });
    }
    if (u.includes("/pages/")) return new Response(JSON.stringify(page), { status: 200 });
    return new Response("nope", { status: 404 });
  }) as typeof fetch;

  const notion = new NotionConnector("secret_notion_token", "ops");
  const docs = await notion.search("runbook", 5);
  assert.equal(docs.length, 1);
  assert.equal(docs[0].title, "Incident runbook");
  assert.equal(docs[0].acl, "ops");

  const searchCall = calls[0];
  assert.equal(searchCall.init?.method, "POST");
  const headers = searchCall.init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer secret_notion_token");
  assert.ok(headers["Notion-Version"]);
  assert.match(String(searchCall.init?.body), /"value":"page"/);

  const doc = await notion.get("abc-123");
  assert.equal(doc?.title, "Incident runbook");
  assert.match(doc?.body ?? "", /Revert first\./);
  assert.match(doc?.body ?? "", /\[x\] Then fix in a PR\./);
  assert.match(calls[calls.length - 1].url, /start_cursor=cursor-2/);
});

test("kit wiring: missing SaaS credentials disable the connector without failing; keyless config unaffected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kit-saas-"));
  const configPath = join(dir, "kit.config.yaml");
  writeFileSync(configPath, `
store: { driver: sqlite, path: ${join(dir, "k.db")} }
auditLogPath: ${join(dir, "a.jsonl")}
rag: { dbPath: ${join(dir, "r.db")}, dimensions: 128 }
connectors:
  jira: { type: jira, site: https://acme.atlassian.net, acl: eng }
  notion: { type: notion, acl: ops }
permissions: { users: {}, approvers: [], channels: {}, roleAcls: {} }
approval: { timeoutMinutes: 60 }
skills: {}
`);
  const env = { ...process.env };
  delete process.env.ATLASSIAN_SITE; delete process.env.ATLASSIAN_EMAIL; delete process.env.ATLASSIAN_API_TOKEN; delete process.env.NOTION_API_KEY;
  try {
    const kit = await buildRuntime(configPath, { notify: async () => {}, requestApproval: async () => "denied" });
    assert.equal(kit.connectors["jira"], undefined);
    assert.equal(kit.connectors["notion"], undefined);
    kit.store.close();
  } finally {
    Object.assign(process.env, env);
  }
});

test("rag wiring: ingest jira:<key> through company-brain tags chunks with the connector default ACL", async () => {
  mockFetch([["/rest/api/3/issue/PROJ-123", JIRA_ISSUE]]);
  const dir = mkdtempSync(join(tmpdir(), "kit-ing-"));
  const rag = new Rag(join(dir, "r.db"), new HashingEmbedder(256));
  const ctx: any = {
    store: new SqliteStore(join(dir, "s.db")),
    audit: new AuditLog(join(dir, "a.jsonl")),
    rag,
    connectors: { jira: new JiraConnector("https://acme.atlassian.net", "bot@acme.com", "token-abc", "eng") },
    config: {},
    reply: async () => {},
    enrich: async () => "",
    aclsFor: () => ["public", "eng"],
  };
  const skill = new KnowledgeSkill();
  const result = await skill.handle(cliEvent("ingest jira:PROJ-123"), ctx);
  assert.equal(result.actions.length, 1);
  assert.match(result.findings, /ACL `eng`/);
  await result.actions[0].run();
  // retrievable with the eng ACL, invisible without it
  const hits = await rag.retrieve("checkout 500 guests payment", 3, ["public", "eng"]);
  assert.ok(hits.some((h) => h.source === "PROJ-123"));
  assert.equal(hits[0].acl, "eng");
  const publicOnly = await rag.retrieve("checkout 500 guests payment", 3, ["public"]);
  assert.equal(publicOnly.length, 0);
  ctx.store.close();
  rag.close();
});

test("confluence: storage XHTML named entities are decoded (live bug: &ldquo; reached Slack as &amp;ldquo;)", async () => {
  mockFetch([
    ["content/458753", {
      id: "458753", title: "Runbook",
      body: { storage: { value: "<p>RuntimeError(&ldquo;deque mutated during iteration&rdquo;) &mdash; retry &amp;#39;safe&#39;</p>" } },
      _links: { webui: "/spaces/X/pages/458753/Runbook" },
    }],
  ]);
  const conf = new ConfluenceConnector("https://acme.atlassian.net", "bot@acme.com", "token-abc", "public");
  const page = await conf.get("458753");
  // Real named entities decode to actual characters...
  assert.match(page?.body ?? "", /RuntimeError\("deque mutated during iteration"\) -- retry/);
  // ...while "&amp;#39;" is a single-escaped entity: decodes once to "&#39;", never to a raw quote.
  assert.ok((page?.body ?? "").includes("&#39;"));
  assert.ok(!(page?.body ?? "").includes("&ldquo;"));
  assert.ok(!(page?.body ?? "").includes("&amp;"));
});

test("jira: sync list uses updated-since JQL and surfaces lastModified", async () => {
  mockFetch([
    ["search/jql", { issues: [JIRA_ISSUE], isLast: true }],
  ]);
  const jira = new JiraConnector("https://acme.atlassian.net", "bot@acme.com", "token-abc", "finance");
  const full = await jira.list();
  assert.equal(full.complete, true);
  assert.equal(full.docs[0].id, "PROJ-123");
  assert.equal(full.docs[0].lastModified, "2026-10-17T09:00:00.000+0000");
  assert.match(decodeURIComponent(calls[0].url).replace(/\+/g, ' '), /jql=ORDER BY updated DESC/);

  const inc = await jira.list("2026-10-18T00:00:00.000Z");
  assert.equal(inc.complete, false); // incremental listings never reconcile deletions
  assert.match(decodeURIComponent(calls[1].url).replace(/\+/g, ' '), /jql=updated >= "2026\/10\/18 00:00" ORDER BY updated DESC/);
});

test("confluence: sync list uses lastmodified-since CQL and version.when as lastModified", async () => {
  mockFetch([
    ["content/search", {
      results: [{
        id: "458753", type: "page", title: "Runbook",
        version: { when: "2026-10-19T19:00:00.000Z" },
        body: { storage: { value: "<p>Runbook body.</p>" } },
        _links: { webui: "/spaces/X/pages/458753/Runbook" },
      }],
      start: 0, limit: 25, size: 1, _links: {},
    }],
  ]);
  const conf = new ConfluenceConnector("https://acme.atlassian.net", "bot@acme.com", "token-abc", "public");
  const full = await conf.list();
  assert.equal(full.complete, true);
  assert.equal(full.docs[0].lastModified, "2026-10-19T19:00:00.000Z");
  assert.match(decodeURIComponent(calls[0].url).replace(/\+/g, ' '), /cql=type = page ORDER BY lastmodified DESC/);

  const inc = await conf.list("2026-10-18T12:00:00.000Z");
  assert.equal(inc.complete, false);
  assert.match(decodeURIComponent(calls[1].url).replace(/\+/g, ' '), /lastmodified >= "2026-10-18 12:00"/);
});

test("notion: sync list sorts by last_edited_time, stops at the cursor, carries lastModified", async () => {
  mockFetch([
    ["/search", {
      results: [
        { id: "p1", object: "page", url: "https://notion.so/p1", last_edited_time: "2026-10-19T10:00:00.000Z",
          properties: { title: { type: "title", title: [{ plain_text: "Newer page" }] } } },
        { id: "p2", object: "page", url: "https://notion.so/p2", last_edited_time: "2026-10-18T10:00:00.000Z",
          properties: { title: { type: "title", title: [{ plain_text: "Older page" }] } } },
      ],
      has_more: false, next_cursor: null,
    }],
    ["blocks/p1/children", { results: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "p1 body" }] } }], has_more: false }],
    ["blocks/p2/children", { results: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "p2 body" }] } }], has_more: false }],
  ]);
  const notion = new NotionConnector("ntn_test", "public");

  const full = await notion.list();
  assert.equal(full.complete, true);
  assert.deepEqual(full.docs.map((d) => d.id), ["p1", "p2"]);
  assert.equal(full.docs[0].body, "p1 body");
  assert.equal(full.docs[0].lastModified, "2026-10-19T10:00:00.000Z");
  const searchBody = JSON.parse(String(calls.find((c) => c.url.includes("/search"))!.init!.body));
  assert.deepEqual(searchBody.sort, { direction: "descending", timestamp: "last_edited_time" });

  const inc = await notion.list("2026-10-19T00:00:00.000Z");
  assert.deepEqual(inc.docs.map((d) => d.id), ["p1"]); // p2 older than cursor, pagination stops
  assert.equal(inc.complete, false);
});
