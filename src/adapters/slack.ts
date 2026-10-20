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
import type { ProposedAction } from "../core/skills.js";
import { buildRuntime } from "../kit.js";

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
      // The runtime persists the approval and owns its resolution. Do not keep
      // the decision in an adapter-local promise map: that map disappears on
      // restart, while the Slack message and its approval ID remain durable.
      return new Promise(() => {});
    },
    async upload(event, path, caption) {
      await app.client.files.uploadV2({
        channel_id: event.channelId,
        ...(event.threadId ? { thread_ts: event.threadId } : {}),
        file: path,
        filename: path.split("/").pop(),
        initial_comment: caption,
      } as any);
    },
  };

  const kit = await buildRuntime(process.env.KIT_CONFIG ?? "kit.config.yaml", hooks);

  const decide = async (action: any, body: any, respond: any, decision: "approved" | "denied") => {
    const id = String(action.action_id).split(":")[1];
    const who = body.user?.id ?? "unknown";
    if (!kit.permissions.canApprove(who)) return;

    // Resolve by durable approval ID. The runtime validates that the approval
    // is still pending and resumes any persisted gated work (including sync
    // first-sync gates) exactly once.
    const runtime = kit.runtime as typeof kit.runtime & {
      resolveApproval?: (approvalId: string, actorId: string, decision: "approved" | "denied") => Promise<boolean>;
    };
    if (!runtime.resolveApproval) {
      console.warn(`[approval] runtime cannot resolve durable approval ${id}`);
      return;
    }
    const resolved = await runtime.resolveApproval(id, who, decision);
    if (!resolved) return;
    await replaceButtons(respond, `${decision === "approved" ? "Approved" : "Denied"} by <@${who}>`);
  };

  app.action(/^approve:.+/, async ({ action, ack, body, respond }) => {
    await ack();
    await decide(action, body, respond, "approved");
  });

  app.action(/^deny:.+/, async ({ action, ack, body, respond }) => {
    await ack();
    await decide(action, body, respond, "denied");
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

  // Automatic connector sync (docs/SYNC.md): scheduled crawl of every
  // syncable configured connector. First sync per connector and any ACL
  // re-tag go through the same approval gate as skill actions.
  if (kit.sync && kit.config.sync) {
    const syncCfg = kit.config.sync;
    const intervalMs = Math.max(1, syncCfg.intervalMinutes ?? 15) * 60_000;
    const syncEvent: AgentEvent = {
      id: makeEventId("sync", "timer"),
      source: "sync",
      kind: "timer",
      actorId: "sync-engine",
      channelId: syncCfg.notifyChannel ?? "",
      text: "scheduled connector sync",
      receivedAt: new Date().toISOString(),
    };
    const runSync = async () => {
      try {
        const results = await kit.sync!.runOnce((action: ProposedAction) => kit.runtime.executeProposed(action, syncEvent));
        for (const r of results) {
          if (r.error || r.ingested || r.deleted || r.gated.length) console.log("[sync]", JSON.stringify(r));
        }
      } catch (e) {
        console.warn("[sync] run failed:", e instanceof Error ? e.message : e);
      }
    };
    setTimeout(runSync, 5_000); // first pass right after boot
    setInterval(runSync, intervalMs);
    console.log(`[sync] scheduled every ${intervalMs / 60000} minute(s)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
