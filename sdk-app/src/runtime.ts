/** Shared surface wiring: both cli.ts and slack.ts build their AgentCore
 * through this so the two surfaces can never drift apart. */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { configFromEnv } from "./config.js";
import { AuditLog } from "./audit.js";
import { ApprovalStore } from "./approvals.js";
import { buildKitServer } from "./tools.js";
import { AgentCore, type QueryFn } from "./agent.js";
import { openRagStore } from "./rag-store.js";
import { BrowsePolicy, BrowseTools } from "./browse-tools.js";
import { FactoryTools } from "./factory-tools.js";
import { FilesystemConnector } from "../../src/connectors/fs.js";
import { GitHubConnector } from "../../src/connectors/github.js";

export async function buildRuntime(env: NodeJS.ProcessEnv = process.env, queryFn?: QueryFn) {
  const config = configFromEnv(env);
  mkdirSync(dirname(config.auditLog), { recursive: true });
  const audit = new AuditLog(config.auditLog);
  const approvals = new ApprovalStore(config.approvalsLog);
  const connectors = [new FilesystemConnector(config.docsRoot)];
  if (config.githubRepos.length) connectors.push(new GitHubConnector(config.githubRepos) as any);
  const ragStore = openRagStore(config.ragDb);
  // first-boot index so search_docs is ranked from the start; refresh via sync_docs
  if (ragStore.rag.count() === 0) {
    await ragStore.syncDocsRoot(config.docsRoot).catch(() => 0);
  }
  const browsePolicy = new BrowsePolicy(config.auditLog.replace(/[^/]+$/, "browse-allowlist.json"), config.browseAllowlist);
  const browse = new BrowseTools({ audit, policy: browsePolicy });
  const factory = new FactoryTools({ config, audit });
  const mcpServer = buildKitServer({ connectors, config, audit, ragStore, browse, factory });
  const agent = new AgentCore({ config, mcpServer, approvals, audit, queryFn, browsePolicy });
  const close = async () => { await browse.close(); ragStore.rag.close(); };
  return { config, audit, approvals, agent, ragStore, browsePolicy, close };
}
