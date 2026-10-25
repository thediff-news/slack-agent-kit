import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { startBudgetProxy, extractUsage, settledCostUsd } from "../budget-proxy.mjs";

type Mode = "json" | "sse" | "nousage" | "huge";
async function mockUpstream(mode: Mode = "json"): Promise<{ port: number; close: () => void }> {
  const server = http.createServer((req, res) => {
    if (req.url === "/v1/messages/count_tokens") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ input_tokens: 1000 }));
      return;
    }
    if (mode === "sse") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        "event: message_start\ndata: " + JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 2000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } } }) + "\n\n" +
        "event: message_delta\ndata: " + JSON.stringify({ type: "message_delta", usage: { output_tokens: 500 } }) + "\n\n"
      );
      return;
    }
    if (mode === "nousage") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "msg_1" }));
      return;
    }
    if (mode === "huge") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "msg_1", usage: { input_tokens: 100000, output_tokens: 4096 } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "msg_1", usage: { input_tokens: 1000, output_tokens: 10 } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { port: (server.address() as any).port, close: () => server.close() };
}

const cfg = (port: number, extra: any = {}) => ({
  totalUsd: 1.0, model: "claude-sonnet-5-5", maxOutputTokens: 4096,
  inputRatePerMTok: 2.5, outputRatePerMTok: 10,
  upstreamBase: `http://127.0.0.1:${port}`, realKey: "test-key",
  ...extra,
});

const post = (port: number, path: string, body: any) =>
  new Promise<{ status: number; body: string }>((res, rej) => {
    const r = http.request({ host: "127.0.0.1", port, path, method: "POST" }, (resp) => {
      let d = ""; resp.on("data", (c) => (d += c)); resp.on("end", () => res({ status: resp.statusCode ?? 0, body: d }));
    });
    r.on("error", rej); r.end(JSON.stringify(body));
  });

const settle = () => new Promise((r) => setTimeout(r, 50));
// reservation bound for the shared mock: 1000 counted input *2 (count billed
// twice) *1.15 padding *2.5/M + 4096 max output *10/M
const perReq = (2 * 1000 * 1.15 * 2.5 + 4096 * 10) / 1e6; // = 0.04671
const msg = { model: "claude-sonnet-5-5", messages: [{ role: "user", content: "hi" }], max_tokens: 4096 };

test("budget proxy: durable ledger survives restart and basis counts against the cap", async () => {
  const up = await mockUpstream();
  const dir = mkdtempSync(join(tmpdir(), "proxy-"));
  const statePath = join(dir, "ledger.json");

  const p1 = await startBudgetProxy(cfg(up.port, { statePath, basisUsd: 0.40 }));
  const r1 = await post(p1.port, "/v1/messages", msg);
  assert.equal(r1.status, 200);
  await settle();
  // settled to measured usage: 2*1000 in *2.5/M + 10 out *10/M = 0.0051
  const settled1 = settledCostUsd({ input: 1000, output: 10 }, cfg(up.port));
  const spent1 = p1.spentBoundUsd();
  assert.ok(Math.abs(spent1 - (0.40 + settled1)) < 1e-9, `spent ${spent1}`);
  p1.close();

  // ledger file exists and holds the settled cumulative
  const ledger = JSON.parse(readFileSync(statePath, "utf8"));
  assert.ok(Math.abs(ledger.cumulative - settled1) < 1e-9, `ledger ${ledger.cumulative}`);

  // "restart": new proxy, same state path -> cumulative reloads, basis still applies
  const p2 = await startBudgetProxy(cfg(up.port, { statePath, basisUsd: 0.40 }));
  assert.ok(Math.abs(p2.spentBoundUsd() - (0.40 + settled1)) < 1e-9, "reloaded ledger + basis");

  // cap enforcement across the restart: cap 0.45 with basis 0.40 + ledger ~0.0051
  // -> the next request's full reservation (0.0467) 429s locally
  const p3 = await startBudgetProxy(cfg(up.port, { statePath, basisUsd: 0.40, totalUsd: 0.45 }));
  const r3 = await post(p3.port, "/v1/messages", msg);
  assert.equal(r3.status, 429);
  assert.match(r3.body, /budget_exceeded/);
  p2.close(); p3.close(); up.close();
});

test("budget proxy: reservation settles down to measured usage from an SSE stream", async () => {
  const up = await mockUpstream("sse");
  const p = await startBudgetProxy(cfg(up.port));
  const r = await post(p.port, "/v1/messages", msg);
  assert.equal(r.status, 200);
  assert.match(r.body, /message_start/, "stream passes through untouched");
  await settle();
  // measured: 2*2000 in *2.5/M + 500 out *10/M = 0.015, well under the 0.0467 reservation
  const settledUsd = settledCostUsd({ input: 2000, output: 500 }, cfg(up.port));
  assert.ok(Math.abs(p.spentBoundUsd() - settledUsd) < 1e-9, `spent ${p.spentBoundUsd()} want ${settledUsd}`);
  p.close(); up.close();
});

test("budget proxy: response without usage keeps the full reservation", async () => {
  const up = await mockUpstream("nousage");
  const p = await startBudgetProxy(cfg(up.port));
  const r = await post(p.port, "/v1/messages", msg);
  assert.equal(r.status, 200);
  await settle();
  assert.ok(Math.abs(p.spentBoundUsd() - perReq) < 1e-9, `spent ${p.spentBoundUsd()} want full bound ${perReq}`);
  p.close(); up.close();
});

test("budget proxy: settlement never raises the ledger above the reservation", async () => {
  const up = await mockUpstream("huge"); // measured cost (0.54) exceeds the reservation
  const p = await startBudgetProxy(cfg(up.port));
  const r = await post(p.port, "/v1/messages", msg);
  assert.equal(r.status, 200);
  await settle();
  assert.ok(Math.abs(p.spentBoundUsd() - perReq) < 1e-9, `spent ${p.spentBoundUsd()} want clamped ${perReq}`);
  p.close(); up.close();
});

test("extractUsage: SSE, plain JSON, cache classes, and garbage", () => {
  const sse = "event: message_start\ndata: " + JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 100, cache_creation_input_tokens: 40, cache_read_input_tokens: 60, output_tokens: 1 } } }) +
    "\n\nevent: message_delta\ndata: " + JSON.stringify({ type: "message_delta", usage: { output_tokens: 42 } }) + "\n\n";
  assert.deepEqual(extractUsage(sse), { input: 200, output: 42 });
  assert.deepEqual(extractUsage(JSON.stringify({ usage: { input_tokens: 5, output_tokens: 7 } })), { input: 5, output: 7 });
  assert.equal(extractUsage("not json at all"), null);
  assert.equal(extractUsage(JSON.stringify({ id: "x" })), null);
});
