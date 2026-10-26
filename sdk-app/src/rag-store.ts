/** Ranked local retrieval over the user's sources - the kit's RAG carried
 * into the SDK app. Fully local (hashing embedder + SQLite), ACL tags kept
 * per document; search_docs ranks through this instead of substring match. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Rag } from "../../src/rag/rag.js";
import { HashingEmbedder } from "../../src/rag/embed.js";
import type { Connector, SyncableConnector } from "../../src/connectors/types.js";

const TEXT_EXT = new Set([".md", ".txt", ".markdown", ".rst", ".json", ".yaml", ".yml", ".ts", ".mts", ".js"]);

export type RagStore = {
  rag: Rag;
  /** (Re)index a directory tree of text files; returns docs ingested. */
  syncDocsRoot: (root: string) => Promise<number>;
  /** (Re)index every syncable connector; returns docs ingested. */
  syncConnectors: (connectors: Connector[]) => Promise<number>;
};

export function openRagStore(dbPath: string): RagStore {
  const rag = new Rag(dbPath, new HashingEmbedder());
  return {
    rag,
    async syncDocsRoot(root) {
      let n = 0;
      const walk = async (dir: string) => {
        for (const entry of readdirSync(dir)) {
          if (entry.startsWith(".") || entry === "node_modules") continue;
          const full = join(dir, entry);
          const st = statSync(full);
          if (st.isDirectory()) await walk(full);
          else if (TEXT_EXT.has(entry.slice(entry.lastIndexOf(".")))) {
            await rag.replace(`fs:${full}`, readFileSync(full, "utf8"));
            n++;
          }
        }
      };
      await walk(root);
      return n;
    },
    async syncConnectors(connectors) {
      let n = 0;
      for (const c of connectors) {
        const s = c as SyncableConnector;
        if (typeof s.list !== "function") continue;
        const listing = await s.list().catch(() => null);
        if (!listing) continue;
        for (const d of listing.docs) {
          await rag.replace(`${c.name}:${d.id}`, `# ${d.title}\n${d.body}`, d.acl ?? "public");
          n++;
        }
      }
      return n;
    },
  };
}
