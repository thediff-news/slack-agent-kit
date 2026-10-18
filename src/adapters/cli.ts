import * as readline from "node:readline/promises";
import type { AgentEvent, EventKind } from "../core/events.js";
import { makeEventId } from "../core/events.js";
import type { RuntimeHooks } from "../core/runtime.js";
import type { Approval } from "../core/store.js";

let counter = 0;

/** Build a normalized event as if it arrived from Slack. */
export function cliEvent(text: string, actorId = "cli-operator", kind: EventKind = "alert"): AgentEvent {
  const sourceEventId = `cli-${Date.now()}-${counter++}`;
  return {
    id: makeEventId("cli", sourceEventId),
    source: "cli",
    kind,
    actorId,
    channelId: "cli",
    text,
    receivedAt: new Date().toISOString(),
  };
}

/**
 * CLI hooks: prints notifications, asks for approval on stdin.
 * Pass autoApprove to exercise the full loop non-interactively (demo/tests).
 */
export function cliHooks(opts: { autoApprove?: boolean } = {}): RuntimeHooks {
  const rl = opts.autoApprove ? undefined : readline.createInterface({ input: process.stdin, output: process.stdout });
  return {
    async notify(_event, text) {
      console.log(`\n[bot] ${text}\n`);
    },
    async requestApproval(approval: Approval, _event) {
      if (opts.autoApprove) {
        console.log(`\n[gate] AUTO-APPROVED (demo): ${approval.summary}\n`);
        return "approved";
      }
      const answer = await rl!.question(`\n[gate] Approve? ${approval.summary}\n[gate] type "approve" or "deny": `);
      return answer.trim().toLowerCase().startsWith("approve") ? "approved" : "denied";
    },
  };
}
