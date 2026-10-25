/**
 * Budget proxy: the HARD pre-request spend bound for the Claude Agent SDK spike.
 *
 * Runs in-process in the wrapper (inside the srt sandbox). The SDK/CLI points at
 * ANTHROPIC_BASE_URL=http://127.0.0.1:<port>; every POST /v1/messages is gated:
 *
 *   1. model allowlist (env BUDGET_PROXY_MODEL, default claude-sonnet-5-5)
 *   2. server-billed tools (web_search/web_fetch/code_execution) rejected outright
 *   3. max_tokens rewritten to <= 8192  -> PROVIDER-enforced output ceiling
 *      ($10/MTok -> <= $0.08192 output per request, thinking included)
 *   4. input tokens counted UPSTREAM via /v1/messages/count_tokens (same
 *      tokenizer; not a billed feature - it is absent from the pricing page's
 *      enumerated billable dimensions and answered 200 on a zero-balance key)
 *   5. per-request upper bound = input_tokens x $2.50/MTok (cache-write = the
 *      highest input-side rate) + 8192 x $10/MTok
 *   6. if cumulativeBound + requestBound > BUDGET_PROXY_TOTAL_USD the request is
 *      REJECTED locally (HTTP 429) and never forwarded - actual spend is
      therefore always <= cumulativeBound <= the cap. No estimates.
 *
 * The real API key lives only in this proxy (env BUDGET_PROXY_KEY); the CLI gets
 * a dummy key. count_tokens and /v1/models pass through ungated (not billed).
 *
 * Upstream is reached directly, or through the srt HTTP proxy (HTTPS_PROXY env,
 * CONNECT + TLS) when running inside the sandbox.
 */
import http from "node:http";
import zlib from "node:zlib";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { once } from "node:events";
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface ProxyConfig {
  totalUsd: number;        // hard cumulative bound, e.g. 1.90
  model: string;           // allowed model id
  maxOutputTokens: number; // enforced max_tokens ceiling, e.g. 8192
  inputRatePerMTok: number;  // highest input-side rate (cache write): 2.50
  outputRatePerMTok: number; // 10
  /** Verified per-model prices (USD per MTok) for every model the allowlist
   * admits beyond `model`. A request for a model with no known price is
   * REJECTED: bounding a stronger model at sonnet rates would under-reserve. */
  rates?: Record<string, { input: number; output: number; highInput?: number; highOutput?: number; threshold?: number }>;
  upstreamBase: string;    // https://api.anthropic.com (or http://127.0.0.1:x for tests)
  realKey: string;
  /** Optional durable ledger: cumulative bound survives process restarts, so
   * the cap is enforceable across app restarts instead of per-process. */
  statePath?: string;
  /** Conservative spend that happened OUTSIDE this ledger (prior sessions,
   * unsettled reservations): counted against the cap from the first request. */
  basisUsd?: number;
}

/** Per-request upper bound in USD. count_tokens is documented as an estimate
 *  ("actual input tokens... might differ by a small amount"; system-added tokens
 *  are unbilled), so input is padded 15% AND priced at the highest input-side
 *  rate (cache write) regardless of the actual cache mix. Output is hard-capped
 *  provider-side by the max_tokens rewrite. */
export const COUNT_TOKENS_MARGIN = 1.15;
export function requestBoundUsd(inputTokens: number, maxOutputTokens: number, cfg: Pick<ProxyConfig, "inputRatePerMTok" | "outputRatePerMTok">): number {
  // Input is priced TWICE: once for the messages call and once for the upstream
  // count_tokens call - the owning docs never state count_tokens is unbilled,
  // so the bound assumes it bills at the same input rate. (If it is free the
  // bound is simply more conservative; the ledger stays hard either way.)
  return (2 * inputTokens * COUNT_TOKENS_MARGIN * cfg.inputRatePerMTok + maxOutputTokens * cfg.outputRatePerMTok) / 1_000_000;
}

