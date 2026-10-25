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
import { configFromEnv } from "./config.js";
import { AuditLog } from "./audit.js";
import { ApprovalStore } from "./approvals.js";
import { buildKitServer } from "./tools.js";
import { AgentCore } from "./agent.js";
import { FilesystemConnector } from "../../src/connectors/fs.js";
import { GitHubConnector } from "../../src/connectors/github.js";

export async function startSlackApp(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = configFromEnv(env);
  const audit = new AuditLog(config.auditLog);
  const approvals = new ApprovalStore(config.approvalsLog);
  const connectors = [new FilesystemConnector(config.docsRoot)];
  if (config.githubRepos.length) connectors.push(new GitHubConnector(config.githubRepos) as any);
  const agent = new AgentCore({ config, mcpServer: buildKitServer({ connectors, config, audit }), approvals, audit });

  const bolt = new App({ token: env.SLACK_BOT_TOKEN, appToken: env.SLACK_APP_TOKEN, socketMode: true });

  const handle = async (event: any, say: any) => {
    if (event.bot_id || event.subtype) return;
    const thread = event.thread_ts ?? event.ts;
    const threadKey = `${event.channel}:${thread}`;
    const text: string = (event.text ?? "").replace(/<@[A-Z0-9]+>/g, "").trim();
    const sayThread = (message: string) => say({ text: message, thread_ts: thread });

    const m = /^(approve|deny)\s+(\S+)$/i.exec(text);
    if (m) {
      // Named approvers only (kit RBAC carried over): SDK_APP_APPROVERS is a
      // comma-separated list of Slack user IDs. Anyone else is ignored.
      const approvers = (env.SDK_APP_APPROVERS || "").split(",").map((x) => x.trim()).filter(Boolean);
      if (!approvers.length || !approvers.includes(event.user ?? "")) {
        await sayThread("You are not a named approver for this app.");
        return;
      }
      // Thread binding: the decision must come from the same Slack thread the
      // request was made in - nobody can approve from another channel/DM.
      const r = approvals.resolve(m[2], m[1].toLowerCase() === "approve", event.user ?? "slack-user", threadKey);
      await sayThread(r === "resolved" ? `${m[1]}ed ${m[2]}.` : r === "wrong-thread" ? `Approval ${m[2]} belongs to another conversation.` : `No pending approval ${m[2]}.`);
      return;
    }
    await agent.chat(threadKey, text, {
      onText: (t) => { void sayThread(t); },
      onApprovalNeeded: (id, summary) => { void sayThread(`Approval needed (${id}): ${summary}\nReply in thread: approve ${id} / deny ${id}`); },
    });
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
