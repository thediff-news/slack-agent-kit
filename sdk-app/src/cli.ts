#!/usr/bin/env tsx
/** Local harness: the same AgentCore the Slack adapter drives, over stdin/stdout.
 * Commands: approve <id> | deny <id> | pending | quit. Anything else is a message.
 * Run: npx tsx sdk-app/src/cli.ts  (from the repo root, env per config.ts) */
import readline from "node:readline";
import { buildRuntime } from "./runtime.js";
import { createLineHandler } from "./harness.js";

const { config, approvals, agent, close } = await buildRuntime();
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
rl.on("close", async () => { await handler.drain(); await close(); process.exit(0); });
rl.prompt();
