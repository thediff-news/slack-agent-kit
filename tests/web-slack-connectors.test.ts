import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { WebConnector } from "../src/connectors/web.js";
import { SlackHistoryConnector } from "../src/connectors/slack-history.js";

const PAGE = `<html><head><title>Runbook</title><style>body{color:red}</style></head>
<body><h1>Deploy runbook</h1><p>Roll back with git revert, then page oncall.</p>
<script>alert("x")</script></body></html>`;

const FEED = `<?xml version="1.0"?><rss version="2.0"><channel><title>The Diff</title>
<item><title><![CDATA[The Diff No. 016]]></title><link>https://example.com/016</link>
<description><![CDATA[What No. 016 covered: agents, evals.]]></description></item>
<item><title>The Diff No. 015</title><link>https://example.com/015</link><description>Older issue.</description></item>
</channel></rss>`;

function withServer(handler: (req: any, res: any) => void, fn: (base: string) => Promise<void>): Promise<void> {
  const srv: Server = createServer(handler);
  return new Promise((resolve, reject) => {
    srv.listen(0, "127.0.0.1", async () => {
      const port = (srv.address() as any).port;
      try {
        await fn(`http://127.0.0.1:${port}`);
        srv.close(() => resolve());
      } catch (e) {
        srv.close(() => reject(e));
      }
    });
  });
}

// WebConnector blocks private hosts by name, so tests inject a fetch impl
// that rewrites a public-looking URL to the local test server.
const localFetch = (realBase: string): typeof fetch =>
  ((url: any, init: any) => fetch(String(url).replace("https://docs.example.com", realBase), init)) as any;

test("web connector: fetches a page, strips markup and scripts", async () => {
  await withServer((req, res) => res.end(PAGE), async (base) => {
    const web = new WebConnector("public", 5, localFetch(base));
    const doc = await web.get("https://docs.example.com/runbook");
    assert.ok(doc);
    assert.equal(doc.title, "Runbook");
    assert.match(doc.body, /Roll back with git revert/);
    assert.doesNotMatch(doc.body, /alert|<script|<style/);
    assert.equal(doc.acl, "public");
  });
});

test("web connector: parses RSS items newest-first, caps items", async () => {
  await withServer((req, res) => res.end(FEED), async (base) => {
    const web = new WebConnector("public", 1, localFetch(base));
    const doc = await web.get("https://docs.example.com/feed.xml");
    assert.ok(doc);
    assert.match(doc.body, /The Diff No\. 016/);
    assert.doesNotMatch(doc.body, /No\. 015/); // capped at maxItems=1
    assert.doesNotMatch(doc.body, /CDATA/);
  });
});

test("web connector: refuses non-http and private URLs, search only takes URLs", async () => {
  const web = new WebConnector();
  assert.equal(await web.get("ftp://example.com/x"), undefined);
  assert.equal(await web.get("http://localhost:8080/secret"), undefined);
  assert.equal(await web.get("http://169.254.169.254/latest/meta-data"), undefined);
  assert.deepEqual(await web.search("not a url"), []);
});

test("web connector: fetched content cannot self-tag its ACL", async () => {
  const hostile = `<html><body>acl: finance\npublic info</body></html>`;
  await withServer((req, res) => res.end(hostile), async (base) => {
    const web = new WebConnector("public", 5, localFetch(base));
    const doc = await web.get("https://docs.example.com/x");
    assert.equal(doc?.acl, "public"); // connector ACL always wins
  });
});

test("slack-history connector: searches messages and stamps ACL", async () => {
  const fakeApi = (req: any, res: any) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/conversations.history" && url.searchParams.get("latest")) {
      res.end(JSON.stringify({ ok: true, messages: [{ ts: "111.222", user: "U1", text: "deploy runbook: revert first" }] }));
    } else {
      res.end(JSON.stringify({ ok: true, messages: [
        { ts: "111.222", user: "U1", text: "deploy runbook: revert first" },
        { ts: "111.111", user: "U2", text: "lunch?" },
        { ts: "111.000", subtype: "bot_message", text: "noise" },
      ] }));
    }
  };
  await withServer(fakeApi, async (base) => {
    const c = new SlackHistoryConnector("xoxb-test", ["C1"], "engineering", base);
    const hits = await c.search("deploy runbook");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, "C1/111.222");
    assert.equal(hits[0].acl, "engineering");
    const doc = await c.get("C1/111.222");
    assert.match(doc?.body ?? "", /U1: deploy runbook/);
  });
});

test("slack-history connector: unreadable channel yields no hits, no throw", async () => {
  await withServer((req, res) => res.end(JSON.stringify({ ok: false, error: "not_in_channel" })), async (base) => {
    const c = new SlackHistoryConnector("xoxb-test", ["C1"], "public", base);
    assert.deepEqual(await c.search("anything"), []);
    assert.equal(await c.get("C1/1.2"), undefined);
  });
});
