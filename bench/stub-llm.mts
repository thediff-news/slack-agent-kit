/** Deterministic stub Llm for the non-code factory stages (triage/plan/repro/
 *  review) so the Claude code-engine bench makes ZERO paid OpenAI calls.
 *  CHANGED BENCHMARK CONDITIONS: not apples-to-apples with the Oct-20 gpt-5
 *  full-pipeline baseline - this measures the Claude code stage inside the
 *  factory harness with the surrounding stages pinned deterministic.
 *  Stage is sniffed from the stage functions' fixed system prompts. */
import type { Llm } from "../src/llm/openai.js";

const REPRO_TEST = `import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { HttpPlanner } from "../src/browse/planner.js";

test("HttpPlanner.plan gives up after BROWSE_MODEL_TIMEOUT_MS and returns a fail step", async () => {
  // accept-and-never-reply server; track sockets so teardown frees the
  // planner's pending fetch (otherwise the harness waits out its 240s kill).
  const socks = new Set<import("node:net").Socket>();
  const server = http.createServer(() => { /* accept and never reply */ });
  server.on("connection", (s) => { socks.add(s); s.on("close", () => socks.delete(s)); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  process.env.BROWSE_MODEL_TIMEOUT_MS = "400";
  try {
    const p = new HttpPlanner(\`http://127.0.0.1:\${port}/v1/chat/completions\`, "k", "m", 5);
    const step = await Promise.race([
      p.plan("read the page", { url: "http://x", title: "t", ariaTree: "", text: "", suspiciousLines: [], stepCount: 0 }, []),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("plan() hung past 5s despite BROWSE_MODEL_TIMEOUT_MS=400")), 5000)),
    ]);
    assert.equal(step.kind, "fail");
    assert.match((step as any).reason, /timeout/i);
  } finally {
    for (const s of socks) s.destroy();
    server.close();
  }
});
`;

export function stubLlm(): Llm {
  return {
    model: "deterministic-stub",
    lastUsage: undefined,
    async chat(msgs: { role: string; content: string }[]): Promise<string> {
      const sys = String(msgs[0]?.content ?? "");
      if (sys.includes("You triage software reports")) {
        return JSON.stringify({ kind: "bug", severity: "medium", title: "HttpPlanner fetch has no timeout; plan() can hang forever", duplicates: [], summary: "HttpPlanner calls the model endpoint without a timeout, so an unresponsive endpoint hangs plan() indefinitely. Needs a configurable timeout (BROWSE_MODEL_TIMEOUT_MS, default ~60s) returning a fail step." });
      }
      if (sys.includes("senior engineer planning a minimal fix")) {
        return JSON.stringify({ files: ["src/browse/planner.ts"], approach: "Wrap the fetch in HttpPlanner.plan with AbortController driven by BROWSE_MODEL_TIMEOUT_MS (default 60000); on abort return { kind: 'fail', reason: 'planner request timed out after <ms>ms' } instead of throwing.", testStrategy: "tests/repro-planner-timeout.test.ts: server accepts but never replies; plan() must return a fail step mentioning timeout.", reproTest: "tests/repro-planner-timeout.test.ts" });
      }
      if (sys.includes("MINIMAL test that reproduces")) {
        return JSON.stringify({ files: [{ path: "tests/repro-planner-timeout.test.ts", content: REPRO_TEST }], notes: "Accepts-but-never-replies server; without a timeout plan() hangs (test fails via 5s race), with the fix it returns a fail step within BROWSE_MODEL_TIMEOUT_MS." });
      }
      if (sys.includes("strict code reviewer")) {
        return JSON.stringify({ ok: true, issues: [] });
      }
      throw new Error("stub Llm: unrecognized stage prompt");
    },
  };
}
