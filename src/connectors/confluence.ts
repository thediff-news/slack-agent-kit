import type { Connector, ConnectorDoc } from "./types.js";
import { htmlToText } from "./text.js";

/**
 * Confluence Cloud connector (read-only): CQL content search + page fetch.
 * Verified against the current Confluence Cloud REST v1 docs:
 *   GET /wiki/rest/api/content/search?cql=...&expand=body.storage
 *   GET /wiki/rest/api/content/{id}?expand=body.storage,space,version
 * Auth: HTTP Basic, base64(email:api-token) - same Atlassian credentials as
 * the Jira connector. Page restrictions are not mapped; every doc carries
 * this connector's configured default ACL.
 */
export class ConfluenceConnector implements Connector {
  name = "confluence";

  constructor(
    private site: string, // e.g. https://yourteam.atlassian.net
    private email: string,
    private apiToken: string,
    private defaultAcl = "confluence",
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
    // "cql: ..." runs raw CQL; anything else is a full-text page search.
    const cql = query.startsWith("cql:")
      ? query.slice(4).trim()
      : `type = page AND text ~ "${query.replace(/"/g, '\\"')}"`;
    const docs: ConnectorDoc[] = [];
    let start = 0;
    do {
      const params = new URLSearchParams({
        cql,
        limit: String(Math.min(limit - docs.length, 250)),
        start: String(start),
        expand: "body.storage",
      });
      const res = await fetch(`${this.site}/wiki/rest/api/content/search?${params}`, { headers: this.headers() });
      if (!res.ok) return docs;
      const data = (await res.json()) as any;
      for (const c of data.results ?? []) docs.push(this.toDoc(c));
      start += (data.results ?? []).length;
      if (!data._links?.next || (data.results ?? []).length === 0) break;
    } while (docs.length < limit);
    return docs.slice(0, limit);
  }

  async get(id: string): Promise<ConnectorDoc | undefined> {
    const res = await fetch(`${this.site}/wiki/rest/api/content/${encodeURIComponent(id)}?expand=body.storage,space,version`, { headers: this.headers() });
    if (!res.ok) return undefined;
    return this.toDoc((await res.json()) as any);
  }

  private toDoc(c: any): ConnectorDoc {
    return {
      id: String(c.id),
      title: c.title ?? String(c.id),
      body: htmlToText(c.body?.storage?.value ?? ""),
      url: c._links?.webui ? `${this.site}/wiki${c._links.webui}` : undefined,
      acl: this.defaultAcl,
    };
  }
}
