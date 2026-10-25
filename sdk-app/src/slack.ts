/** Production surface: Slack Bolt in Socket Mode (same pattern as the kit's
 * adapter). The SDK AgentCore does all reasoning; this file only renders.
 *
 * DO NOT run against a real workspace without the owner's approval - it posts
 * messages as the bot. Verification happens through cli.ts, which drives the
 * identical AgentCore code path.
 *
 * Env: SLACK_BOT_TOKEN (xoxb-), SLACK_APP_TOKEN (xapp-, socket mode), plus config.ts env.
 * Approval replies in-thread: "approve <id>" / "deny <id>". */
import { App } from "@slack/bolt";
import { buildRuntime } from "./runtime.js";

/** Slack renders badly past ~4k chars; split long answers on paragraph, then
 * line, then hard boundaries. Exported for tests. */
export function chunkText(text: string, max = 3500): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** User-facing error rendering; exported for tests. */
export function renderError(err: unknown): string {
  const m = String((err as any)?.message ?? err);
  if (/budget|429|cap/i.test(m)) return "I hit the spending cap for this app, so I stopped before finishing. An admin can raise it.";
  if (/timeout|timed out/i.test(m)) return "That took too long and I stopped it. Try a narrower request.";
  return "Something went wrong on my side while working on that. The details are in the audit log.";
}

export async function startSlackApp(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const { config, approvals, agent } = await buildRuntime(env);

  const bolt = new App({ token: env.SLACK_BOT_TOKEN, appToken: env.SLACK_APP_TOKEN, socketMode: true });

  const handle = async (event: any, say: any) => {
    if (event.bot_id || event.subtype) return;
    const thread = event.thread_ts ?? event.ts;
    const threadKey = `${event.channel}:${thread}`;
    const text: string = (event.text ?? "").replace(/<@[A-Z0-9]+>/g, "").trim();
    const sayThread = async (message: string) => {
      for (const chunk of chunkText(message)) await say({ text: chunk, thread_ts: thread });
    };

    if (/^(stop|cancel)$/i.test(text)) {
      await sayThread(agent.cancel(threadKey) ? "Stopped the current turn." : "Nothing is running in this thread.");
      return;
    }
    if (!text) {
      await sayThread("Ask me something - I can search docs, browse approved sites, and work on the repo. Writes always ask first.");
      return;
    }
    const m = /^(approve|deny)\s+(\S+)$/i.exec(text);
    if (m) {
      // Named approvers only (kit RBAC carried over): SDK_APP_APPROVERS is a
      // comma-separated list of Slack user IDs. Anyone else is ignored.
      if (!config.isApprover(event.user)) {
        await sayThread("You are not a named approver for this app.");
        return;
      }
      // Thread binding: the decision must come from the same Slack thread the
      // request was made in - nobody can approve from another channel/DM.
      const r = approvals.resolve(m[2], m[1].toLowerCase() === "approve", event.user ?? "slack-user", threadKey);
      await sayThread(r === "resolved" ? `${m[1].toLowerCase() === "approve" ? "Approved" : "Denied"} ${m[2]}.` : r === "wrong-thread" ? `Approval ${m[2]} belongs to another conversation.` : `No pending approval ${m[2]}.`);
      return;
    }
    try {
      await agent.chat(threadKey, text, {
        onText: (t) => { void sayThread(t); },
        onApprovalNeeded: (id, summary) => { void sayThread(`Approval needed (${id}): ${summary}\nReply in thread: approve ${id} / deny ${id}`); },
      }, { userId: event.user, surface: "slack", channelId: event.channel });
    } catch (err) {
      await sayThread(renderError(err));
    }
  };

  bolt.event("app_mention", async ({ event, say }) => handle(event, say));
  bolt.message(async ({ event, say }) => handle(event, say));

  await bolt.start();
  const pending = approvals.list();
  if (pending.length) console.log(`resurfaced ${pending.length} pending approvals after restart`);
  console.log("sdk-app Slack surface running (socket mode)");
}

if (process.argv[1]?.endsWith("slack.ts")) {
  void startSlackApp();
}
