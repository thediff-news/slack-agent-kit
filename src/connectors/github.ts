import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ConnectorDoc, SyncableConnector, SyncedDoc, SyncListing } from "./types.js";

const run = promisify(execFile);

/**
 * GitHub connector over the `gh` CLI (read-only commands only): code
 * search, issue/PR search, file reads, and issue/PR reads in the configured
 * repos. Auth comes from the caller's environment - the kit never stores
 * tokens.
 *
 * Document IDs:
 *  - thediff-news/slack-agent-kit/README.md   (file in repo)
 *  - thediff-news/slack-agent-kit/issues/3    (issue)
 *  - thediff-news/slack-agent-kit/pull/7      (pull request)
 */
export class GitHubConnector implements SyncableConnector {
  name = "github";

  constructor(private repos: string[]) {}

  async search(query: string, limit = 10): Promise<ConnectorDoc[]> {
    const docs: ConnectorDoc[] = [];
    for (const repo of this.repos) {
      try {
        const { stdout } = await run("gh", ["search", "code", query, "--repo", repo, "--limit", String(limit), "--json", "path,url,repository"]);
        for (const hit of JSON.parse(stdout)) {
          docs.push({
            id: `${repo}/${hit.path}`,
            title: hit.path,
            body: "", // body filled by get()
            url: hit.url,
          });
        }
      } catch {
        // repo unreachable or gh unauthenticated: skip, do not fail the investigation
      }
      try {
        const { stdout } = await run("gh", ["search", "issues", query, "--repo", repo, "--include-prs", "--limit", String(limit), "--json", "number,title,url,isPullRequest"]);
        for (const hit of JSON.parse(stdout)) {
          const kind = hit.isPullRequest ? "pull" : "issues";
          docs.push({
            id: `${repo}/${kind}/${hit.number}`,
            title: `#${hit.number} ${hit.title}`,
            body: "", // body filled by get()
            url: hit.url,
          });
        }
      } catch {
        // same skip rule as code search
      }
    }
    return docs.slice(0, limit);
  }

  /** Sync listing: open+closed ISSUES per configured repo (PRs excluded),
   * updated-since cursor when given. Incremental-only: the listing is never
   * treated as complete, so deleted issues are not reconciled (see
   * docs/SYNC.md). Initial crawl is capped at 30 issues per repo. */
  async list(since?: string): Promise<SyncListing> {
    const docs: SyncedDoc[] = [];
    for (const repo of this.repos) {
      try {
        const args = ["api", `repos/${repo}/issues?state=all&per_page=${since ? 100 : 30}`, "--paginate"];
        const { stdout } = await run("gh", args);
        const issues = JSON.parse(`[${stdout.trim().replace(/\]\s*\[/g, ",").replace(/^[\s\[]+|[\s\]]+$/g, "")}]`.replace(/^\[\[/, "[").replace(/\]\]$/, "]")) as any[];
        for (const issue of issues) {
          if (issue.pull_request) continue;
          if (since && issue.updated_at && issue.updated_at <= since) continue;
          docs.push({
            id: `${repo}/issues/${issue.number}`,
            title: `#${issue.number} ${issue.title}`,
            body: `State: ${issue.state} | Updated: ${issue.updated_at}\n\n${issue.body ?? ""}`,
            url: issue.html_url,
            lastModified: issue.updated_at,
          });
        }
      } catch {
        // repo unreachable or gh unauthenticated: skip, never fail the sync
      }
    }
    return { docs, complete: false };
  }

  async get(id: string): Promise<ConnectorDoc | undefined> {
    const slash = id.indexOf("/");
    const second = id.indexOf("/", slash + 1);
    const repo = id.slice(0, second);
    const path = id.slice(second + 1);
    // Issues and PRs share the issues API endpoint.
    const num = /^(?:issues|pull)\/(\d+)$/.exec(path)?.[1];
    if (num) {
      try {
        const { stdout } = await run("gh", ["api", `repos/${repo}/issues/${num}`]);
        const d = JSON.parse(stdout);
        const kind = d.pull_request ? "pull" : "issues";
        const body = `#${d.number} ${d.title} (${d.state})\n\n${d.body ?? "(no body)"}`;
        return { id, title: `#${d.number} ${d.title}`, body, url: `https://github.com/${repo}/${kind}/${d.number}` };
      } catch {
        return undefined;
      }
    }
    try {
      const { stdout } = await run("gh", ["api", `repos/${repo}/contents/${path}`, "-H", "Accept: application/vnd.github.raw"]);
      return { id, title: path, body: stdout, url: `https://github.com/${repo}/blob/main/${path}` };
    } catch {
      return undefined;
    }
  }
}
