#!/usr/bin/env tsx
/** Local harness: the same AgentCore the Slack adapter drives, over stdin/stdout.
 * Verification surface - proves the whole app (SDK loop, tools, approval gate,
 * audit) without posting to a real Slack workspace.
 * Commands: approve <id> | deny <id> | pending | quit. Anything else is a message.
 * Run: npx tsx sdk-app/src/cli.ts  (from the repo root, env per config.ts) */
import readline from "node:readline";
import { configFromEnv } from "./config.js";
import { AuditLog } from "./audit.js";
import { ApprovalStore } from "./approvals.js";
import { buildKitServer } from "./tools.js";
import { AgentCore } from "./agent.js";
import { createLineHandler } from "./harness.js";
import { FilesystemConnector } from "../../src/connectors/fs.js";
import { GitHubConnector } from "../../src/connectors/github.js";

const config = configFromEnv();
const audit = new AuditLog(config.auditLog);
const approvals = new ApprovalStore(config.approvalsLog);
const connectors = [new FilesystemConnector(config.docsRoot)];
if (config.githubRepos.length) connectors.push(new GitHubConnector(config.githubRepos) as any);
const agent = new AgentCore({ config, mcpServer: buildKitServer({ connectors, config, audit }), approvals, audit });
const handler = createLineHandler(agent, approvals, { print: (s) => console.log(s), printStream: (s) => process.stdout.write(`\x1b[36m${s}\x1b[0m`) }, "cli:local");

console.log(`sdk-app CLI harness (model=${config.model}, dryRun=${config.dryRun}, docs=${config.docsRoot})`);
const resurfaced = approvals.list();
if (resurfaced.length) console.log(`resurfaced pending approvals: ${resurfaced.map((r) => `${r.id} ${r.summary}`).join("; ")}`);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "you> " });
rl.on("line", (line) => {
  if (line.trim() === "quit") rl.close();
  else handler.onLine(line);
  rl.prompt();
});
rl.on("close", async () => { await handler.drain(); process.exit(0); });
rl.prompt();
