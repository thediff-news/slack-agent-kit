import type { Connector, ConnectorDoc } from "./types.js";

/**
 * Web connector: fetches a public web page or RSS/Atom feed over HTTP and
 * returns it as a document. Read-only; no cookies, no auth.
 *
 * SSRF guard: only http(s) URLs, and obvious private/loopback hosts are
 * refused. This is a demo-grade guard, not a sandbox: point the kit at
 * trusted operators only (see docs/THREAT_MODEL.md).
 *
 * RSS/Atom feeds return the newest items (title, link, summary) as one
 * document; pages return visible text with scripts/styles stripped.
 *
 * ACL: the connector ALWAYS stamps its configured ACL (default "public") -
 * fetched content can never broaden its own access with an inline acl: line.
 */
export class WebConnector implements Connector {
  name = "web";
  constructor(private acl = "public", private maxItems = 5, private fetchImpl: typeof fetch = fetch) {}

  private static BLOCKED = /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[?::1|metadata\.google)/i;

  private checkUrl(raw: string): URL {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("only http(s) URLs");
    if (WebConnector.BLOCKED.test(u.hostname)) throw new Error(`refusing private host ${u.hostname}`);
    return u;
  }

  /** A web connector has no index to search; a URL query fetches directly. */
  async search(query: string): Promise<ConnectorDoc[]> {
    const q = query.trim();
    if (!/^https?:\/\//i.test(q)) return [];
    const doc = await this.get(q);
    return doc ? [doc] : [];
  }

  async get(id: string): Promise<ConnectorDoc | undefined> {
    let u: URL;
    try {
      u = this.checkUrl(id);
    } catch {
      return undefined;
    }
    try {
      const res = await this.fetchImpl(u, { redirect: "follow" });
      if (!res.ok) return undefined;
      const body = await res.text();
      const ctype = res.headers.get("content-type") ?? "";
      if (/<rss[\s>]|<feed[\s>]|application\/(rss|atom)\+xml/i.test(body.slice(0, 2000) + ctype)) {
        return { id, title: u.hostname + " feed", body: this.parseFeed(body), url: id, acl: this.acl };
      }
      return { id, title: this.pageTitle(body) ?? u.hostname + u.pathname, body: this.htmlToText(body), url: id, acl: this.acl };
    } catch {
      return undefined;
    }
  }

  private pageTitle(html: string): string | undefined {
    return /<title[^>]*>([^<]{1,200})<\/title>/i.exec(html)?.[1]?.trim();
  }

  private htmlToText(html: string): string {
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&")
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s*\n+/g, "\n")
      .trim()
      .slice(0, 20000);
  }

  /** Minimal RSS 2.0 / Atom item extraction - newest maxItems entries. */
  private parseFeed(xml: string): string {
    const items: string[] = [];
    const rss = [...xml.matchAll(/<item[\s>]([\s\S]*?)<\/item>/gi)];
    for (const m of rss.slice(0, this.maxItems)) {
      const it = m[1];
      const title = this.tag(it, "title");
      const link = this.tag(it, "link");
      const desc = this.tag(it, "description") ?? this.tag(it, "summary");
      items.push(`## ${title}\n${link}\n${desc}`.trim());
    }
    const atom = [...xml.matchAll(/<entry[\s>]([\s\S]*?)<\/entry>/gi)];
    for (const m of atom.slice(0, this.maxItems)) {
      const it = m[1];
      const title = this.tag(it, "title");
      const link = /<link[^>]*href="([^"]+)"/i.exec(it)?.[1] ?? "";
      const summary = this.tag(it, "summary") ?? this.tag(it, "content");
      items.push(`## ${title}\n${link}\n${summary}`.trim());
    }
    return items.join("\n\n").replace(/<!\[CDATA\[|\]\]>/g, "").slice(0, 20000) || "(feed contained no items)";
  }

  private tag(xml: string, name: string): string {
    const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i").exec(xml);
    return (m?.[1] ?? "").replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
}
