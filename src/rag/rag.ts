import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type { Embedder } from "./embed.js";
import { cosine } from "./embed.js";
import { chunkDocument } from "./chunk.js";

export interface Retrieved {
  source: string;
  text: string;
  score: number;
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
        text TEXT, embedding BLOB
      );
    `);
  }

  ingest(source: string, text: string): number {
    let n = 0;
    for (const chunk of chunkDocument(source, text)) {
      const id = createHash("sha256").update(`${source}:${chunk.index}:${chunk.text}`).digest("hex").slice(0, 32);
      const vec = this.embedder.embed(chunk.text);
      const res = this.db
        .prepare("INSERT OR IGNORE INTO chunks (id, source, idx, text, embedding) VALUES (?,?,?,?,?)")
        .run(id, chunk.source, chunk.index, chunk.text, Buffer.from(vec.buffer));
      n += res.changes;
    }
    return n;
  }

  retrieve(query: string, k = 4): Retrieved[] {
    const q = this.embedder.embed(query);
    const rows = this.db.prepare("SELECT source, text, embedding FROM chunks").all() as any[];
    return rows
      .map((r) => ({ source: r.source, text: r.text, score: cosine(q, new Float32Array(r.embedding.buffer, r.embedding.byteOffset, this.embedder.dimensions)) }))
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
