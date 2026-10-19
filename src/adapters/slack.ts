/**
 * Slack adapter: Bolt in Socket Mode (no public URL needed).
 * Listens to app_mention + top-level channel messages, normalizes them into
 * AgentEvents, and serves approval buttons. Routing, dedup, RBAC, gating and
 * audit all live in the core Runtime - this file only translates.
 *
 * Needs SLACK_BOT_TOKEN + SLACK_APP_TOKEN (see docs/SLACK_SETUP.md). The kit
 * runs fully without them via the CLI harness (npm run demo).
 */
import { App } from "@slack/bolt";
import { makeEventId, stripAppMention, type AgentEvent } from "../core/events.js";
import type { Approval } from "../core/store.js";
import type { RuntimeHooks } from "../core/runtime.js";
import { buildRuntime } from "../kit.js";

const pending = new Map<string, (d: "approved" | "denied") => void>();

function toEvent(e: { ts: string; user?: string; channel: string; text?: string; thread_ts?: string }, kind: AgentEvent["kind"]): AgentEvent {
  return {
    id: makeEventId("slack", e.ts), // Slack ts is unique per channel message: our idempotency key
    source: "slack",
    kind,
    actorId: e.user ?? "unknown",
    channelId: e.channel,
    text: e.text ?? "",
    threadId: e.thread_ts ?? e.ts,
    receivedAt: new Date().toISOString(),
    raw: e,
  };
}


async function replaceButtons(respond: any, text: string) {
  try {
    await respond({ replace_original: true, text });
  } catch {}
}

async function main() {
  const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    socketMode: true,
  });

  const hooks: RuntimeHooks = {
    async notify(event, text) {
      await app.client.chat.postMessage({ channel: event.channelId, thread_ts: event.threadId, text });
    },
    async requestApproval(approval: Approval, event: AgentEvent) {
      await app.client.chat.postMessage({
        channel: event.channelId,
        thread_ts: event.threadId,
        text: `Approval needed: ${approval.summary}`,
        blocks: [{
          type: "actions",
          block_id: `gate-${approval.id}`,
          elements: [
            { type: "button", text: { type: "plain_text", text: "Approve" }, style: "primary", action_id: `approve:${approval.id}` },
            { type: "button", text: { type: "plain_text", text: "Deny" }, style: "danger", action_id: `deny:${approval.id}` },
          ],
        }],
      });
      return new Promise((resolve) => pending.set(approval.id, resolve));
    },
  };

  const kit = await buildRuntime(process.env.KIT_CONFIG ?? "kit.config.yaml", hooks);

  app.action(/^approve:.+/, async ({ action, ack, body, respond }) => {
    await ack();
    const id = (action as any).action_id.split(":")[1];
    const who = (body as any).user?.id ?? "unknown";
    if (!kit.permissions.canApprove(who)) return;
    if (!pending.has(id)) return;
    pending.get(id)?.("approved");
    pending.delete(id);
    await replaceButtons(respond, `Approved by <@${who}>`);
  });

  app.action(/^deny:.+/, async ({ action, ack, body, respond }) => {
    await ack();
    const id = (action as any).action_id.split(":")[1];
    const who = (body as any).user?.id ?? "unknown";
    if (!kit.permissions.canApprove(who)) return;
    if (!pending.has(id)) return;
    pending.get(id)?.("denied");
    pending.delete(id);
    await replaceButtons(respond, `Denied by <@${who}>`);
  });

  app.event("app_mention", async ({ event }) => {
    const e = event as any;
    await kit.runtime.handleEvent(toEvent({ ...e, text: stripAppMention(e.text ?? "") }, "mention"));
  });

  // Watch configured channels for top-level alerts (e.g. scanner bots posting).
  app.message(async ({ message }) => {
    const m = message as any;
    if (m.subtype || m.thread_ts) return; // top-level human/bot messages only
    await kit.runtime.handleEvent(toEvent(m, "channel_message"));
  });

  for (const p of await kit.runtime.resumePending()) {
    console.log(`[resume] approval still pending after restart: ${p.id} - ${p.summary}`);
  }

  await app.start();
  console.log("slack-agent-kit listening (Socket Mode)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
