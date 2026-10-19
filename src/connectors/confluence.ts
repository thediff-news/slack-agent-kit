import type { ConnectorDoc, SyncableConnector, SyncedDoc, SyncListing } from "./types.js";
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
export class ConfluenceConnector implements SyncableConnector {
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
        expand: "body.storage,version",
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

  private lastMod = new Map<string, string>();

  /** Sync listing: all pages (bounded at 200), or only pages modified since
   * the cursor. Confluence `version.when` is the incremental marker. */
  async list(since?: string): Promise<SyncListing> {
    const cap = 200;
    const cql = since
      ? `type = page AND lastmodified >= "${cqlDate(since)}" ORDER BY lastmodified DESC`
      : "type = page ORDER BY lastmodified DESC";
    const docs: ConnectorDoc[] = [];
    let start = 0;
    do {
      const params = new URLSearchParams({
        cql,
        limit: String(Math.min(cap - docs.length, 250)),
        start: String(start),
        expand: "body.storage,version",
      });
      const res = await fetch(`${this.site}/wiki/rest/api/content/search?${params}`, { headers: this.headers() });
      if (!res.ok) break;
      const data = (await res.json()) as any;
      for (const c of data.results ?? []) docs.push(this.toDoc(c));
      start += (data.results ?? []).length;
      if (!data._links?.next || (data.results ?? []).length === 0) break;
    } while (docs.length < cap);
    return { docs: docs.map((d) => ({ ...d, lastModified: this.lastMod.get(d.id) })), complete: !since && docs.length < cap };
  }

  private toDoc(c: any): ConnectorDoc {
    if (c.id && c.version?.when) this.lastMod.set(String(c.id), c.version.when);    return {
      id: String(c.id),
      title: c.title ?? String(c.id),
      body: htmlToText(c.body?.storage?.value ?? ""),
      url: c._links?.webui ? `${this.site}/wiki${c._links.webui}` : undefined,
      acl: this.defaultAcl,
    };
  }
}

/** Confluence CQL datetime: "yyyy-MM-dd HH:mm". */
function cqlDate(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
