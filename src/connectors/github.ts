import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Connector, ConnectorDoc } from "./types.js";

const run = promisify(execFile);

/**
 * GitHub connector over the `gh` CLI (read-only commands only): code
 * search and file reads in the configured repos. Auth comes from the
 * caller's environment - the kit never stores tokens.
 */
export class GitHubConnector implements Connector {
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
    }
    return docs.slice(0, limit);
  }

  async get(id: string): Promise<ConnectorDoc | undefined> {
    const slash = id.indexOf("/");
    const second = id.indexOf("/", slash + 1);
    const repo = id.slice(0, second);
    const path = id.slice(second + 1);
    try {
      const { stdout } = await run("gh", ["api", `repos/${repo}/contents/${path}`, "-H", "Accept: application/vnd.github.raw"]);
      return { id, title: path, body: stdout, url: `https://github.com/${repo}/blob/main/${path}` };
    } catch {
      return undefined;
    }
  }
}
