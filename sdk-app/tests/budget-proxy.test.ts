import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { startBudgetProxy, extractUsage, settledCostUsd, reconcileJournal } from "../budget-proxy.mjs";

type Mode = "json" | "sse" | "nousage" | "huge" | "huge-hi" | "sse-gzip" | "sse-truncated";
async function mockUpstream(mode: Mode = "json"): Promise<{ port: number; close: () => void }> {
  const server = http.createServer((req, res) => {
    if (req.url === "/v1/messages/count_tokens") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ input_tokens: mode === "huge-hi" ? 100000 : 1000 }));
      return;
    }
    if (mode === "sse") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        "event: message_start\ndata: " + JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 2000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } } }) + "\n\n" +
        "event: message_delta\ndata: " + JSON.stringify({ type: "message_delta", usage: { output_tokens: 500 } }) + "\n\n" +
        "event: message_stop\ndata: " + JSON.stringify({ type: "message_stop" }) + "\n\n"
      );
      return;
    }
    if (mode === "sse-gzip" || mode === "sse-truncated") {
      const frames =
        "event: message_start\ndata: " + JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 2000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } }) + "\n\n" +
        "event: message_delta\ndata: " + JSON.stringify({ type: "message_delta", usage: { output_tokens: 500 } }) + "\n\n" +
        (mode === "sse-gzip" ? "event: message_stop\ndata: " + JSON.stringify({ type: "message_stop" }) + "\n\n" : "");
      if (mode === "sse-gzip") {
        res.writeHead(200, { "content-type": "text/event-stream", "content-encoding": "gzip" });
        res.end(zlib.gzipSync(frames));
      } else {
        // client disconnect / tunnel teardown: stream ends mid-message
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(frames);
      }
      return;
    }
    if (mode === "nousage") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "msg_1" }));
      return;
    }
    if (mode === "huge" || mode === "huge-hi") {
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
  // settled to measured usage: 1000 in *2.5/M + 10 out *10/M = 0.0026
  const settled1 = settledCostUsd({ input: 1000, cacheWrite: 0, cacheRead: 0, output: 10 }, cfg(up.port));
  const spent1 = p1.spentBoundUsd();
  assert.ok(Math.abs(spent1 - (0.40 + settled1)) < 1e-9, `spent ${spent1}`);
  p1.close();

  // ledger file exists and holds the settled cumulative
  const ledger = JSON.parse(readFileSync(statePath, "utf8"));
  assert.ok(Math.abs(ledger.cumulative - settled1) < 1e-9, `ledger ${ledger.cumulative}`);

  // "restart": new proxy, same state path -> cumulative reloads, basis still applies
  const p2 = await startBudgetProxy(cfg(up.port, { statePath, basisUsd: 0.40 }));
  assert.ok(Math.abs(p2.spentBoundUsd() - (0.40 + settled1)) < 1e-9, "reloaded ledger + basis");

  // cap enforcement across the restart: cap 0.44 with basis 0.40 + ledger 0.0026
  // -> the next request's full reservation (0.0467) would reach 0.4493 -> 429s locally
  const p3 = await startBudgetProxy(cfg(up.port, { statePath, basisUsd: 0.40, totalUsd: 0.44 }));
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
  // measured: 2000 in *2.5/M + 500 out *10/M = 0.010, well under the 0.0467 reservation
  const settledUsd = settledCostUsd({ input: 2000, cacheWrite: 0, cacheRead: 0, output: 500 }, cfg(up.port));
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
  assert.deepEqual(extractUsage(sse), { input: 100, cacheWrite: 40, cacheRead: 60, output: 42 });
  assert.deepEqual(extractUsage(JSON.stringify({ usage: { input_tokens: 5, output_tokens: 7 } })), { input: 5, cacheWrite: 0, cacheRead: 0, output: 7 });
  assert.equal(extractUsage("not json at all"), null);
  assert.equal(extractUsage(JSON.stringify({ id: "x" })), null);
});

