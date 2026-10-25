import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { startBudgetProxy, requestBoundUsd, COUNT_TOKENS_MARGIN } from "../scripts/claude-budget-proxy.mjs";

const CFG = { totalUsd: 0.10, model: "claude-sonnet-5-5", maxOutputTokens: 8192, inputRatePerMTok: 2.50, outputRatePerMTok: 10, upstreamBase: "", realKey: "k" };

async function withMockUpstream(fn: (upstreamPort: number, seen: any[]) => Promise<void>) {
  const seen: any[] = [];
  const up = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      seen.push({ url: req.url, body: JSON.parse(b || "{}") });
      if (req.url === "/v1/messages/count_tokens") { res.writeHead(200, { "content-type": "application/json" }); res.end('{"input_tokens": 10000}'); }
      else { res.writeHead(200, { "content-type": "text/event-stream" }); res.end("event: message_start\ndata: {}\n\n"); }
    });
  });
  up.listen(0, "127.0.0.1"); await once(up, "listening");
  try { await fn((up.address() as any).port, seen); } finally { up.close(); }
}

test("bound math: padded input at cache-write rate + capped output", () => {
  const b = requestBoundUsd(10_000, 8192, CFG);
  assert.ok(Math.abs(b - ((2 * 10_000 * COUNT_TOKENS_MARGIN * 2.5) + 8192 * 10) / 1e6) < 1e-12);
});

test("proxy: max_tokens rewritten down, counted, forwarded under cap", async () => {
  await withMockUpstream(async (port, seen) => {
    const proxy = await startBudgetProxy({ ...CFG, totalUsd: 0.5, upstreamBase: `http://127.0.0.1:${port}` });
    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 99999, messages: [{ role: "user", content: "hi" }] }) });
    assert.equal(res.status, 200);
    const msg = seen.find((r) => r.url === "/v1/messages");
    assert.equal(msg.body.max_tokens, 8192, "provider-enforced output ceiling");
    assert.ok(seen.some((r) => r.url === "/v1/messages/count_tokens"), "pre-counted before forwarding");
    assert.ok(proxy.spentBoundUsd() > 0);
    proxy.close();
  });
});

test("proxy: cumulative hard cap rejects without forwarding", async () => {
  await withMockUpstream(async (port, seen) => {
    const proxy = await startBudgetProxy({ ...CFG, upstreamBase: `http://127.0.0.1:${port}` });
    const one = () => fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "claude-sonnet-5-5", messages: [{ role: "user", content: "hi" }] }) });
    // bound per request = (2*10000*1.15*2.5 + 8192*10)/1e6 = 0.1394 > total 0.10 -> the FIRST call must already be refused
    const res = await one();
    assert.equal(res.status, 429);
    assert.equal(seen.filter((r) => r.url === "/v1/messages").length, 0, "never forwarded past cap");
    proxy.close();
  });
});

test("proxy: wrong model and server tools rejected without upstream call", async () => {
  await withMockUpstream(async (port, seen) => {
    const proxy = await startBudgetProxy({ ...CFG, upstreamBase: `http://127.0.0.1:${port}` });
    const r1 = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "claude-opus-5", messages: [] }) });
    assert.equal(r1.status, 403);
    const r2 = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "claude-sonnet-5-5", messages: [], tools: [{ type: "web_search_20250305", name: "web_search" }] }) });
    assert.equal(r2.status, 403);
    assert.equal(seen.filter((r) => r.url === "/v1/messages").length, 0);
    proxy.close();
  });
});
