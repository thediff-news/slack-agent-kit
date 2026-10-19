import type { Connector, ConnectorDoc } from "./types.js";

/**
 * Slack channel history connector: searches and reads messages from channels
 * the kit's bot is a member of, via the Web API (conversations.history).
 * Read-only by construction. Auth is the bot token from the environment
 * (SLACK_BOT_TOKEN) - the kit never stores it.
 *
 * Requires the channels:history bot scope (already in docs/SLACK_SETUP.md's
 * manifest). Only messages the bot can already see are returned; the
 * connector stamps its configured ACL (default "public") on every document.
 */
export class SlackHistoryConnector implements Connector {
  name = "slack-history";

  constructor(
    private token: string,
    private channels: string[],
    private acl = "public",
    private apiBase = "https://slack.com/api",
  ) {}

  private async api(method: string, params: Record<string, string>): Promise<any> {
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(`${this.apiBase}/${method}?${qs}`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`${method}: ${data.error}`);
    return data;
  }

  /** Substring search over the last 100 messages per configured channel. */
  async search(query: string, limit = 10): Promise<ConnectorDoc[]> {
    const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
    const docs: ConnectorDoc[] = [];
    for (const channel of this.channels) {
      try {
        const data = await this.api("conversations.history", { channel, limit: "100" });
        for (const m of data.messages ?? []) {
          if (m.subtype) continue;
          const text = (m.text ?? "").toLowerCase();
          if (terms.length === 0 || terms.every((t) => text.includes(t))) {
            docs.push({
              id: `${channel}/${m.ts}`,
              title: `${channel} ${m.ts}`,
              body: `${m.user ?? m.bot_id ?? "?"}: ${m.text ?? ""}`,
              url: `https://slack.com/archives/${channel}/p${String(m.ts).replace(".", "")}`,
              acl: this.acl,
            });
          }
        }
      } catch {
        // channel unreadable (not a member, missing scope): skip, never fail the investigation
      }
    }
    return docs.slice(0, limit);
  }

  async get(id: string): Promise<ConnectorDoc | undefined> {
    const slash = id.indexOf("/");
    const channel = id.slice(0, slash);
    const ts = id.slice(slash + 1);
    try {
      const data = await this.api("conversations.history", { channel, latest: ts, inclusive: "true", limit: "1" });
      const m = data.messages?.[0];
      if (!m) return undefined;
      return {
        id,
        title: `${channel} ${ts}`,
        body: `${m.user ?? m.bot_id ?? "?"}: ${m.text ?? ""}`,
        url: `https://slack.com/archives/${channel}/p${String(ts).replace(".", "")}`,
        acl: this.acl,
      };
    } catch {
      return undefined;
    }
  }
}