test("budget proxy: gzipped SSE settles to measured usage (compressed tap)", async () => {
  const up = await mockUpstream("sse-gzip");
  const p = await startBudgetProxy(cfg(up.port));
  const r = await post(p.port, "/v1/messages", msg);
  assert.equal(r.status, 200);
  await new Promise((r2) => setTimeout(r2, 200));
  const expected = settledCostUsd({ input: 2000, cacheWrite: 0, cacheRead: 0, output: 500 }, cfg(up.port));
  assert.ok(Math.abs(p.spentBoundUsd() - expected) < 1e-9, `spent ${p.spentBoundUsd()} != ${expected}`);
  p.close(); up.close();
});

test("budget proxy: truncated SSE (no message_stop) keeps the full bound", async () => {
  const up = await mockUpstream("sse-truncated");
  const p = await startBudgetProxy(cfg(up.port));
  const r = await post(p.port, "/v1/messages", msg);
  assert.equal(r.status, 200);
  await new Promise((r2) => setTimeout(r2, 200));
  assert.ok(Math.abs(p.spentBoundUsd() - perReq) < 1e-9, `spent ${p.spentBoundUsd()} != full bound ${perReq}`);
  p.close(); up.close();
});

test("budget proxy: parallel reservations settle independently (atomic)", async () => {
  const up = await mockUpstream("sse");
  const p = await startBudgetProxy(cfg(up.port));
  const [r1, r2] = await Promise.all([post(p.port, "/v1/messages", msg), post(p.port, "/v1/messages", msg)]);
  assert.equal(r1.status, 200); assert.equal(r2.status, 200);
  await new Promise((r3) => setTimeout(r3, 200));
  const each = settledCostUsd({ input: 2000, cacheWrite: 0, cacheRead: 0, output: 500 }, cfg(up.port));
  assert.ok(Math.abs(p.spentBoundUsd() - 2 * each) < 1e-9, `spent ${p.spentBoundUsd()} != ${2 * each}`);
  p.close(); up.close();
});

test("settledCostUsd: cache classes bill at exact multipliers, not full input rate", () => {
  const c = cfg(0);
  const u = { input: 1000, cacheWrite: 1000, cacheRead: 10000, output: 100 };
  // (1000 + 1.25*1000 + 0.1*10000) * 2.5/M + 100*10/M = (3250*2.5 + 1000)/1e6 = 0.009125
  assert.ok(Math.abs(settledCostUsd(u, c) - 0.009125) < 1e-12, String(settledCostUsd(u, c)));
});

test("extractUsage: SSE message_start keeps cache classes separate", () => {
  const sse = "event: message_start\ndata: " + JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 100, cache_creation_input_tokens: 400, cache_read_input_tokens: 20000, output_tokens: 1 } } }) + "\n\n" +
    "event: message_delta\ndata: " + JSON.stringify({ type: "message_delta", usage: { output_tokens: 50 } }) + "\n\n" +
    "event: message_stop\ndata: " + JSON.stringify({ type: "message_stop" }) + "\n\n";
  const u = extractUsage(sse)!;
  assert.deepEqual(u, { input: 100, cacheWrite: 400, cacheRead: 20000, output: 50 });
});

test("budget proxy: tiered model reserves at the HIGH tier but settles by ACTUAL prompt size", async () => {
  const up = await mockUpstream("json"); // usage: 1000 in / 10 out (under threshold)
  const statePath = join(mkdtempSync(join(tmpdir(), "bp-tier-")), "ledger.json");
  const p = await startBudgetProxy(cfg(up.port, {
    model: "claude-sonnet-5-5,claude-haiku-5-5",
    rates: { "claude-haiku-5-5": { input: 0.10, output: 0.50, highInput: 0.50, highOutput: 2.50 } },
    statePath,
  }));
  const r = await post(p.port, "/v1/messages", { model: "claude-haiku-5-5", max_tokens: 4096, messages: [{ role: "user", content: "hi" }] });
  assert.equal(r.status, 200);
  await settle();
  // small actual prompt -> LOW tier settle: 1000*0.10/M + 10*0.50/M
  const spent = p.spentBoundUsd();
  assert.ok(Math.abs(spent - 0.000105) < 1e-9, `settled ${spent} at low tier`);
  p.close(); up.close();
});

