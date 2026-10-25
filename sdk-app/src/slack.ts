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
import type { InputImage } from "./agent.js";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES = 3;

/** Download image attachments of a Slack event with the bot token (needs the
 * files:read scope). Only real image mimetypes, size-capped, host-checked:
 * the bot token is only ever sent to files.slack.com. Exported for tests. */
export async function fetchSlackImages(files: any[] | undefined, token: string, fetchFn: typeof fetch = fetch): Promise<{ images: InputImage[]; skipped: string[] }> {
  const images: InputImage[] = [];
  const skipped: string[] = [];
  for (const f of files ?? []) {
    const name = String(f?.name ?? f?.id ?? "file");
    if (!IMAGE_TYPES.has(f?.mimetype)) { skipped.push(`${name}: not an image`); continue; }
    if (images.length >= MAX_IMAGES) { skipped.push(`${name}: over the ${MAX_IMAGES}-image limit`); continue; }
    const url = String(f?.url_private ?? "");
    let host = "";
    try { host = new URL(url).hostname; } catch { /* bad url */ }
    if (host !== "files.slack.com") { skipped.push(`${name}: unexpected file host`); continue; }
    if (Number(f?.size) > MAX_IMAGE_BYTES) { skipped.push(`${name}: larger than 5 MB`); continue; }
    const r = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` } });
    const type = r.headers.get("content-type") ?? "";
    if (!r.ok || !IMAGE_TYPES.has(type.split(";")[0])) { skipped.push(`${name}: download failed (HTTP ${r.status}${type.includes("html") ? ", missing files:read?" : ""})`); continue; }
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_IMAGE_BYTES) { skipped.push(`${name}: larger than 5 MB`); continue; }
    images.push({ mediaType: type.split(";")[0] as InputImage["mediaType"], data: buf.toString("base64"), name });
  }
  return { images, skipped };
}

/** Slack renders badly past ~4k chars; split long answers on paragraph, then
 * line, then hard boundaries. Exported for tests. */
/** Slack mrkdwn is not CommonMark: **bold** renders literally. Convert the
 * model's markdown bold to Slack's *bold*, leaving code spans untouched. */
export function toMrkdwn(text: string): string {
  return text.split(/(`[^`]*`)/g).map((part, i) =>
    i % 2 === 1 ? part : part.replace(/\*\*([^*]+)\*\*/g, "*$1*")
  ).join("");
}

/** The exact sayThread render pipeline (Markdown -> Slack mrkdwn -> chunks),
 * exported so tests assert on the payload that actually reaches Slack. */
export function renderThreadChunks(message: string): string[] {
  return chunkText(toMrkdwn(message));
}

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
  const { config, approvals, agent, audit } = await buildRuntime(env);

  const bolt = new App({ token: env.SLACK_BOT_TOKEN, appToken: env.SLACK_APP_TOKEN, socketMode: true });

  // A channel message that @mentions the bot arrives as BOTH message and
  // app_mention: handle each Slack event timestamp once.
  const seen = new Set<string>();
  const handle = async (event: any, say: any) => {
    if (event.bot_id || (event.subtype && event.subtype !== "file_share")) return;
    const dedupe = `${event.channel}:${event.ts}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    if (seen.size > 500) seen.delete(seen.values().next().value as string);
    const thread = event.thread_ts ?? event.ts;
    const threadKey = `${event.channel}:${thread}`;
    const text: string = (event.text ?? "").replace(/<@[A-Z0-9]+>/g, "").trim();
    const sayThread = async (message: string) => {
      for (const chunk of renderThreadChunks(message)) await say({ text: chunk, thread_ts: thread });
    };

    if (/^(stop|cancel)$/i.test(text)) {
      const n = agent.cancel(threadKey);
      await sayThread(n === 0 ? "Nothing is running in this thread." : n === 1 ? "Stopped the current turn." : `Stopped ${n} turns.`);
      return;
    }
    let images: InputImage[] = [];
    if (event.files?.length) {
      const got = await fetchSlackImages(event.files, String(env.SLACK_BOT_TOKEN)).catch((e) => ({ images: [] as InputImage[], skipped: [String(e?.message ?? e)] }));
      images = got.images;
      audit.write("image_in", { received: event.files.length, accepted: images.length, skipped: got.skipped }, threadKey);
      if (got.skipped.length) await sayThread(`I could not read ${got.skipped.length} attachment(s): ${got.skipped.join("; ")}.`);
    }
    if (!text && !images.length) {
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
      if (r.status === "resolved") {
        await sayThread(`${m[1].toLowerCase() === "approve" ? "Approved" : "Denied"} ${m[2]}.`);
        if (!r.resumed) await sayThread(`The app restarted while this approval was pending, so the original turn is gone. ${m[1].toLowerCase() === "approve" ? "Repeat the request to run it now." : "Nothing ran."}`);
      } else {
        await sayThread(r.status === "wrong-thread" ? `Approval ${m[2]} belongs to another conversation.` : `No pending approval ${m[2]}.`);
      }
      return;
    }
    try {
      await agent.chat(threadKey, text, {
        onText: (t) => { void sayThread(t); },
        onApprovalNeeded: (id, summary) => { void sayThread(`Approval needed (${id}): ${summary}\nReply in thread: approve ${id} / deny ${id}`); },
      }, {
        userId: event.user, surface: "slack", channelId: event.channel, images,
        emitImage: async (path, title) => {
          await bolt.client.filesUploadV2({ channel_id: event.channel, thread_ts: thread, file: readFileSync(path), filename: basename(path), title, initial_comment: title });
        },
      });
    } catch (err) {
      await sayThread(renderError(err));
    }
  };

  // app_mention can beat the matching message event, and only the message
  // event carries file attachments reliably: give it a head start, then dedupe.
  bolt.event("app_mention", async ({ event, say }) => { await new Promise((r) => setTimeout(r, 1500)); await handle(event, say); });
  bolt.message(async ({ event, say }) => handle(event, say));

  await bolt.start();
  const pending = approvals.list();
  if (pending.length) console.log(`resurfaced ${pending.length} pending approvals after restart`);
  console.log("sdk-app Slack surface running (socket mode)");
}

if (process.argv[1]?.endsWith("slack.ts")) {
  void startSlackApp();
}
