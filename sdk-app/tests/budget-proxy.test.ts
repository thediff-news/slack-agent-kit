import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { startBudgetProxy } from "../budget-proxy.mjs";

async function mockUpstream(): Promise<{ port: number; close: () => void }> {
  const server = http.createServer((req, res) => {
    if (req.url === "/v1/messages/count_tokens") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ input_tokens: 1000 }));
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

test("budget proxy: durable ledger survives restart and basis counts against the cap", async () => {
  const up = await mockUpstream();
  const dir = mkdtempSync(join(tmpdir(), "proxy-"));
  const statePath = join(dir, "ledger.json");
  const msg = { model: "claude-sonnet-5-5", messages: [{ role: "user", content: "hi" }], max_tokens: 4096 };

  // one gated request: 1000 input *2 (count billed twice) *1.15 *2.5/M + 4096*10/M
  const perReq = (2 * 1000 * 1.15 * 2.5 + 4096 * 10) / 1e6; // = 0.04671

  const p1 = await startBudgetProxy(cfg(up.port, { statePath, basisUsd: 0.40 }));
  const r1 = await post(p1.port, "/v1/messages", msg);
  assert.equal(r1.status, 200);
  const spent1 = p1.spentBoundUsd();
  assert.ok(Math.abs(spent1 - (0.40 + perReq)) < 1e-9, `spent ${spent1}`);
  p1.close();

  // ledger file exists and holds the cumulative bound
  const ledger = JSON.parse(readFileSync(statePath, "utf8"));
  assert.ok(Math.abs(ledger.cumulative - perReq) < 1e-9);

  // "restart": new proxy, same state path -> cumulative reloads, basis still applies
  const p2 = await startBudgetProxy(cfg(up.port, { statePath, basisUsd: 0.40 }));
  assert.ok(Math.abs(p2.spentBoundUsd() - (0.40 + perReq)) < 1e-9, "reloaded ledger + basis");

  // cap enforcement across the restart: cap 0.45 with basis 0.40 + ledger 0.0467 -> next request 429s locally
  const p3 = await startBudgetProxy(cfg(up.port, { statePath, basisUsd: 0.40, totalUsd: 0.45 }));
  const r3 = await post(p3.port, "/v1/messages", msg);
  assert.equal(r3.status, 429);
  assert.match(r3.body, /budget_exceeded/);
  p2.close(); p3.close(); up.close();
});
