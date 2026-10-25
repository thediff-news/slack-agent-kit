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
  const browseHolder: { b?: BrowseTools } = {};
  const factory = new FactoryTools({
    config,
    audit,
    pageState: async () => {
      const b = browseHolder.b;
      if (!b) return undefined;
      const url = await b.currentUrl().catch(() => "");
      if (!url || url === "about:blank") return undefined;
      return { url, text: await b.pageText().catch(() => "") };
    },
  });
  const browse = new BrowseTools({ audit, policy: browsePolicy, onEvidence: (url, kind) => { void factory.noteBrowseEvidence(url, kind); } });
  browseHolder.b = browse;
  // Per-turn server: the requester's ACL tags ride into search/get_doc, so a
  // Slack user only ever sees docs their identity may read (unknown = public).
  const mcpServerFactory = (ctx: { userId?: string; surface?: "cli" | "slack"; threadKey?: string; images?: unknown[]; emitImage?: (path: string, title: string) => Promise<void> }) =>
    buildKitServer({ connectors, config, audit, ragStore, browse, factory, emitImage: ctx.emitImage, aclTags: ctx.surface === "slack" ? config.aclTagsFor(ctx.userId) : undefined, turnCtx: { threadKey: ctx.threadKey, hasImages: Array.isArray(ctx.images) && ctx.images.length > 0 } });
  const agent = new AgentCore({ config, mcpServerFactory, approvals, audit, queryFn, browsePolicy, factory });
  const close = async () => { await browse.close(); await factory.close(); ragStore.rag.close(); };
  return { config, audit, approvals, agent, ragStore, browsePolicy, factory, close };
}
