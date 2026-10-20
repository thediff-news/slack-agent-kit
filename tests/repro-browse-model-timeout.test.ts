import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpPlanner } from "../src/browse/planner.js";

test("HttpPlanner: a stalled model request returns a timeout fail step", async () => {
  const realFetch = globalThis.fetch;
  const previousTimeout = process.env.BROWSE_MODEL_TIMEOUT_MS;
  process.env.BROWSE_MODEL_TIMEOUT_MS = "25";
  globalThis.fetch = ((_url: any, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return; // Simulate a server that accepts the request and never replies.
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
  })) as typeof fetch;

  try {
    const planner = new HttpPlanner("https://model.example/chat", "test-key", "test-model", 5);
    const watchdog = Symbol("planner still hanging");
    const outcome = await Promise.race([
      planner.plan("test goal", {
        url: "https://example.com", title: "Example", ariaTree: "", text: "", suspiciousLines: [], stepCount: 0,
      }, []),
      new Promise<typeof watchdog>((resolve) => setTimeout(() => resolve(watchdog), 300)),
    ]);

    assert.notEqual(outcome, watchdog, "plan() should finish instead of hanging");
    assert.equal((outcome as any).kind, "fail");
    assert.match((outcome as any).reason, /timeout/i);
  } finally {
    globalThis.fetch = realFetch;
    if (previousTimeout === undefined) delete process.env.BROWSE_MODEL_TIMEOUT_MS;
    else process.env.BROWSE_MODEL_TIMEOUT_MS = previousTimeout;
  }
});
