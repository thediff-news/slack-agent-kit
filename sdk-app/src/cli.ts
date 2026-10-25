#!/usr/bin/env tsx
/** Local harness: the same AgentCore the Slack adapter drives, over stdin/stdout.
 * This is the verification surface - it proves the whole app (SDK loop, tools,
 * approval gate, audit) without posting anything to a real Slack workspace.
 *
 * Commands: approve <id> | deny <id> | pending | quit. Anything else is a message.
 * Run: npx tsx sdk-app/src/cli.ts  (from the repo root, env per config.ts) */
import readline from "node:readline";
import { configFromEnv } from "./config.js";
import { AuditLog } from "./audit.js";
import { ApprovalStore } from "./approvals.js";
import { buildKitServer } from "./tools.js";
import { AgentCore } from "./agent.js";
import { FilesystemConnector } from "../../src/connectors/fs.js";
import { GitHubConnector } from "../../src/connectors/github.js";

const config = configFromEnv();
const audit = new AuditLog(config.auditLog);
const approvals = new ApprovalStore(config.approvalsLog);
const connectors = [new FilesystemConnector(config.docsRoot)];
if (config.githubRepos.length) connectors.push(new GitHubConnector(config.githubRepos) as any);
const agent = new AgentCore({ config, mcpServer: buildKitServer({ connectors, config, audit }), approvals, audit });

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "you> " });
const THREAD = "cli:local";

console.log(`sdk-app CLI harness (model=${config.model}, dryRun=${config.dryRun}, docs=${config.docsRoot})`);
const resurfaced = approvals.list();
if (resurfaced.length) console.log(`resurfaced pending approvals: ${resurfaced.map((r) => `${r.id} ${r.summary}`).join("; ")}`);
rl.prompt();

for await (const line of rl) {
  const text = line.trim();
  if (!text) { rl.prompt(); continue; }
  const m = /^(approve|deny)\s+(\S+)$/i.exec(text);
  if (m) {
    const ok = approvals.resolve(m[2], m[1].toLowerCase() === "approve", "cli-user");
    console.log(ok ? `${m[1]}ed ${m[2]}` : `no pending approval ${m[2]}`);
  } else if (text === "pending") {
    console.log(approvals.list().map((r) => `${r.id}: ${r.summary}`).join("\n") || "(none)");
  } else if (text === "quit") {
    break;
  } else {
    try {
      await agent.chat(THREAD, text, {
        onText: (t) => process.stdout.write(`\x1b[36m${t}\x1b[0m`),
        onApprovalNeeded: (id, summary) => console.log(`\n[approval needed] ${id}: ${summary}\nreply: approve ${id} / deny ${id}`),
      });
      console.log();
    } catch (e) {
      console.log(`[error] ${String(e).slice(0, 200)}`);
    }
  }
  rl.prompt();
}
process.exit(0);