test("budget proxy: tiered model settles at the HIGH tier when the actual prompt crosses the threshold", async () => {
  const up = await mockUpstream("huge-hi"); // count AND usage both 100000 in (self-consistent)
  const p = await startBudgetProxy(cfg(up.port, {
    model: "claude-sonnet-5-5,claude-haiku-5-5",
    rates: { "claude-haiku-5-5": { input: 0.10, output: 0.50, highInput: 0.50, highOutput: 2.50 } },
  }));
  const r = await post(p.port, "/v1/messages", { model: "claude-haiku-5-5", max_tokens: 4096, messages: [{ role: "user", content: "hi" }] });
  assert.equal(r.status, 200);
  await settle();
  // 100000 actual input >= threshold -> HIGH tier: 100000*0.50/M + 4096*2.50/M
  const spent = p.spentBoundUsd();
  assert.ok(Math.abs(spent - 0.06024) < 1e-9, `settled ${spent} at high tier`);
  p.close(); up.close();
});

test("journal: gate rejection (cap) is recorded and never added to the ledger", async () => {
  const up = await mockUpstream("json");
  const dir = mkdtempSync(join(tmpdir(), "bp-journal-"));
  const jp = join(dir, "journal.jsonl");
  // cap below one reservation -> the very first request is rejected
  const p = await startBudgetProxy(cfg(up.port, { totalUsd: 0.01, journalPath: jp }));
  const r = await post(p.port, "/v1/messages", msg);
  assert.equal(r.status, 429);
  const events = readFileSync(jp, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(events.length, 1);
  assert.equal(events[0].ev, "gate");
  assert.equal(events[0].decision, "rejected_cap");
  const rec = reconcileJournal(events);
  assert.equal(rec.totals.provableZero, 1);
  assert.equal(rec.totals.acceptedBound, 0);
  assert.equal(rec.totals.heldBound, 0);
  p.close(); up.close();
});

test("journal: accepted request settles to measured and reconciles with release", async () => {
  const up = await mockUpstream("sse");
  const dir = mkdtempSync(join(tmpdir(), "bp-journal-"));
  const jp = join(dir, "journal.jsonl");
  const p = await startBudgetProxy(cfg(up.port, { journalPath: jp }));
  const r = await post(p.port, "/v1/messages", msg);
  assert.equal(r.status, 200);
  await settle();
  const events = readFileSync(jp, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const kinds = events.map((e: any) => e.ev);
  assert.deepEqual(kinds, ["gate", "upstream", "settle"]);
  const rec = reconcileJournal(events);
  const states = Object.values(rec.requests).map((x) => x.state);
  assert.deepEqual(states, ["settled_measured"]);
  assert.equal(rec.totals.unknownCount, 0);
  assert.ok(rec.totals.released > 0, "bound released down to measured");
  assert.ok(rec.totals.settledMeasured > 0);
  p.close(); up.close();
});

test("journal: truncated SSE and unparseable response classify as kept-bound unknowns; retries get distinct ids", async () => {
  const up = await mockUpstream("sse-truncated");
  const dir = mkdtempSync(join(tmpdir(), "bp-journal-"));
  const jp = join(dir, "journal.jsonl");
  const p = await startBudgetProxy(cfg(up.port, { journalPath: jp }));
  await post(p.port, "/v1/messages", msg);
  await post(p.port, "/v1/messages", msg); // retry: second reservation
  await settle();
  const events = readFileSync(jp, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const rec = reconcileJournal(events);
  const ids = Object.keys(rec.requests);
  assert.equal(ids.length, 2, "each attempt is its own reservation");
  assert.ok(ids[0] !== ids[1]);
  for (const id of ids) assert.equal(rec.requests[id].state, "kept_bound_incomplete");
  assert.equal(rec.totals.unknownCount, 2);
  assert.ok(Math.abs(rec.totals.heldBound - 2 * perReq) < 1e-9);
  p.close(); up.close();

  const up2 = await mockUpstream("nousage");
  const dir2 = mkdtempSync(join(tmpdir(), "bp-journal-"));
  const jp2 = join(dir2, "journal.jsonl");
  const p2 = await startBudgetProxy(cfg(up2.port, { journalPath: jp2 }));
  await post(p2.port, "/v1/messages", msg);
  await settle();
  const rec2 = reconcileJournal(readFileSync(jp2, "utf8").trim().split("\n").map((l) => JSON.parse(l)));
  assert.deepEqual(Object.values(rec2.requests).map((x) => x.state), ["kept_bound_unparseable"]);
  assert.equal(rec2.totals.unknownCount, 1);
  p2.close(); up2.close();
});
