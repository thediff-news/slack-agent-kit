/** Config-driven connector wiring, ported from the kit's kit.ts: a JSON
 * settings array builds connectors; SaaS connectors are env-gated and
 * disable with a warning (never a failure) when credentials are missing. */
import type { Connector } from "../../src/connectors/types.js";
import { FilesystemConnector } from "../../src/connectors/fs.js";
import { GitHubConnector } from "../../src/connectors/github.js";
import { WebConnector } from "../../src/connectors/web.js";
import { SlackHistoryConnector } from "../../src/connectors/slack-history.js";
import { JiraConnector } from "../../src/connectors/jira.js";
import { ConfluenceConnector } from "../../src/connectors/confluence.js";
import { NotionConnector } from "../../src/connectors/notion.js";

export type ConnectorCfg = {
  type: "filesystem" | "github" | "web" | "slack-history" | "jira" | "confluence" | "notion";
  root?: string;
  repos?: string;
  channels?: string;
  site?: string;
  acl?: string;
};

const split = (v?: string) => (v || "").split(",").map((s) => s.trim()).filter(Boolean);

export function buildConnectors(
  settings: ConnectorCfg[],
  env: NodeJS.ProcessEnv,
  fallback: { docsRoot: string; githubRepos: string[] },
  warn: (msg: string) => void = (m) => console.warn(m),
): Connector[] {
  // Backward-compatible default: no settings = legacy fs + github env config.
  const list: ConnectorCfg[] = settings.length
    ? settings
    : [
        { type: "filesystem", root: fallback.docsRoot },
        ...(fallback.githubRepos.length ? [{ type: "github" as const, repos: fallback.githubRepos.join(",") }] : []),
      ];
  const out: Connector[] = [];
  for (const cfg of list) {
    switch (cfg.type) {
      case "filesystem":
        out.push(new FilesystemConnector(cfg.root ?? fallback.docsRoot));
        break;
      case "github":
        out.push(new GitHubConnector(split(cfg.repos)) as any);
        break;
      case "web":
        out.push(new WebConnector(cfg.acl ?? "public"));
        break;
      case "slack-history": {
        const token = env.SLACK_BOT_TOKEN ?? "";
        if (token) out.push(new SlackHistoryConnector(token, split(cfg.channels), cfg.acl ?? "public"));
        else warn(`[connectors] slack-history: SLACK_BOT_TOKEN missing - disabled`);
        break;
      }
      case "jira":
      case "confluence": {
        const site = cfg.site ?? env.ATLASSIAN_SITE ?? "";
        const email = env.ATLASSIAN_EMAIL ?? "";
        const token = env.ATLASSIAN_API_TOKEN ?? "";
        if (site && email && token) {
          out.push(cfg.type === "jira" ? new JiraConnector(site, email, token, cfg.acl) : new ConfluenceConnector(site, email, token, cfg.acl));
        } else {
          warn(`[connectors] ${cfg.type}: ATLASSIAN_SITE/ATLASSIAN_EMAIL/ATLASSIAN_API_TOKEN missing - disabled`);
        }
        break;
      }
      case "notion": {
        const key = env.NOTION_API_KEY ?? "";
        if (key) out.push(new NotionConnector(key, cfg.acl));
        else warn(`[connectors] notion: NOTION_API_KEY missing - disabled`);
        break;
      }
      default:
        warn(`[connectors] unknown type ${(cfg as any).type} - skipped`);
    }
  }
  return out;
}
