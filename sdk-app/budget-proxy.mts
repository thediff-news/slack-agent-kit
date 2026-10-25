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
import { readFileSync, writeFileSync, renameSync, mkdirSync, appendFileSync } from "node:fs";
import { buildMeterProjection, syncMeter } from "./src/checkpoint.js";
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
  /** Max concurrent in-flight reservations (admitted, not yet terminally
   * settled). Excess requests QUEUE (FIFO) up to queueDeadlineMs instead of
   * failing: serializing admission stops 429/retry bursts from burning
   * reservations when per-request bounds are large. Default 2. */
  maxInflight?: number;
  /** Ms a queued request waits for an in-flight slot before a 429. Default 60s. */
  queueDeadlineMs?: number;
  /** Optional append-only per-request journal (JSONL): gate/upstream/settle
   * events with stable request ids, so held reservations can later be
   * classified (settled / unparseable / incomplete / rejected / aborted)
   * instead of sitting in the ledger as one unexplained number. */
  journalPath?: string;
  /** Optional durable meter sync. When set, a request is forwarded upstream
   * ONLY after the sanitized meter projection (request ids, bounds, states,
   * meter totals - never bodies/headers/keys) is durably ACKed by the private
   * remote; a sync failure FAILS CLOSED (503, reservation rolled back, nothing
   * forwarded). Settle updates sync idempotently (full reconcile each time). */
  checkpoint?: { stateDir: string; remote: string; branch?: string };
}

export type JournalEvent = {
  ev: "gate" | "upstream" | "upstream_error" | "settle";
  reqId: string;
  ts: string;
  // gate
  decision?: "accepted" | "rejected_cap" | "rejected_model" | "rejected_price" | "rejected_tool" | "rejected_count" | "rejected_badjson" | "rejected_queue_full" | "rejected_queue_timeout" | "rejected_durability" | "rejected_unmetered_endpoint";
  model?: string; counted_input?: number; max_tokens?: number; bound?: number; cumulative_after?: number;
  // upstream
  status?: number;
  message?: string;
  // settle
  via?: "end" | "close"; bytes?: number; decompressed?: boolean; parsed?: boolean; complete?: boolean;
  measured?: number; released?: number;
};

/** Final per-request classification folded from journal events. */
export type ReservationState =
  | "gate_rejected"          // never forwarded: provably zero liability
  | "settled_measured"       // complete usage evidence; bound released down to measured
  | "kept_bound_unparseable" // upstream responded, usage unreadable: unknown liability, bound held
  | "kept_bound_incomplete"  // truncated stream: unknown liability, bound held
  | "upstream_error"         // forwarding failed: bound held (request may or may not have reached upstream)
  | "in_flight_or_aborted";  // accepted, no terminal event recorded (shutdown/disconnect): unknown

export function reconcileJournal(events: JournalEvent[]): {
  requests: Record<string, { state: ReservationState; bound: number; measured?: number }>;
  totals: { acceptedBound: number; settledMeasured: number; released: number; heldBound: number; provableZero: number; unknownCount: number };
} {
  const requests: Record<string, { state: ReservationState; bound: number; measured?: number }> = {};
  for (const e of events) {
    const r = (requests[e.reqId] ??= { state: "in_flight_or_aborted", bound: 0 });
    if (e.ev === "gate") {
      if (e.decision === "accepted") { r.state = "in_flight_or_aborted"; r.bound = e.bound ?? 0; }
      else { r.state = "gate_rejected"; r.bound = 0; }
    } else if (e.ev === "upstream_error") {
      r.state = "upstream_error";
    } else if (e.ev === "settle") {
      if (e.parsed && e.complete && e.measured !== undefined) { r.state = "settled_measured"; r.measured = e.measured; }
      else if (e.parsed && !e.complete) r.state = "kept_bound_incomplete";
      else r.state = "kept_bound_unparseable";
    }
  }
  const totals = { acceptedBound: 0, settledMeasured: 0, released: 0, heldBound: 0, provableZero: 0, unknownCount: 0 };
  for (const r of Object.values(requests)) {
    if (r.state === "gate_rejected") { totals.provableZero += 1; continue; }
    totals.acceptedBound += r.bound;
    if (r.state === "settled_measured") { totals.settledMeasured += r.measured ?? 0; totals.released += r.bound - (r.measured ?? 0); }
    else { totals.heldBound += r.bound; totals.unknownCount += 1; }
  }
  return { requests, totals };
}