/** Usage parsed from a completed /v1/messages response (SSE stream or plain
 *  JSON). Every cache class is counted at the highest input-side rate, so the
 *  settled cost stays an upper bound. Null means no usage is visible; the full
 *  reservation then stays charged (the safe direction). */
export type MeasuredUsage = { input: number; cacheWrite: number; cacheRead: number; output: number };

const usageOf = (u: any): MeasuredUsage => ({
  input: Number(u.input_tokens ?? 0),
  cacheWrite: Number(u.cache_creation_input_tokens ?? 0),
  cacheRead: Number(u.cache_read_input_tokens ?? 0),
  output: Number(u.output_tokens ?? 0),
});

export function extractUsage(body: string): MeasuredUsage | null {
  let acc: MeasuredUsage = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  let seen = false;
  if (/^event:/m.test(body)) {
    for (const m of body.matchAll(/^data: (.*)$/gm)) {
      try {
        const d = JSON.parse(m[1]);
        const u = d.type === "message_start" ? d.message?.usage : d.type === "message_delta" ? d.usage : undefined;
        if (!u) continue;
        const mu = usageOf(u);
        if (d.type === "message_start") {
          acc = { input: acc.input + mu.input, cacheWrite: acc.cacheWrite + mu.cacheWrite, cacheRead: acc.cacheRead + mu.cacheRead, output: acc.output };
          seen = true;
        }
        acc.output = Math.max(acc.output, mu.output);
      } catch { /* partial data line */ }
    }
    return seen ? acc : null;
  }
  try {
    const u = JSON.parse(body).usage;
    if (!u) return null;
    return usageOf(u);
  } catch { return null; }
}

/** Post-response cost from MEASURED usage at EXACT per-class rates on the
 *  proxy's configured schedule: plain input 1x, cache write 1.25x, cache read
 *  0.1x (the API's universal cache pricing multipliers), output 1x. The old
 *  model charged every class at 2x full input rate (a "count_tokens companion"
 *  that is actually unbilled), inflating settled cost several-fold on
 *  cache-heavy traffic and stranding real budget as fictitious bound spend. */
export function settledCostUsd(u: MeasuredUsage, cfg: Pick<ProxyConfig, "inputRatePerMTok" | "outputRatePerMTok">): number {
  return ((u.input + 1.25 * u.cacheWrite + 0.1 * u.cacheRead) * cfg.inputRatePerMTok + u.output * cfg.outputRatePerMTok) / 1_000_000;
}

/** One upstream request, direct or CONNECT-tunneled through the srt proxy.
 *  Returns the raw response so SSE streams pass through untouched. */
