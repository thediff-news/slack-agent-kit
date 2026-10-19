import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type { Embedder } from "./embed.js";
import { cosine, tokenize } from "./embed.js";
import { chunkDocument } from "./chunk.js";

export interface Retrieved {
  source: string;
  text: string;
  score: number;
  acl: string;
  ingestedAt: string;
}

/**
 * Ingest -> embed -> store -> retrieve, all local: documents are chunked,
 * embedded with the configured Embedder, and stored as blobs in SQLite.
 * Ingestion is idempotent per (source, content hash), so re-running it
 * never duplicates chunks - and re-ingesting identical content under a
 * different ACL updates the stored ACL, so tightening always takes effect.
 */
export class Rag {
  private db: Database.Database;

  constructor(dbPath: string, private embedder: Embedder) {
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY, source TEXT, idx INTEGER,
        text TEXT, embedding BLOB,
        acl TEXT DEFAULT 'public',
        ingested_at TEXT DEFAULT (datetime('now'))
      );
    `);
  }

  async ingest(source: string, text: string, acl = "public"): Promise<number> {
    let n = 0;
    for (const chunk of chunkDocument(source, text)) {
      const id = createHash("sha256").update(`${source}:${chunk.index}:${chunk.text}`).digest("hex").slice(0, 32);
      const vec = await this.embedder.embed(chunk.text);
      // Upsert: identical content under a new ACL re-tags the existing
      // chunk (the WHERE keeps no-op re-ingests at 0 changes).
      const res = this.db
        .prepare(`INSERT INTO chunks (id, source, idx, text, embedding, acl) VALUES (?,?,?,?,?,?)
                  ON CONFLICT(id) DO UPDATE SET acl=excluded.acl WHERE chunks.acl != excluded.acl`)
        .run(id, chunk.source, chunk.index, chunk.text, Buffer.from(vec.buffer), acl);
      n += res.changes;
    }
    return n;
  }

  /** Permissions-aware retrieval: when `acls` is given, only chunks tagged
   * with one of those ACLs are visible. */
  async retrieve(query: string, k = 4, acls?: string[]): Promise<Retrieved[]> {
    const q = await this.embedder.embed(query);
    const qTokens = new Set(tokenize(query));
    const rows = this.db.prepare("SELECT source, text, embedding, acl, ingested_at FROM chunks").all() as any[];
    return rows
      .filter((r) => !acls || acls.includes(r.acl))
      // at least one shared content token: pure hash collisions never surface
      .filter((r) => tokenize(r.text).some((t) => qTokens.has(t)))
      .map((r) => ({
        // the `acl: <tag>` first line is ingest metadata, never answer content
        source: r.source, text: r.text.replace(/^acl:\s*\S+[ \t]*\n+/, ""), acl: r.acl, ingestedAt: r.ingested_at,
        score: cosine(q, new Float32Array(r.embedding.buffer, r.embedding.byteOffset, this.embedder.dimensions)),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .filter((r) => r.score > 0.05);
  }

  /** Sync path: drop every stored chunk for a source, then ingest fresh.
   * Used when a source document changed - stale chunks never survive. */
  async replace(source: string, text: string, acl = "public"): Promise<number> {
    this.db.prepare("DELETE FROM chunks WHERE source = ?").run(source);
    return this.ingest(source, text, acl);
  }

  /** Drop a source from the index entirely (deleted upstream). Returns the
   * number of chunks removed. */
  remove(source: string): number {
    return this.db.prepare("DELETE FROM chunks WHERE source = ?").run(source).changes;
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as any).n;
  }

  close(): void {
    this.db.close();
  }
}
