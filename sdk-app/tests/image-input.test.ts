import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrompt } from "../src/agent.js";
import { fetchSlackImages } from "../src/slack.js";

const png = Buffer.from("89504e470d0a1a0a", "hex");
const okFetch = (async () => new Response(png, { status: 200, headers: { "content-type": "image/png" } })) as typeof fetch;

test("buildPrompt: no images stays a plain string", () => {
  assert.equal(buildPrompt("hi"), "hi");
});

test("buildPrompt: images become real image content blocks the model can see", async () => {
  const p = buildPrompt("what is in this?", [{ mediaType: "image/png", data: png.toString("base64"), name: "a.png" }]);
  assert.notEqual(typeof p, "string");
  const msgs: any[] = [];
  for await (const m of p as AsyncIterable<any>) msgs.push(m);
  assert.equal(msgs.length, 1);
  const c = msgs[0].message.content;
  assert.equal(c[0].type, "image");
  assert.equal(c[0].source.type, "base64");
  assert.equal(c[0].source.media_type, "image/png");
  assert.equal(c[0].source.data, png.toString("base64"));
  assert.equal(c[1].text, "what is in this?");
});

test("fetchSlackImages: accepts images from files.slack.com, sends the token only there", async () => {
  const seen: string[] = [];
  const f = (async (u: any, init: any) => { seen.push(`${u}|${init.headers.Authorization}`); return okFetch(u, init); }) as typeof fetch;
  const r = await fetchSlackImages([{ name: "s.png", mimetype: "image/png", size: 8, url_private: "https://files.slack.com/files-pri/T-F/s.png" }], "xoxb-test", f);
  assert.equal(r.images.length, 1);
  assert.equal(r.images[0].mediaType, "image/png");
  assert.deepEqual(seen, ["https://files.slack.com/files-pri/T-F/s.png|Bearer xoxb-test"]);
});

test("fetchSlackImages: refuses other hosts, non-images, oversize, and HTML (missing scope) responses", async () => {
  let calls = 0;
  const html = (async () => { calls++; return new Response("<html>", { status: 403, headers: { "content-type": "text/html" } }); }) as typeof fetch;
  const r = await fetchSlackImages([
    { name: "evil.png", mimetype: "image/png", size: 8, url_private: "https://evil.example/x.png" },
    { name: "doc.pdf", mimetype: "application/pdf", size: 8, url_private: "https://files.slack.com/a.pdf" },
    { name: "big.png", mimetype: "image/png", size: 9_000_000, url_private: "https://files.slack.com/big.png" },
    { name: "noscope.png", mimetype: "image/png", size: 8, url_private: "https://files.slack.com/n.png" },
  ], "xoxb-test", html);
  assert.equal(r.images.length, 0);
  assert.equal(calls, 1, "only the in-scope candidate was fetched, and the token never left files.slack.com");
  assert.match(r.skipped.join("|"), /unexpected file host/);
  assert.match(r.skipped.join("|"), /not an image/);
  assert.match(r.skipped.join("|"), /larger than 5 MB/);
  assert.match(r.skipped.join("|"), /missing files:read/);
});