async function upstreamRaw(cfg: ProxyConfig, path: string, body: string, method = "POST"): Promise<{ status: number; headers: http.IncomingHttpHeaders; res: http.IncomingMessage }> {
  const target = new URL(cfg.upstreamBase);
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || "";
  const dbg = process.env.BUDGET_PROXY_DEBUG ? console.log : () => {};
  dbg(`[budget-proxy] upstream ${path} target=${target.hostname} proxyEnv=${proxy ? "set" : "empty"}`);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-api-key": cfg.realKey,
    "anthropic-version": "2023-06-01",
    "content-length": String(Buffer.byteLength(body)),
  };
  if (proxy && target.hostname.endsWith("anthropic.com")) {
    const p = new URL(proxy);
    dbg(`[budget-proxy] CONNECT via ${p.hostname}:${p.port} user=${p.username.slice(0, 20)}...`);
    const auth = "Basic " + Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString("base64");
    const sock = net.connect(Number(p.port), p.hostname);
    await once(sock, "connect");
    sock.write(`CONNECT ${target.hostname}:443 HTTP/1.1\r\nHost: ${target.hostname}:443\r\nProxy-Authorization: ${auth}\r\n\r\n`);
    // raw-buffer read: setEncoding/flowing-mode leftovers corrupt the TLS handshake
    const headParts: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CONNECT timeout")), 15_000);
      const onData = (c: Buffer) => {
        headParts.push(c);
        const buf = Buffer.concat(headParts);
        const end = buf.indexOf("\r\n\r\n");
        if (end !== -1) {
          clearTimeout(timer);
          sock.off("data", onData);
          sock.pause();
          const rest = buf.subarray(end + 4);
          if (rest.length) sock.unshift(rest); // hand surplus bytes back to TLS
          resolve();
        }
      };
      sock.on("data", onData); sock.on("error", reject);
    });
    const head = Buffer.concat(headParts).toString("latin1");
    if (!head.startsWith("HTTP/1.1 200") && !head.startsWith("HTTP/1.0 200")) throw new Error(`proxy CONNECT failed: ${head.split("\r\n")[0]}`);
    const tlsSock = tls.connect({ socket: sock, servername: target.hostname });
    await Promise.race([once(tlsSock, "secureConnect"), new Promise((_, rej) => setTimeout(() => rej(new Error("TLS timeout")), 15_000))]);
    // agent: false + request-level createConnection is IGNORED by Node 22 (the
    // fresh agent's own createConnection runs and DNS-resolves the target,
    // which fails inside the sandbox). Override the agent's createConnection.
    const agent = new https.Agent();
    agent.createConnection = (() => tlsSock) as typeof agent.createConnection;
    return new Promise((resolve, reject) => {
      const req = https.request({ host: target.hostname, path, method, headers, agent }, (res) => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, res });
      });
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }
  return new Promise((resolve, reject) => {
    const mod = target.protocol === "http:" ? http : https;
    const req = mod.request({ host: target.hostname, port: target.port || undefined, path, method, headers }, (res) => {
      resolve({ status: res.statusCode ?? 0, headers: res.headers, res });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function upstreamJson(cfg: ProxyConfig, path: string, body: string): Promise<{ status: number; body: string }> {
  const r = await upstreamRaw(cfg, path, body);
  let data = "";
  for await (const c of r.res) data += c;
  return { status: r.status, body: data };
}

export async function startBudgetProxy(cfg: ProxyConfig): Promise<{ port: number; spentBoundUsd: () => number; close: () => void }> {
  let cumulative = 0;
  if (cfg.statePath) {
    try {
      const prior = JSON.parse(readFileSync(cfg.statePath, "utf8"));
      if (typeof prior.cumulative === "number" && prior.cumulative >= 0) cumulative = prior.cumulative;
    } catch { /* no ledger yet - starts at 0 */ }
  }
  const basis = cfg.basisUsd ?? 0;
  if (cfg.statePath) mkdirSync(dirname(cfg.statePath), { recursive: true });
  const persist = () => {
    if (!cfg.statePath) return;
    const tmp = cfg.statePath + ".tmp";
    writeFileSync(tmp, JSON.stringify({ cumulative, updated: new Date().toISOString() }));
    renameSync(tmp, cfg.statePath);
  };
  const server = http.createServer(async (clientReq, clientRes) => {
    try {
      const chunks: Buffer[] = [];
      for await (const c of clientReq) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString("utf8");
      const url = clientReq.url ?? "/";
      if (clientReq.method !== "POST" || !url.startsWith("/v1/messages") || url === "/v1/messages/count_tokens") {
        // unbilled endpoints (models list, count_tokens): forward ungated
        console.log(`[budget-proxy] ${new Date().toISOString()} passthrough ${clientReq.method} ${url}`);
        const r = await upstreamRaw(cfg, url, raw, clientReq.method);
        console.log(`[budget-proxy] ${new Date().toISOString()} passthrough ${clientReq.method} ${url} -> ${r.status}`);
        clientRes.writeHead(r.status, r.headers);
        r.res.pipe(clientRes);
        return;
      }
      // gate POST /v1/messages
      let body: any;
      try { body = JSON.parse(raw); } catch { clientRes.writeHead(400).end('{"error":"bad json"}'); return; }
      const allowedModels = cfg.model.split(",").map((m) => m.trim()).filter(Boolean);
      if (!allowedModels.includes(body.model)) {
        clientRes.writeHead(403, { "content-type": "application/json" });
        clientRes.end(JSON.stringify({ type: "error", error: { type: "budget_proxy_model", message: `budget proxy allows only ${cfg.model}, got ${body.model}` } }));
        return;
      }
      const rate = cfg.rates?.[body.model] ?? (body.model === allowedModels[0] ? { input: cfg.inputRatePerMTok, output: cfg.outputRatePerMTok } : undefined);
      if (!rate) {
        clientRes.writeHead(403, { "content-type": "application/json" });
        clientRes.end(JSON.stringify({ type: "error", error: { type: "budget_proxy_price", message: `no verified price configured for ${body.model}; refusing to guess a spend bound` } }));
        return;
      }
      // Gate (reservation): always the HIGH tier when configured - a request
      // whose real prompt crosses the tier threshold must never be reserved
      // cheap. Settle: the tier the ACTUAL measured prompt size falls in.
      const tierThreshold = rate.threshold ?? 100_000;
      const gateCfg = { inputRatePerMTok: rate.highInput ?? rate.input, outputRatePerMTok: rate.highOutput ?? rate.output };
      const settleCfgFor = (u: MeasuredUsage) =>
        rate.highInput !== undefined && (u.input + u.cacheWrite + u.cacheRead) >= tierThreshold
          ? gateCfg
          : { inputRatePerMTok: rate.input, outputRatePerMTok: rate.output };
      const serverTool = (body.tools ?? []).find((t: any) => /web_search|web_fetch|code_execution/i.test(String(t?.type ?? "")));
      if (serverTool) {
        clientRes.writeHead(403, { "content-type": "application/json" });
        clientRes.end(JSON.stringify({ type: "error", error: { type: "budget_proxy_tool", message: `server-billed tool ${serverTool.type} rejected by budget proxy` } }));
        return;
      }
      body.max_tokens = Math.min(Number(body.max_tokens ?? cfg.maxOutputTokens) || cfg.maxOutputTokens, cfg.maxOutputTokens);
      // exact input count upstream (same tokenizer, unbilled)
      // count_tokens rejects newer request fields (e.g. Sonnet 5.5 per-message
      // output_config). Strip them recursively for the COUNT call only - the
      // forwarded request keeps the original body. Divergence is covered by the
      // 15% count padding; a failed count fails CLOSED (request rejected).
      const stripForCount = (v: unknown): unknown => {
        if (Array.isArray(v)) return v.map(stripForCount);
        if (v && typeof v === "object") {
          const o: Record<string, unknown> = {};
          for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
            if (k === "output_config") continue;
            o[k] = stripForCount(val);
          }
          return o;
        }
        return v;
      };
      const countBody = JSON.stringify({ model: body.model, messages: stripForCount(body.messages), ...(body.system ? { system: stripForCount(body.system) } : {}), ...(body.tools ? { tools: stripForCount(body.tools) } : {}), ...(body.thinking ? { thinking: body.thinking } : {}) });
      const cr = await upstreamJson(cfg, "/v1/messages/count_tokens", countBody);
      if (cr.status !== 200) {
        clientRes.writeHead(502, { "content-type": "application/json" });
        clientRes.end(JSON.stringify({ type: "error", error: { type: "budget_proxy_count", message: `count_tokens ${cr.status}: ${cr.body.slice(0, 200)}` } }));
        return;
      }
      const inputTokens = Number(JSON.parse(cr.body).input_tokens ?? 0);
      const boundExact = requestBoundUsd(inputTokens, body.max_tokens, gateCfg);
      console.log(`[budget-proxy] ${new Date().toISOString()} gate req counted_input=${inputTokens} max_tokens=${body.max_tokens} bound_usd=${boundExact.toFixed(6)} cumulative_before_usd=${cumulative.toFixed(6)}`);
      const bound = boundExact;
      if (basis + cumulative + bound > cfg.totalUsd) {
        clientRes.writeHead(429, { "content-type": "application/json" });
        clientRes.end(JSON.stringify({ type: "error", error: { type: "budget_exceeded", message: `budget proxy hard cap: bound $${bound.toFixed(4)} would exceed cumulative cap $${cfg.totalUsd} (bound so far $${cumulative.toFixed(4)})` } }));
        return;
      }
      cumulative += bound; // charged conservatively BEFORE forwarding; actual <= bound
      persist();
      const r = await upstreamRaw(cfg, url, JSON.stringify(body));
      clientRes.writeHead(r.status, r.headers);
      // Tap the response for usage, then settle the reservation down to the
      // measured cost when the stream ends. Settlement only ever LOWERS the
      // ledger and only with usage evidence in hand; an unparseable or failed
      // response keeps the full bound (safe direction).
      const tap: Buffer[] = [];
      let tapBytes = 0;
      r.res.on("data", (c: Buffer) => { if (tapBytes < 8 * 1024 * 1024) { tap.push(c); tapBytes += c.length; } });
      // Settle on EITHER terminal event: a proxied stream can end via "close"
      // without "end" (client disconnect, tunnel teardown). Settlement still
      // requires COMPLETE-response evidence: a parseable usage record AND, for
      // SSE, the message_stop frame - a truncated stream keeps the full bound.
      let settleDone = false;
      const trySettle = (via: "end" | "close") => {
        if (settleDone) return;
        settleDone = true;
        const raw = Buffer.concat(tap);
        const finish = (buf: Buffer, decompressed: boolean) => {
          const text = buf.toString("utf8");
          const usage = extractUsage(text);
          const isSse = /^event:/m.test(text);
          const complete = isSse ? /"type"\s*:\s*"message_stop"/.test(text) : usage !== null;
          console.log(`[budget-proxy] ${new Date().toISOString()} settle_attempt via=${via} bytes=${raw.length} decompressed=${decompressed} parsed=${usage ? "yes" : "no"} complete=${complete}`);
          if (!usage || !complete) return; // safe direction: unknown liability keeps the bound
          const settled = settledCostUsd(usage, settleCfgFor(usage));
          if (settled < bound) {
            cumulative = cumulative - bound + settled;
            persist();
            console.log(`[budget-proxy] ${new Date().toISOString()} settle req bound_usd=${bound.toFixed(6)} -> measured_bound_usd=${settled.toFixed(6)} (in=${usage.input} cw=${usage.cacheWrite} cr=${usage.cacheRead} out=${usage.output}) cumulative_usd=${cumulative.toFixed(6)}`);
          }
        };
        const enc = String(r.headers["content-encoding"] ?? "");
        const done = (e: Error | null, b?: Buffer) => finish(e ? Buffer.alloc(0) : b!, !e);
        if (/br/i.test(enc)) zlib.brotliDecompress(raw, done);
        else if (/gzip/i.test(enc)) zlib.gunzip(raw, done);
        else if (/deflate/i.test(enc)) zlib.inflate(raw, done);
        else finish(raw, false);
      };
      r.res.on("end", () => trySettle("end"));
      r.res.on("close", () => trySettle("close"));
      r.res.pipe(clientRes); // SSE stream passes through untouched
    } catch (e) {
      console.log(`[budget-proxy] upstream error: ${(e as Error).stack ?? e}`);
      clientRes.writeHead(502, { "content-type": "application/json" });
      clientRes.end(JSON.stringify({ type: "error", error: { type: "budget_proxy_error", message: (e as Error).message.slice(0, 300) } }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as net.AddressInfo).port;
  persist();
  return { port, spentBoundUsd: () => basis + cumulative, close: () => server.close() };
}
