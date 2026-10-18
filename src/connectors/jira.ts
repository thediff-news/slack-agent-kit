import type { Connector, ConnectorDoc } from "./types.js";
import { adfToText } from "./text.js";

/**
 * Jira Cloud connector (read-only): JQL issue search + single issue fetch.
 * Verified against the current Jira Cloud REST v3 docs:
 *   GET /rest/api/3/search/jql   (enhanced JQL search; the old GET
 *                                /rest/api/3/search is being removed)
 *   GET /rest/api/3/issue/{key}
 * Auth: HTTP Basic, base64(email:api-token), per Atlassian's basic-auth doc.
 * The token inherits the Atlassian account's permissions - the kit maps
 * nothing; every doc carries this connector's configured default ACL.
 */
export class JiraConnector implements Connector {
  name = "jira";

  constructor(
    private site: string, // e.g. https://yourteam.atlassian.net
    private email: string,
    private apiToken: string,
    private defaultAcl = "jira",
  ) {
    this.site = site.replace(/\/+$/, "");
  }

  private headers(): Record<string, string> {
    return {
      Authorization: "Basic " + Buffer.from(`${this.email}:${this.apiToken}`).toString("base64"),
      Accept: "application/json",
    };
  }

  async search(query: string, limit = 10): Promise<ConnectorDoc[]> {
    // "jql: project = FOO ..." runs raw JQL; anything else is a text search.
    const jql = query.startsWith("jql:")
      ? query.slice(4).trim()
      : `text ~ "${query.replace(/"/g, '\\"')}" ORDER BY updated DESC`;
    const docs: ConnectorDoc[] = [];
    let nextPageToken: string | undefined;
    do {
      const pageSize = Math.min(limit - docs.length, 100);
      const params = new URLSearchParams({ jql, maxResults: String(pageSize), fields: "summary,description,status,priority,updated,issuetype" });
      if (nextPageToken) params.set("nextPageToken", nextPageToken);
      const res = await fetch(`${this.site}/rest/api/3/search/jql?${params}`, { headers: this.headers() });
      if (!res.ok) return docs; // unreachable/forbidden: skip, never fail the investigation
      const data = (await res.json()) as any;
      for (const issue of data.issues ?? []) docs.push(this.toDoc(issue));
      nextPageToken = data.isLast === false ? data.nextPageToken : undefined;
    } while (nextPageToken && docs.length < limit);
    return docs.slice(0, limit);
  }

  async get(id: string): Promise<ConnectorDoc | undefined> {
    const key = id.trim().toUpperCase();
    const res = await fetch(`${this.site}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description,status,priority,updated,issuetype`, { headers: this.headers() });
    if (!res.ok) return undefined;
    return this.toDoc((await res.json()) as any);
  }

  private toDoc(issue: any): ConnectorDoc {
    const f = issue.fields ?? {};
    const body = [
      `Status: ${f.status?.name ?? "?"} | Priority: ${f.priority?.name ?? "?"} | Type: ${f.issuetype?.name ?? "?"} | Updated: ${f.updated ?? "?"}`,
      "",
      adfToText(f.description).trim(),
    ].join("\n").trim();
    return {
      id: issue.key,
      title: `${issue.key}: ${f.summary ?? ""}`,
      body,
      url: `${this.site}/browse/${issue.key}`,
      acl: this.defaultAcl,
    };
  }
}
