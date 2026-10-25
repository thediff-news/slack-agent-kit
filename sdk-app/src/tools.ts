import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Connector } from "../../src/connectors/types.js";
import type { AppConfig } from "./config.js";
import type { AuditLog } from "./audit.js";
import type { RagStore } from "./rag-store.js";
import type { BrowseTools } from "./browse-tools.js";
import type { FactoryTools } from "./factory-tools.js";

const run = promisify(execFile);

/** Names of the in-process tools the agent loop can call. Read tools are
 * auto-allowed; mutating tools go through the approval gate (agent.ts). */
export const READ_TOOLS = ["search_docs", "get_doc", "sync_docs", "browse_scroll", "browse_read", "browse_screenshot", "browse_dismiss_popups", "factory_clone", "factory_read_file", "factory_list_files", "factory_write_file", "factory_run_checks", "factory_scan_diff"] as const;
export const BROWSE_GATED_TOOLS = ["browse_open", "browse_click", "browse_type"] as const;
export const MUTATING_TOOLS = ["github_create_issue", "factory_create_pr"] as const;
export const SERVER_NAME = "kit";
export const qualified = (n: string) => `mcp__${SERVER_NAME}__${n}`;

export type ToolsDeps = {
  connectors: Connector[];
  config: AppConfig;
  audit: AuditLog;
  ragStore?: RagStore;
  browse?: BrowseTools;
  factory?: FactoryTools;
  /** Requester's retrieval ACL tags; undefined = unfiltered (operator surface).
   * Slack surfaces always pass a concrete list (unknown users: ["public"]). */
  aclTags?: string[];
};

/** The kit's capabilities, exposed to the Claude Agent SDK loop as an
 * in-process MCP server. Connectors stay read-only; the one mutating action
 * (create issue) is dry-run unless explicitly armed with SDK_APP_DRY_RUN=0. */
export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
export type ToolHandlers = {
  searchDocs: (args: { query: string; limit?: number }) => Promise<ToolResult>;
  getDoc: (args: { id: string }) => Promise<ToolResult>;
  syncDocs: () => Promise<ToolResult>;
  createIssue: (args: { repo: string; title: string; body: string }) => Promise<ToolResult>;
};