/** Per-request upper bound in USD. count_tokens is documented as an estimate
 *  ("actual input tokens... might differ by a small amount"; system-added tokens
 *  are unbilled), so input is padded 15% AND priced at the highest input-side
 *  rate (cache write) regardless of the actual cache mix. Output is hard-capped
 *  provider-side by the max_tokens rewrite. */
export const COUNT_TOKENS_MARGIN = 1.15;
export function requestBoundUsd(inputTokens: number, maxOutputTokens: number, cfg: Pick<ProxyConfig, "inputRatePerMTok" | "outputRatePerMTok">): number {
  // count_tokens is FREE per the owning docs ("Token counting is free to use",
  // docs.claude.com/en/docs/build-with-claude/token-counting - Pricing and rate
  // limits), so input is priced ONCE. The 15% padding stays (count is an
  // estimate); the highest input-side rate stays (cache mix unknown at gate).
  return (inputTokens * COUNT_TOKENS_MARGIN * cfg.inputRatePerMTok + maxOutputTokens * cfg.outputRatePerMTok) / 1_000_000;
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
async function upstreamRaw(cfg: ProxyConfig, path: string, body: string, method = "POST", fwdHeaders?: Record<string, string>): Promise<{ status: number; headers: http.IncomingHttpHeaders; res: http.IncomingMessage }> {
  const target = new URL(cfg.upstreamBase);
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || "";
  const dbg = process.env.BUDGET_PROXY_DEBUG ? console.log : () => {};
  dbg(`[budget-proxy] upstream ${path} target=${target.hostname} proxyEnv=${proxy ? "set" : "empty"}`);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-api-key": cfg.realKey,
    "anthropic-version": "2023-06-01",
    "content-length": String(Buffer.byteLength(body)),
    // Allowlisted client headers only (e.g. anthropic-beta): beta-gated request
    // fields (thinking.display, output_config, context_management) are REJECTED
    // upstream without the matching beta header - dropping it caused 400s on
    // every fresh-session burst. Auth never comes from the client; realKey above.
    ...(fwdHeaders ?? {}),
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

async function upstreamJson(cfg: ProxyConfig, path: string, body: string, fwdHeaders?: Record<string, string>): Promise<{ status: number; body: string }> {
  const r = await upstreamRaw(cfg, path, body, "POST", fwdHeaders);
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
  if (cfg.journalPath) mkdirSync(dirname(cfg.journalPath), { recursive: true });
  let reqSeq = 0;
  const journal = (e: Omit<JournalEvent, "ts">) => {
    if (!cfg.journalPath) return;
    try { appendFileSync(cfg.journalPath, JSON.stringify({ ...e, ts: new Date().toISOString() }) + "\n"); } catch { /* journal must never break the gate */ }
    // Settle/unknown transitions update the durable projection idempotently
    // (full reconcile each sync); a failed settle-sync heals on the next one.
    if (e.ev === "settle" || e.ev === "upstream_error") void meterSync();
  };
  const persist = () => {
    if (!cfg.statePath) return;
    const tmp = cfg.statePath + ".tmp";
    writeFileSync(tmp, JSON.stringify({ cumulative, updated: new Date().toISOString() }));
    renameSync(tmp, cfg.statePath);
  };

  /** Durable meter sync: full reconcile from the journal every call (idempotent;
   * a missed settle heals on the next transition). Returns the remote-ACK flag. */
  const meterSync = async (): Promise<boolean> => {
    if (!cfg.checkpoint) return true; // durability not configured: local journal only
    try {
      const events = cfg.journalPath ? readFileSync(cfg.journalPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
      const projection = buildMeterProjection(events, reconcileJournal, cumulative, basis);
      const r = await syncMeter({ stateDir: cfg.checkpoint.stateDir, remote: cfg.checkpoint.remote, branch: cfg.checkpoint.branch, projection });
      return r.ok && r.acked;
    } catch { return false; }
  };

  // Backpressure: at most maxInflight reservations occupy upstream slots;
  // further requests wait in a FIFO queue for a settle to free a slot.
  const maxInflight = cfg.maxInflight ?? 2;
  const queueDeadline = cfg.queueDeadlineMs ?? 60_000;
  const MAX_QUEUE = 16;
  let inFlight = 0;
  const waiters: Array<{ admit: () => void; timer: NodeJS.Timeout; bound: number }> = [];
  const fitsBudgetRef = { fn: (_b: number) => true }; // replaced below (defined after cumulative)
  const admit = (bound: number): Promise<"ok" | "full" | "timeout"> =>
    new Promise((resolve) => {
      if (inFlight < maxInflight && fitsBudgetRef.fn(bound)) { inFlight++; return resolve("ok"); }
      if (waiters.length >= MAX_QUEUE) return resolve("full");
      const timer = setTimeout(() => {
        const i = waiters.findIndex((w) => w.timer === timer);
        if (i !== -1) waiters.splice(i, 1);
        resolve("timeout");
      }, queueDeadline);
      waiters.push({ admit: () => { clearTimeout(timer); inFlight++; resolve("ok"); }, timer, bound });
    });
  const fitsBudget = (bound: number) => basis + cumulative + bound <= cfg.totalUsd;
  fitsBudgetRef.fn = fitsBudget;
  const releaseSlot = () => {
    inFlight = Math.max(0, inFlight - 1);
    // FIFO, budget-aware: admit the head waiter only if its bound fits the
    // CURRENT ledger (a settle may have released enough room; if not, it keeps
    // waiting until its deadline instead of being admitted into a cap 429).
    const next = waiters[0];
    if (next && fitsBudget(next.bound)) { waiters.shift(); next.admit(); }
  };
  const server = http.createServer(async (clientReq, clientRes) => {
    try {
      const chunks: Buffer[] = [];
      for await (const c of clientReq) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString("utf8");
      const url = clientReq.url ?? "/";
      // Forward ONLY these allowlisted client headers upstream (never auth).
      const fwd: Record<string, string> = {};
      const betaH = clientReq.headers["anthropic-beta"];
      if (typeof betaH === "string" && betaH) fwd["anthropic-beta"] = betaH;
      const verH = clientReq.headers["anthropic-version"];
      if (typeof verH === "string" && verH) fwd["anthropic-version"] = verH;
      const pathname = url.split("?")[0];
      const isFreeEndpoint =
        (clientReq.method === "POST" && pathname === "/v1/messages/count_tokens") || // documented free
        (clientReq.method === "GET" && pathname === "/v1/models"); // unbilled metadata
      if (!isFreeEndpoint && !(clientReq.method === "POST" && pathname === "/v1/messages")) {
        // Never forward an endpoint the meter does not gate: an unmetered
        // passthrough is a budget bypass, so anything outside the allowlist
        // is refused instead of forwarded.
        journal({ ev: "gate", reqId: `bp-${Date.now().toString(36)}-x`, decision: "rejected_unmetered_endpoint" });
        clientRes.writeHead(403, { "content-type": "application/json" });
        clientRes.end(JSON.stringify({ type: "error", error: { type: "unmetered_endpoint", message: "endpoint is not on the budget proxy allowlist and cannot be forwarded unmetered" } }));
        return;
      }
      if (isFreeEndpoint) {
        // unbilled endpoints (models list, count_tokens): forward ungated
        console.log(`[budget-proxy] ${new Date().toISOString()} passthrough ${clientReq.method} ${url}`);
        const r = await upstreamRaw(cfg, url, raw, clientReq.method, fwd);
        console.log(`[budget-proxy] ${new Date().toISOString()} passthrough ${clientReq.method} ${url} -> ${r.status}`);
        clientRes.writeHead(r.status, r.headers);
        r.res.pipe(clientRes);
        return;
      }
      // gate POST /v1/messages
      const reqId = `bp-${Date.now().toString(36)}-${++reqSeq}`;
      let body: any;
      try { body = JSON.parse(raw); } catch { journal({ ev: "gate", reqId, decision: "rejected_badjson" }); clientRes.writeHead(400).end('{"error":"bad json"}'); return; }
      const allowedModels = cfg.model.split(",").map((m) => m.trim()).filter(Boolean);
      if (!allowedModels.includes(body.model)) {
        journal({ ev: "gate", reqId, decision: "rejected_model", model: String(body.model ?? "") });
        clientRes.writeHead(403, { "content-type": "application/json" });
        clientRes.end(JSON.stringify({ type: "error", error: { type: "budget_proxy_model", message: `budget proxy allows only ${cfg.model}, got ${body.model}` } }));
        return;
      }
      const rate = cfg.rates?.[body.model] ?? (body.model === allowedModels[0] ? { input: cfg.inputRatePerMTok, output: cfg.outputRatePerMTok } : undefined);
      if (!rate) {
        journal({ ev: "gate", reqId, decision: "rejected_price", model: String(body.model ?? "") });
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
        journal({ ev: "gate", reqId, decision: "rejected_tool", model: String(body.model ?? "") });
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
      const cr = await upstreamJson(cfg, "/v1/messages/count_tokens", countBody, fwd);
      if (cr.status !== 200) {
        journal({ ev: "gate", reqId, decision: "rejected_count", model: String(body.model ?? "") });
        clientRes.writeHead(502, { "content-type": "application/json" });
        clientRes.end(JSON.stringify({ type: "error", error: { type: "budget_proxy_count", message: `count_tokens ${cr.status}: ${cr.body.slice(0, 200)}` } }));
        return;
      }
      const inputTokens = Number(JSON.parse(cr.body).input_tokens ?? 0);
      const boundExact = requestBoundUsd(inputTokens, body.max_tokens, gateCfg);
      console.log(`[budget-proxy] ${new Date().toISOString()} gate req counted_input=${inputTokens} max_tokens=${body.max_tokens} bound_usd=${boundExact.toFixed(6)} cumulative_before_usd=${cumulative.toFixed(6)}`);
      const bound = boundExact;
      // Bound alone can never fit: reject without queuing.
      if (basis + bound > cfg.totalUsd) {
        journal({ ev: "gate", reqId, decision: "rejected_cap", model: String(body.model ?? ""), counted_input: inputTokens, max_tokens: body.max_tokens, bound });
        clientRes.writeHead(429, { "content-type": "application/json" });
        clientRes.end(JSON.stringify({ type: "error", error: { type: "budget_exceeded", message: `budget proxy hard cap: bound $${bound.toFixed(4)} alone exceeds cumulative cap $${cfg.totalUsd}` } }));
        return;
      }
      // Backpressure admission AFTER the bound is known: wait for a slot AND
      // budget room (a queued request is admitted only when it actually fits,
      // so a settle can make room instead of the SDK eating a 429-retry burst).
      const adm = await admit(bound);
      if (adm !== "ok") {
        journal({ ev: "gate", reqId, decision: adm === "full" ? "rejected_queue_full" : "rejected_queue_timeout", model: String(body.model ?? ""), counted_input: inputTokens, max_tokens: body.max_tokens, bound });
        clientRes.writeHead(429, { "content-type": "application/json" });
        clientRes.end(JSON.stringify({ type: "error", error: { type: "budget_proxy_queue", message: `budget proxy queue ${adm}: no slot/budget within ${queueDeadline}ms` } }));
        return;
      }
      // Hard guard re-checked at admit time (ledger may have moved while queued).
      if (!fitsBudget(bound)) {
        releaseSlot();
        journal({ ev: "gate", reqId, decision: "rejected_cap", model: String(body.model ?? ""), counted_input: inputTokens, max_tokens: body.max_tokens, bound });
        clientRes.writeHead(429, { "content-type": "application/json" });
        clientRes.end(JSON.stringify({ type: "error", error: { type: "budget_exceeded", message: `budget proxy hard cap: bound $${bound.toFixed(4)} would exceed cumulative cap $${cfg.totalUsd} (bound so far $${cumulative.toFixed(4)})` } }));
        return;
      }
      cumulative += bound; // charged conservatively BEFORE forwarding; actual <= bound
      persist();
      journal({ ev: "gate", reqId, decision: "accepted", model: String(body.model ?? ""), counted_input: inputTokens, max_tokens: body.max_tokens, bound, cumulative_after: cumulative });
      // Wallet-bearing moment: the reservation must be durable BEFORE upstream
      // sees the request. FAIL CLOSED: no ACK, no forward, reservation rolled back.
      if (!(await meterSync())) {
        // Journal FIRST (synchronous, durable): a crash after this line but
        // before the rollback leaves the ledger holding the bound while the
        // journal says provable-zero - the safe direction (overcharged, never
        // undercharged). The reverse order could lose money across a restart.
        journal({ ev: "gate", reqId, decision: "rejected_durability", model: String(body.model ?? ""), bound });
        cumulative -= bound;
        persist();
        releaseSlot();
        clientRes.writeHead(503, { "content-type": "application/json" });
        clientRes.end(JSON.stringify({ type: "error", error: { type: "durability_unavailable", message: "meter checkpoint remote ACK failed; the request was NOT forwarded and the reservation was rolled back" } }));
        return;
      }
      let r: Awaited<ReturnType<typeof upstreamRaw>>;
      try {
        r = await upstreamRaw(cfg, url, JSON.stringify(body), "POST", fwd);
      } catch (e) {
        releaseSlot();
        journal({ ev: "upstream_error", reqId, message: (e as Error).message.slice(0, 200) });
        throw e;
      }
      journal({ ev: "upstream", reqId, status: r.status });
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
          if (!usage || !complete) {
            if (r.status >= 400) console.log(`[budget-proxy] ${new Date().toISOString()} upstream_error_body status=${r.status} ${text.slice(0, 300).replace(/\n/g, " ")}`);
            journal({ ev: "settle", reqId, via, bytes: raw.length, decompressed, parsed: !!usage, complete });
            releaseSlot(); // settle is TERMINAL for the reservation even when unparseable: the bound stays held (safe direction) but the in-flight slot must free, or 400/truncated responses wedge the queue
            return;
          }
          const settled = settledCostUsd(usage, settleCfgFor(usage));
          if (settled < bound) {
            cumulative = cumulative - bound + settled;
            persist();
            journal({ ev: "settle", reqId, via, bytes: raw.length, decompressed, parsed: true, complete: true, measured: settled, released: bound - settled });
            console.log(`[budget-proxy] ${new Date().toISOString()} settle req bound_usd=${bound.toFixed(6)} -> measured_bound_usd=${settled.toFixed(6)} (in=${usage.input} cw=${usage.cacheWrite} cr=${usage.cacheRead} out=${usage.output}) cumulative_usd=${cumulative.toFixed(6)}`);
          } else {
            journal({ ev: "settle", reqId, via, bytes: raw.length, decompressed, parsed: true, complete: true, measured: settled, released: 0 });
          }
          // Terminal for this reservation: free the slot AFTER any settle-down,
          // so a budget-blocked queued request sees the room this settle made.
          releaseSlot();
        };
        const enc = String(r.headers["content-encoding"] ?? "");
        const done = (e: Error | null, b?: Buffer) => finish(e ? Buffer.alloc(0) : b!, !e);
        if (/br/i.test(enc)) zlib.brotliDecompress(raw, done);
        else if (/gzip/i.test(enc)) zlib.gunzip(raw, done);
        else if (/deflate/i.test(enc)) zlib.inflate(raw, done);
        else finish(raw, false);
      };
      let sawEnd = false;
      r.res.on("end", () => { sawEnd = true; trySettle("end"); });
      r.res.on("close", () => {
        trySettle("close");
        if (!sawEnd) {
          // Premature upstream close: pipe() only ends the client on "end", so
          // a cut stream (tunnel drop, network wobble) would leave the SDK
          // waiting on a dead response forever. Propagate the cut so the
          // client's own error/retry handling fires.
          clientRes.destroy(new Error("upstream closed before end-of-stream"));
        }
      });
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
