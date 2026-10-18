import { createHash } from "node:crypto";

export interface Embedder {
  dimensions: number;
  embed(text: string): Float32Array;
}

/**
 * Default embedder: token-hashing (feature hashing) into a fixed-dimension
 * vector, L2-normalized. Zero dependencies, zero API keys, deterministic.
 * Good enough for keyword/topic retrieval over internal docs. Swap in
 * sentence-transformers or a hosted embeddings API behind this interface
 * when quality matters more than self-containment.
 */
export class HashingEmbedder implements Embedder {
  constructor(public dimensions = 512) {}

  embed(text: string): Float32Array {
    const vec = new Float32Array(this.dimensions);
    for (const token of text.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? []) {
      const h = createHash("sha256").update(token).digest();
      const idx = h.readUInt32BE(0) % this.dimensions;
      const sign = h[4] % 2 === 0 ? 1 : -1;
      vec[idx] += sign;
    }
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    for (let i = 0; i < this.dimensions; i++) vec[i] /= norm;
    return vec;
  }
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // both vectors are L2-normalized
}