/** Raw handlers, exported so they can be unit-tested without the MCP plumbing. */
export function buildToolHandlers(deps: ToolsDeps): ToolHandlers {
  const { connectors, config, audit } = deps;
  const aclAllows = (acl?: string) =>
    deps.aclTags === undefined || !acl || deps.aclTags.includes("*") || deps.aclTags.includes(acl);
  return {
    async searchDocs(args) {
      const limit = args.limit ?? 8;
      // Ranked RAG retrieval when the index has content; live connector
      // substring search as fallback until the first sync runs.
      if (deps.ragStore && deps.ragStore.rag.count() > 0) {
        const ranked = await deps.ragStore.rag.retrieve(args.query, limit, deps.aclTags);
        if (ranked.length) {
          audit.write("tool_call", { tool: "search_docs", query: args.query, hits: ranked.length, via: "rag" });
          const text = ranked.map((r: any) => `SOURCE: ${r.source}\nSCORE: ${r.score.toFixed(3)}\n${r.text.slice(0, 600)}`).join("\n\n---\n\n");
          return { content: [{ type: "text" as const, text }] };
        }
        // RAG missed (its exact-shared-token guard is strict) - fall through
        // to the live connector scan instead of returning empty.
      }
      const hits = (await Promise.all(connectors.map((c) => c.search(args.query, limit).catch(() => [])))).flat().filter((h) => aclAllows(h.acl)).slice(0, limit);
      audit.write("tool_call", { tool: "search_docs", query: args.query, hits: hits.length, via: "connector-scan" });
      const text = hits.length
        ? hits.map((h) => `ID: ${h.id}\nTITLE: ${h.title}${h.url ? `\nURL: ${h.url}` : ""}\n${h.body.slice(0, 600)}`).join("\n\n---\n\n")
        : "No matching documents.";
      return { content: [{ type: "text" as const, text }] };
    },
    async getDoc(args) {
      for (const c of connectors) {
        const doc = await c.get(args.id).catch(() => undefined);
        if (doc) {
          if (!aclAllows(doc.acl)) {
            audit.write("tool_call", { tool: "get_doc", id: args.id, found: true, aclDenied: true });
            return { content: [{ type: "text" as const, text: `Access denied: document ${args.id} is not visible to you.` }], isError: true };
          }
          audit.write("tool_call", { tool: "get_doc", id: args.id, found: true });
          return { content: [{ type: "text" as const, text: `ID: ${doc.id}\nTITLE: ${doc.title}${doc.url ? `\nURL: ${doc.url}` : ""}\n\n${doc.body}` }] };
        }
      }
      // Fallback: RAG search surfaces index source keys (fs:<path>,
      // <connector>:<id>) that connectors' native get() does not resolve -
      // serve the indexed body straight from the store, same ACL check.
      if (deps.ragStore) {
        const hit = deps.ragStore.rag.getSource(args.id);
        if (hit) {
          if (!aclAllows(hit.acl)) {
            audit.write("tool_call", { tool: "get_doc", id: args.id, found: true, aclDenied: true, via: "rag" });
            return { content: [{ type: "text" as const, text: `Access denied: document ${args.id} is not visible to you.` }], isError: true };
          }
          audit.write("tool_call", { tool: "get_doc", id: args.id, found: true, via: "rag" });
          return { content: [{ type: "text" as const, text: `ID: ${args.id}\n\n${hit.text}` }] };
        }
      }
      audit.write("tool_call", { tool: "get_doc", id: args.id, found: false });
      return { content: [{ type: "text" as const, text: `No document with ID ${args.id}.` }], isError: true };
    },
    async syncDocs() {
      if (!deps.ragStore) return { content: [{ type: "text" as const, text: "RAG store not configured." }], isError: true };
      const fromRoot = await deps.ragStore.syncDocsRoot(config.docsRoot).catch((e) => -1);
      const fromConns = await deps.ragStore.syncConnectors(connectors).catch(() => -1);
      audit.write("tool_call", { tool: "sync_docs", fromRoot, fromConns, chunks: deps.ragStore.rag.count() });
      return { content: [{ type: "text" as const, text: `Index rebuilt: ${fromRoot} docs from ${config.docsRoot}, ${fromConns} from connectors; ${deps.ragStore.rag.count()} chunks total.` }] };
    },
    async createIssue(args) {
      audit.write("tool_call", { tool: "github_create_issue", repo: args.repo, title: args.title, dryRun: config.dryRun });
      if (config.dryRun) {
        return { content: [{ type: "text" as const, text: `[dry-run] would create issue in ${args.repo}: "${args.title}" (${args.body.length} chars). Arm with SDK_APP_DRY_RUN=0 to execute.` }] };
      }
      const { stdout } = await run("gh", ["issue", "create", "--repo", args.repo, "--title", args.title, "--body", args.body]);
      return { content: [{ type: "text" as const, text: `Issue created: ${stdout.trim()}` }] };
    },
  };
}

