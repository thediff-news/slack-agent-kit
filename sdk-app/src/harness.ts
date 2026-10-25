/** Shared chat-surface logic: routes lines to approvals or the agent, and
 * crucially NEVER blocks approval commands behind an in-flight chat turn
 * (the first harness deadlocked: chat awaited the gate while the loop that
 * reads "approve <id>" awaited chat). Extracted from cli.ts so the
 * concurrency is unit-testable; slack.ts relies on Bolt's per-event
 * concurrency for the same guarantee. */
import type { AgentCore } from "./agent.js";
import type { ApprovalStore } from "./approvals.js";

export type HarnessIO = {
  print: (s: string) => void;
  printStream: (s: string) => void;
};

export function createLineHandler(
  agent: AgentCore,
  approvals: ApprovalStore,
  io: HarnessIO,
  threadKey: string,
): { onLine: (line: string) => void; drain: () => Promise<void> } {
  const queue: string[] = [];
  let chatting = false;
  let idle: (() => void) | null = null;

  const pump = () => {
    if (chatting || !queue.length) {
      if (!chatting && !queue.length && idle) { idle(); idle = null; }
      return;
    }
    chatting = true;
    const text = queue.shift()!;
    agent
      .chat(threadKey, text, {
        onText: (t) => io.printStream(t),
        onApprovalNeeded: (id, summary) =>
          io.print(`[approval needed] ${id}: ${summary}\nreply: approve ${id} / deny ${id}`),
        onEscalated: (_signal, brief) =>
          io.print(`[BLOCKED - escalated] ${brief}\nThe turn was stopped. Retrying needs your explicit instruction and starts fresh - no writes or costs from the stalled turn are replayed.`),
      })
      .catch((e) => io.print(`[error] ${String(e).slice(0, 200)}`))
      .finally(() => { chatting = false; pump(); });
  };

  return {
    onLine(line: string) {
      const text = line.trim();
      if (!text) return;
      const m = /^(approve|deny)\s+(\S+)$/i.exec(text);
      if (m) {
        // approvals resolve immediately - never queued behind a chat turn
        const r = approvals.resolve(m[2], m[1].toLowerCase() === "approve", "cli-user", threadKey);
        io.print(r.status === "resolved" ? `${m[1]}ed ${m[2]}${r.resumed ? "" : " (after restart - repeat the request to run it)"}` : r.status === "wrong-thread" ? `approval ${m[2]} belongs to another conversation` : `no pending approval ${m[2]}`);
      } else if (text === "pending") {
        io.print(approvals.list().map((r) => `${r.id}: ${r.summary}`).join("\n") || "(none)");
      } else {
        queue.push(text);
        pump();
      }
    },
    /** Resolve when the queue is empty and no chat is in flight. */
    drain: () => new Promise((res) => { if (!chatting && !queue.length) res(); else idle = res; }),
  };
}
