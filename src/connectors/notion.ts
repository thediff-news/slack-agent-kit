import type { ConnectorDoc, SyncableConnector, SyncedDoc, SyncListing } from "./types.js";

const API = "https://api.notion.com/v1";
// Long-stable API version; override with NOTION_API_VERSION if needed.
const NOTION_VERSION = process.env.NOTION_API_VERSION ?? "2022-06-28";

/**
 * Notion connector (read-only): workspace search + page content.
 * Verified against the current Notion API reference:
 *   POST /v1/search                      (query, filter, start_cursor/page_size)
 *   GET  /v1/pages/{id}                  (title)
 *   GET  /v1/blocks/{id}/children        (content, paginated)
 * Auth: Authorization: Bearer <internal integration token>, plus the required
 * Notion-Version header. The integration only sees pages explicitly shared
 * with it; page-level permissions are not mapped, every doc carries this
 * connector's configured default ACL.
 */
export class NotionConnector implements SyncableConnector {
  name = "notion";

  constructor(private apiKey: string, private defaultAcl = "notion") {}

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    };
  }

  async search(query: string, limit = 10): Promise<ConnectorDoc[]> {
    const docs: ConnectorDoc[] = [];
    let startCursor: string | undefined;
    do {
      const res = await fetch(`${API}/search`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          query,
          filter: { property: "object", value: "page" },
          page_size: Math.min(limit - docs.length, 100),
          ...(startCursor ? { start_cursor: startCursor } : {}),
        }),
      });
      if (!res.ok) return docs;
      const data = (await res.json()) as any;
      for (const page of data.results ?? []) {
        docs.push({
          id: page.id,
          title: pageTitle(page),
          body: "", // content loaded via get()
          url: page.url,
          acl: this.defaultAcl,
        });
      }
      startCursor = data.has_more ? data.next_cursor : undefined;
    } while (startCursor && docs.length < limit);
    return docs.slice(0, limit);
  }

  async get(id: string): Promise<ConnectorDoc | undefined> {
    const pageRes = await fetch(`${API}/pages/${encodeURIComponent(id)}`, { headers: this.headers() });
    if (!pageRes.ok) return undefined;
    const page = (await pageRes.json()) as any;
    return { id: page.id, title: pageTitle(page), body: await this.pageContent(id), url: page.url, acl: this.defaultAcl };
  }

  private async pageContent(id: string): Promise<string> {
    const lines: string[] = [];
    let startCursor: string | undefined;
    do {
      const params = new URLSearchParams({ page_size: "100" });
      if (startCursor) params.set("start_cursor", startCursor);
      const res = await fetch(`${API}/blocks/${encodeURIComponent(id)}/children?${params}`, { headers: this.headers() });
      if (!res.ok) break;
      const data = (await res.json()) as any;
      for (const block of data.results ?? []) {
        const line = blockText(block);
        if (line) lines.push(line);
      }
      startCursor = data.has_more ? data.next_cursor : undefined;
    } while (startCursor);
    return lines.join("\n");
  }

  /** Sync listing: every page shared with the integration (bounded at 100),
   * sorted by last_edited_time. With a cursor, only pages edited after it -
   * the sort lets us stop paging as soon as we pass the cursor. */
  async list(since?: string): Promise<SyncListing> {
    const cap = 100;
    const docs: SyncedDoc[] = [];
    let startCursor: string | undefined;
    let hitCursor = false;
    do {
      const res = await fetch(`${API}/search`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          filter: { property: "object", value: "page" },
          sort: { direction: "descending", timestamp: "last_edited_time" },
          page_size: Math.min(cap - docs.length, 100),
          ...(startCursor ? { start_cursor: startCursor } : {}),
        }),
      });
      if (!res.ok) break;
      const data = (await res.json()) as any;
      for (const page of data.results ?? []) {
        const edited = page.last_edited_time as string | undefined;
        if (since && edited && edited <= since) { hitCursor = true; break; }
        docs.push({
          id: page.id,
          title: pageTitle(page),
          body: await this.pageContent(page.id),
          url: page.url,
          acl: this.defaultAcl,
          lastModified: edited,
        });
        if (docs.length >= cap) break;
      }
      if (hitCursor || docs.length >= cap) break;
      startCursor = data.has_more ? data.next_cursor : undefined;
    } while (startCursor);
    return { docs, complete: !since && !hitCursor && docs.length < cap };
  }
}

function pageTitle(page: any): string {
  for (const p of Object.values(page.properties ?? {}) as any[]) {
    if (p?.type === "title") return (p.title ?? []).map((t: any) => t.plain_text ?? "").join("") || "Untitled";
  }
  return "Untitled";
}

function blockText(block: any): string {
  const data = block[block.type];
  const rich = data?.rich_text ?? data?.title ?? [];
  const text = rich.map((t: any) => t.plain_text ?? "").join("");
  if (!text) return "";
  return block.type === "to_do" ? `${data.checked ? "[x]" : "[ ]"} ${text}` : text;
}
