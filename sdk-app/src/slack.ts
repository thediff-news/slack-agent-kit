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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";

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

/** Fail fast at boot, not mid-run: every missing credential here used to
 * surface as a confusing failure deep inside a live case. */
export function preflightProblems(env: NodeJS.ProcessEnv): string[] {
  const p: string[] = [];
  if (!env.SLACK_BOT_TOKEN?.startsWith("xoxb-")) p.push("SLACK_BOT_TOKEN missing or not an xoxb- bot token");
  if (!env.SLACK_APP_TOKEN?.startsWith("xapp-")) p.push("SLACK_APP_TOKEN missing or not an xapp- app-level token");
  if (env.SDK_APP_DRY_RUN === "0" && !env.GH_TOKEN) p.push("armed (SDK_APP_DRY_RUN=0) but GH_TOKEN missing: factory pushes use `gh auth git-credential` and would fail mid-case");
  if (!env.ANTHROPIC_API_KEY && !env.SDK_APP_KEY_FILE) p.push("no Anthropic credential: ANTHROPIC_API_KEY or SDK_APP_KEY_FILE required");
  return p;
}

/** One Slack instance per state dir: two processes share the socket and the
 * factory clones and silently corrupt each other (observed live: a stale
 * process voided a full test run). Live-pid checked; stale locks are replaced. */
export function acquireInstanceLock(path: string, pid: number = process.pid, alive: (p: number) => boolean = (p) => { try { process.kill(p, 0); return true; } catch { return false; } }): void {
  if (existsSync(path)) {
    const other = Number(readFileSync(path, "utf8").split("\n")[0]);
    if (other && other !== pid && alive(other)) {
      throw new Error(`another sdk-app Slack instance is already running (pid ${other}, lock ${path}). Stop it first: two instances share the Slack socket and the factory clones.`);
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${pid}\n${new Date().toISOString()}\n`);
  const cleanup = () => {
    try { if (readFileSync(path, "utf8").split("\n")[0] === String(pid)) rmSync(path, { force: true }); } catch { /* already gone */ }
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(130); });
  process.on("SIGTERM", () => { cleanup(); process.exit(143); });
}

export async function startSlackApp(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const problems = preflightProblems(env);
  if (problems.length) throw new Error(`sdk-app preflight failed:\n- ${problems.join("\n- ")}`);
  const { config, approvals, agent, audit } = await buildRuntime(env);
  acquireInstanceLock(config.auditLog.replace(/[^/]+$/, "slack-app.lock"));

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
    // Compact live status in the thread: working state with tool count and
    // elapsed, and an honest final state (done/failed/stopped - never "Done"
    // over unfinished work). Approval waiting is measured separately from
    // execution so speed claims never hide human time.
    const t0 = Date.now();
    let toolCalls = 0;
    let approvalWaitMs = 0;
    let cancelled = false;
    let statusTs: string | undefined;
    let lastStatusPush = 0;
    const elapsed = () => Math.round((Date.now() - t0) / 1000);
    const pushStatus = async (finalText?: string) => {
      if (!statusTs) return;
      const now = Date.now();
      if (!finalText && now - lastStatusPush < 4000) return;
      lastStatusPush = now;
      await bolt.client.chat.update({ channel: event.channel, ts: statusTs, text: finalText ?? `:hourglass_flowing_sand: Working... ${toolCalls} tool calls, ${elapsed()}s` }).catch(() => {});
    };
    try {
      const statusMsg = await say({ text: `:hourglass_flowing_sand: Working...`, thread_ts: thread });
      statusTs = (statusMsg as any)?.ts;
      await agent.chat(threadKey, text, {
        onText: (t) => { void sayThread(t); },
        onApprovalNeeded: (id, summary) => { void sayThread(`Approval needed (${id}): ${summary}\nReply in thread: approve ${id} / deny ${id}`); },
        onToolUse: () => { toolCalls++; void pushStatus(); },
        onApprovalResolved: (ms) => { approvalWaitMs += ms; },
        onCancelled: () => { cancelled = true; },
      }, {
        userId: event.user, surface: "slack", channelId: event.channel, images,
        emitImage: async (path, title) => {
          await bolt.client.filesUploadV2({ channel_id: event.channel, thread_ts: thread, file: readFileSync(path), filename: basename(path), title, initial_comment: title });
        },
      });
      const waitPart = approvalWaitMs > 1000 ? `, of which ~${Math.round(approvalWaitMs / 1000)}s waiting on approval` : "";
      await pushStatus(cancelled
        ? `:octagonal_sign: Stopped by user after ${elapsed()}s (${toolCalls} tool calls).`
        : `:white_check_mark: Done: ${toolCalls} tool calls, ${elapsed()}s total${waitPart}.`);
    } catch (err) {
      await pushStatus(`:x: Failed after ${elapsed()}s (${toolCalls} tool calls) - details above.`);
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
