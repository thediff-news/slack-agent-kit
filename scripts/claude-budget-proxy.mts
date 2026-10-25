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
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { once } from "node:events";

export interface ProxyConfig {
  totalUsd: number;        // hard cumulative bound, e.g. 1.90
  model: string;           // allowed model id
  maxOutputTokens: number; // enforced max_tokens ceiling, e.g. 8192
  inputRatePerMTok: number;  // highest input-side rate (cache write): 2.50
  outputRatePerMTok: number; // 10
  upstreamBase: string;    // https://api.anthropic.com (or http://127.0.0.1:x for tests)
  realKey: string;
}

/** Per-request upper bound in USD. count_tokens is documented as an estimate
 *  ("actual input tokens... might differ by a small amount"; system-added tokens
 *  are unbilled), so input is padded 15% AND priced at the highest input-side
 *  rate (cache write) regardless of the actual cache mix. Output is hard-capped
 *  provider-side by the max_tokens rewrite. */
export const COUNT_TOKENS_MARGIN = 1.15;
export function requestBoundUsd(inputTokens: number, maxOutputTokens: number, cfg: Pick<ProxyConfig, "inputRatePerMTok" | "outputRatePerMTok">): number {
  return (inputTokens * COUNT_TOKENS_MARGIN * cfg.inputRatePerMTok + maxOutputTokens * cfg.outputRatePerMTok) / 1_000_000;
}

/** One upstream request, direct or CONNECT-tunneled through the srt proxy.
 *  Returns the raw response so SSE streams pass through untouched. */
async function upstreamRaw(cfg: ProxyConfig, path: string, body: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; res: http.IncomingMessage }> {
  const target = new URL(cfg.upstreamBase);
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || "";
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-api-key": cfg.realKey,
    "anthropic-version": "2023-06-01",
    "content-length": String(Buffer.byteLength(body)),
  };
  if (proxy && target.hostname.endsWith("anthropic.com")) {
    const p = new URL(proxy);
    const auth = "Basic " + Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString("base64");
    const sock = net.connect(Number(p.port), p.hostname);
    await once(sock, "connect");
    sock.write(`CONNECT ${target.hostname}:443 HTTP/1.1\r\nHost: ${target.hostname}:443\r\nProxy-Authorization: ${auth}\r\n\r\n`);
    sock.setEncoding("utf8");
    let head = "";
    await new Promise<void>((resolve, reject) => {
      const onData = (c: string) => { head += c; if (head.includes("\r\n\r\n")) { sock.off("data", onData); resolve(); } };
      sock.on("data", onData); sock.on("error", reject);
      setTimeout(() => reject(new Error("CONNECT timeout")), 15_000);
    });
    if (!head.startsWith("HTTP/1.1 200") && !head.startsWith("HTTP/1.0 200")) throw new Error(`proxy CONNECT failed: ${head.split("\r\n")[0]}`);
    const tlsSock = tls.connect({ socket: sock, servername: target.hostname });
    await once(tlsSock, "secureConnect");
    return new Promise((resolve, reject) => {
      const req = https.request({ host: target.hostname, path, method: "POST", headers, agent: false, createConnection: () => tlsSock }, (res) => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, res });
      });
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }
  return new Promise((resolve, reject) => {
    const mod = target.protocol === "http:" ? http : https;
    const req = mod.request({ host: target.hostname, port: target.port || undefined, path, method: "POST", headers }, (res) => {
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
  const server = http.createServer(async (clientReq, clientRes) => {
    try {
      const chunks: Buffer[] = [];
      for await (const c of clientReq) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString("utf8");
      const url = clientReq.url ?? "/";
      if (clientReq.method !== "POST" || !url.startsWith("/v1/messages") || url === "/v1/messages/count_tokens") {
        // unbilled endpoints (models list, count_tokens): forward ungated
        const r = await upstreamRaw(cfg, url, raw);
        clientRes.writeHead(r.status, r.headers);
        r.res.pipe(clientRes);
        return;
      }
      // gate POST /v1/messages
      let body: any;
      try { body = JSON.parse(raw); } catch { clientRes.writeHead(400).end('{"error":"bad json"}'); return; }
      if (body.model !== cfg.model) {
        clientRes.writeHead(403, { "content-type": "application/json" });
        clientRes.end(JSON.stringify({ type: "error", error: { type: "budget_proxy_model", message: `budget proxy allows only ${cfg.model}, got ${body.model}` } }));
        return;
      }
      const serverTool = (body.tools ?? []).find((t: any) => /web_search|web_fetch|code_execution/i.test(String(t?.type ?? "")));
      if (serverTool) {
        clientRes.writeHead(403, { "content-type": "application/json" });
        clientRes.end(JSON.stringify({ type: "error", error: { type: "budget_proxy_tool", message: `server-billed tool ${serverTool.type} rejected by budget proxy` } }));
        return;
      }
      body.max_tokens = Math.min(Number(body.max_tokens ?? cfg.maxOutputTokens) || cfg.maxOutputTokens, cfg.maxOutputTokens);
      // exact input count upstream (same tokenizer, unbilled)
      const countBody = JSON.stringify({ model: body.model, messages: body.messages, ...(body.system ? { system: body.system } : {}), ...(body.tools ? { tools: body.tools } : {}), ...(body.thinking ? { thinking: body.thinking } : {}) });
      const cr = await upstreamJson(cfg, "/v1/messages/count_tokens", countBody);
      if (cr.status !== 200) {
        clientRes.writeHead(502, { "content-type": "application/json" });
        clientRes.end(JSON.stringify({ type: "error", error: { type: "budget_proxy_count", message: `count_tokens ${cr.status}: ${cr.body.slice(0, 200)}` } }));
        return;
      }
      const inputTokens = Number(JSON.parse(cr.body).input_tokens ?? 0);
      const bound = requestBoundUsd(inputTokens, body.max_tokens, cfg);
      if (cumulative + bound > cfg.totalUsd) {
        clientRes.writeHead(429, { "content-type": "application/json" });
        clientRes.end(JSON.stringify({ type: "error", error: { type: "budget_exceeded", message: `budget proxy hard cap: bound $${bound.toFixed(4)} would exceed cumulative cap $${cfg.totalUsd} (bound so far $${cumulative.toFixed(4)})` } }));
        return;
      }
      cumulative += bound; // charged conservatively BEFORE forwarding; actual <= bound
      const r = await upstreamRaw(cfg, url, JSON.stringify(body));
      clientRes.writeHead(r.status, r.headers);
      r.res.pipe(clientRes); // SSE stream passes through untouched
    } catch (e) {
      clientRes.writeHead(502, { "content-type": "application/json" });
      clientRes.end(JSON.stringify({ type: "error", error: { type: "budget_proxy_error", message: (e as Error).message.slice(0, 300) } }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as net.AddressInfo).port;
  return { port, spentBoundUsd: () => cumulative, close: () => server.close() };
}
