import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Connector, ConnectorDoc } from "./types.js";

const TEXT_EXT = new Set([".md", ".txt", ".py", ".ts", ".yaml", ".yml", ".json", ".toml"]);

/** Filesystem connector: mounts a local directory (docs, runbooks, a cloned
 * repo) as a searchable source. Read-only by construction. */
export class FilesystemConnector implements Connector {
  name = "filesystem";

  constructor(private root: string) {}

  private *walk(dir: string): Generator<string> {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith(".") || entry === "node_modules") continue;
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) yield* this.walk(full);
      else if (TEXT_EXT.has(entry.slice(entry.lastIndexOf(".")))) yield full;
    }
  }

  async search(query: string, limit = 10): Promise<ConnectorDoc[]> {
    const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
    const hits: { doc: ConnectorDoc; score: number }[] = [];
    for (const file of this.walk(this.root)) {
      const body = readFileSync(file, "utf8");
      const lower = body.toLowerCase();
      const score = terms.reduce((s, t) => s + (lower.split(t).length - 1), 0);
      if (score > 0) {
        hits.push({
          score,
          doc: { id: relative(this.root, file), title: relative(this.root, file), body },
        });
      }
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit).map((h) => h.doc);
  }

  async get(id: string): Promise<ConnectorDoc | undefined> {
    try {
      const body = readFileSync(join(this.root, id), "utf8");
      return { id, title: id, body };
    } catch {
      return undefined;
    }
  }
}
