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
 * never duplicates chunks.
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

  ingest(source: string, text: string, acl = "public"): number {
    let n = 0;
    for (const chunk of chunkDocument(source, text)) {
      const id = createHash("sha256").update(`${source}:${chunk.index}:${chunk.text}`).digest("hex").slice(0, 32);
      const vec = this.embedder.embed(chunk.text);
      const res = this.db
        .prepare("INSERT OR IGNORE INTO chunks (id, source, idx, text, embedding, acl) VALUES (?,?,?,?,?,?)")
        .run(id, chunk.source, chunk.index, chunk.text, Buffer.from(vec.buffer), acl);
      n += res.changes;
    }
    return n;
  }

  /** Permissions-aware retrieval: when `acls` is given, only chunks tagged
   * with one of those ACLs are visible. */
  retrieve(query: string, k = 4, acls?: string[]): Retrieved[] {
    const q = this.embedder.embed(query);
    const qTokens = new Set(tokenize(query));
    const rows = this.db.prepare("SELECT source, text, embedding, acl, ingested_at FROM chunks").all() as any[];
    return rows
      .filter((r) => !acls || acls.includes(r.acl))
      // at least one shared content token: pure hash collisions never surface
      .filter((r) => tokenize(r.text).some((t) => qTokens.has(t)))
      .map((r) => ({
        source: r.source, text: r.text, acl: r.acl, ingestedAt: r.ingested_at,
        score: cosine(q, new Float32Array(r.embedding.buffer, r.embedding.byteOffset, this.embedder.dimensions)),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .filter((r) => r.score > 0.05);
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as any).n;
  }

  close(): void {
    this.db.close();
  }
}
