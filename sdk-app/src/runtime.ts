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
import { buildConnectors } from "./connectors.js";

export async function buildRuntime(env: NodeJS.ProcessEnv = process.env, queryFn?: QueryFn) {
  const config = configFromEnv(env);
  mkdirSync(dirname(config.auditLog), { recursive: true });
  const audit = new AuditLog(config.auditLog);
  const approvals = new ApprovalStore(config.approvalsLog);
  const connectors = buildConnectors(config.connectors, env, { docsRoot: config.docsRoot, githubRepos: config.githubRepos });
  const ragStore = openRagStore(config.ragDb);
  // first-boot index so search_docs is ranked from the start; refresh via sync_docs
  if (ragStore.rag.count() === 0) {
    await ragStore.syncDocsRoot(config.docsRoot).catch(() => 0);
  }
  const browsePolicy = new BrowsePolicy(config.auditLog.replace(/[^/]+$/, "browse-allowlist.json"), config.browseAllowlist);
  const browse = new BrowseTools({ audit, policy: browsePolicy });
  const factory = new FactoryTools({ config, audit });
  // Per-turn server: the requester's ACL tags ride into search/get_doc, so a
  // Slack user only ever sees docs their identity may read (unknown = public).
  const mcpServerFactory = (ctx: { userId?: string; surface?: "cli" | "slack" }) =>
    buildKitServer({ connectors, config, audit, ragStore, browse, factory, aclTags: ctx.surface === "slack" ? config.aclTagsFor(ctx.userId) : undefined });
  const agent = new AgentCore({ config, mcpServerFactory, approvals, audit, queryFn, browsePolicy, factory });
  const close = async () => { await browse.close(); ragStore.rag.close(); };
  return { config, audit, approvals, agent, ragStore, browsePolicy, close };
}