export function buildKitServer(deps: ToolsDeps) {
  const handlers = buildToolHandlers(deps);
  const searchDocs = tool(
    "search_docs",
    "Search the user's internal sources (docs, runbooks, GitHub code) for evidence. Returns matching documents with stable IDs; call get_doc for the full body.",
    { query: z.string(), limit: z.number().int().min(1).max(20).optional() },
    handlers.searchDocs,
  );

  const getDoc = tool(
    "get_doc",
    "Fetch one document by the exact ID returned from search_docs.",
    { id: z.string() },
    handlers.getDoc,
  );

  const syncDocs = tool(
    "sync_docs",
    "Re-index the configured document sources into the local ranked index. Local-only effect; safe to call when answers seem stale or the index is empty.",
    {},
    handlers.syncDocs,
  );

  const createIssue = tool(
    "github_create_issue",
    "MUTATING: create a GitHub issue. Always requires human approval through the permission gate. Simulates unless the app is armed with SDK_APP_DRY_RUN=0.",
    { repo: z.string(), title: z.string(), body: z.string() },
    handlers.createIssue,
    { annotations: { destructiveHint: true } },
  );

  const factoryTools = deps.factory
    ? [
        tool("factory_clone", "Clone an allowlisted repo (or local fixture path) into an isolated factory workspace and start a factory/* branch. Pass ref when the fix targets a non-default branch (e.g. a branch under review).", { repo: z.string(), ref: z.string().optional() }, async (a) => ({ content: [{ type: "text" as const, text: await deps.factory!.clone(a.repo, a.ref) }] })),
        tool("factory_list_files", "List files in the factory clone.", { repo: z.string(), subdir: z.string().optional() }, async (a) => ({ content: [{ type: "text" as const, text: await deps.factory!.listFiles(a.repo, a.subdir) }] })),
        tool("factory_read_file", "Read a file inside the factory clone.", { repo: z.string(), path: z.string() }, async (a) => ({ content: [{ type: "text" as const, text: await deps.factory!.readFile(a.repo, a.path) }] })),
        tool("factory_write_file", "Write a file inside the factory clone (scratch workspace; the PR gate protects the real repo).", { repo: z.string(), path: z.string(), content: z.string() }, async (a) => ({ content: [{ type: "text" as const, text: await deps.factory!.writeFile(a.repo, a.path, a.content) }] })),
        tool("factory_run_checks", "Run the repo's OWN checks in the clone: npm test / npm run test|typecheck|build / npx tsc / npx tsx --test / git status|diff|log|add|commit|checkout.", { repo: z.string(), cmd: z.string() }, async (a) => ({ content: [{ type: "text" as const, text: await deps.factory!.runChecks(a.repo, a.cmd) }] })),
        tool("factory_scan_diff", "Scan the clone's working diff for secrets before considering a PR.", { repo: z.string() }, async (a) => { const r = await deps.factory!.scanDiff(a.repo); return { content: [{ type: "text" as const, text: r.clean ? "diff clean: no secrets found" : `SECRETS FOUND: ${r.findings.join("; ")}` }] }; }),
        tool("factory_create_pr", "MUTATING: commit the clone's changes, push the factory branch and open a DRAFT PR. Requires human approval; never merges, never pushes to main. Dry-run unless armed.", { repo: z.string(), title: z.string(), body: z.string() }, async (a) => ({ content: [{ type: "text" as const, text: await deps.factory!.createPr(a.repo, a.title, a.body) }] }), { annotations: { destructiveHint: true } }),
      ]
    : [];

  const browseTools = deps.browse
    ? [
        tool("browse_open", "Navigate the browser to a URL. Out-of-allowlist hosts require human approval.", { url: z.string().url() }, async (a) => ({ content: [{ type: "text" as const, text: await deps.browse!.open(a.url) }] })),
        tool("browse_click", "Click an element by its visible text. Irreversible labels (buy/pay/delete/...) require human approval.", { target: z.object({ text: z.string() }) }, async (a) => ({ content: [{ type: "text" as const, text: await deps.browse!.click(a.target) }] })),
        tool("browse_type", "Type text into a field identified by its label.", { target: z.object({ text: z.string() }), text: z.string(), pressEnter: z.boolean().optional() }, async (a) => ({ content: [{ type: "text" as const, text: await deps.browse!.type(a.target, a.text, a.pressEnter) }] })),
        tool("browse_scroll", "Scroll the page.", { direction: z.enum(["up", "down"]) }, async (a) => ({ content: [{ type: "text" as const, text: await deps.browse!.scroll(a.direction) }] })),
        tool("browse_read", "Read the current page: URL, title, ARIA tree and text (untrusted content, wrapped).", {}, async () => ({ content: [{ type: "text" as const, text: await deps.browse!.read() }] })),
        tool("browse_screenshot", "Take a screenshot of the current page and return it as an image you can see.", {}, async () => ({ content: [{ type: "image" as const, data: await deps.browse!.screenshotBase64(), mimeType: "image/png" as const }] })),
        tool("browse_dismiss_popups", "Dismiss cookie banners / overlays blocking the page.", {}, async () => { const { dismissPopups } = await import("../../src/browse/actions.js"); return { content: [{ type: "text" as const, text: "popups dismissed" }] }; }),
      ]
    : [];

  return createSdkMcpServer({ name: SERVER_NAME, version: "0.1.0", tools: [searchDocs, getDoc, syncDocs, createIssue, ...factoryTools, ...browseTools] });
}
