import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Connector } from "../../src/connectors/types.js";
import type { AppConfig } from "./config.js";
import type { AuditLog } from "./audit.js";

const run = promisify(execFile);

/** Names of the in-process tools the agent loop can call. Read tools are
 * auto-allowed; mutating tools go through the approval gate (agent.ts). */
export const READ_TOOLS = ["search_docs", "get_doc"] as const;
export const MUTATING_TOOLS = ["github_create_issue"] as const;
export const SERVER_NAME = "kit";
export const qualified = (n: string) => `mcp__${SERVER_NAME}__${n}`;

export type ToolsDeps = {
  connectors: Connector[];
  config: AppConfig;
  audit: AuditLog;
};

/** The kit's capabilities, exposed to the Claude Agent SDK loop as an
 * in-process MCP server. Connectors stay read-only; the one mutating action
 * (create issue) is dry-run unless explicitly armed with SDK_APP_DRY_RUN=0. */
export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
export type ToolHandlers = {
  searchDocs: (args: { query: string; limit?: number }) => Promise<ToolResult>;
  getDoc: (args: { id: string }) => Promise<ToolResult>;
  createIssue: (args: { repo: string; title: string; body: string }) => Promise<ToolResult>;
};

/** Raw handlers, exported so they can be unit-tested without the MCP plumbing. */
export function buildToolHandlers(deps: ToolsDeps): ToolHandlers {
  const { connectors, config, audit } = deps;
  return {
    async searchDocs(args) {
      const limit = args.limit ?? 8;
      const hits = (await Promise.all(connectors.map((c) => c.search(args.query, limit).catch(() => [])))).flat().slice(0, limit);
      audit.write("tool_call", { tool: "search_docs", query: args.query, hits: hits.length });
      const text = hits.length
        ? hits.map((h) => `ID: ${h.id}\nTITLE: ${h.title}${h.url ? `\nURL: ${h.url}` : ""}\n${h.body.slice(0, 600)}`).join("\n\n---\n\n")
        : "No matching documents.";
      return { content: [{ type: "text" as const, text }] };
    },
    async getDoc(args) {
      for (const c of connectors) {
        const doc = await c.get(args.id).catch(() => undefined);
        if (doc) {
          audit.write("tool_call", { tool: "get_doc", id: args.id, found: true });
          return { content: [{ type: "text" as const, text: `ID: ${doc.id}\nTITLE: ${doc.title}${doc.url ? `\nURL: ${doc.url}` : ""}\n\n${doc.body}` }] };
        }
      }
      audit.write("tool_call", { tool: "get_doc", id: args.id, found: false });
      return { content: [{ type: "text" as const, text: `No document with ID ${args.id}.` }], isError: true };
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

  const createIssue = tool(
    "github_create_issue",
    "MUTATING: create a GitHub issue. Always requires human approval through the permission gate. Simulates unless the app is armed with SDK_APP_DRY_RUN=0.",
    { repo: z.string(), title: z.string(), body: z.string() },
    handlers.createIssue,
    { annotations: { destructiveHint: true } },
  );

  return createSdkMcpServer({ name: SERVER_NAME, version: "0.1.0", tools: [searchDocs, getDoc, createIssue] });
}
