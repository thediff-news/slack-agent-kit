/**
 * Optional OpenAI provider: hosted chat + embeddings behind the same
 * interfaces the keyless kit uses. Disabled unless OPENAI_API_KEY is set -
 * with no key in the environment nothing here is constructed and the kit
 * stays fully local and deterministic.
 *
 * Env:
 *   OPENAI_API_KEY              required to enable (never commit it)
 *   OPENAI_BASE_URL             optional API-compatible endpoint override
 *   OPENAI_CHAT_MODEL           default "gpt-4o-mini"
 *   OPENAI_EMBEDDINGS           "1"/"true"/"yes" to replace the local hashing
 *                               embedder with hosted embeddings
 *   OPENAI_EMBEDDING_MODEL      default "text-embedding-3-small"
 *   OPENAI_EMBEDDING_DIMENSIONS optional dimension override (3-* models only)
 *
 * NOTE: embeddings from different providers are not comparable. If you switch
 * embedders, point rag.dbPath at a fresh database and re-ingest.
 */
import OpenAI from "openai";
import type { Embedder } from "../rag/embed.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Generative hook for skills: summarize/investigate with an LLM. */
export interface Llm {
  model: string;
  chat(messages: ChatMessage[]): Promise<string>;
}

export interface OpenAiProvider {
  llm: Llm;
  /** Present only when OPENAI_EMBEDDINGS is enabled. */
  embedder?: Embedder;
}

const DEFAULT_DIMENSIONS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-ada-002": 1536,
};

class OpenAiEmbedder implements Embedder {
  readonly dimensions: number;

  constructor(
    private client: OpenAI,
    private model: string,
    requestedDimensions?: number,
  ) {
    this.dimensions = requestedDimensions ?? DEFAULT_DIMENSIONS[model] ?? 1536;
  }

  async embed(text: string): Promise<Float32Array> {
    const res = await this.client.embeddings.create({
      model: this.model,
      input: text,
      // only the 3-* models accept a dimensions parameter
      ...(this.model.startsWith("text-embedding-3") ? { dimensions: this.dimensions } : {}),
    });
    return new Float32Array(res.data[0].embedding);
  }
}

/** Build the provider from env, or undefined when no key is configured. */
export function openAiFromEnv(env: NodeJS.ProcessEnv = process.env): OpenAiProvider | undefined {
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) return undefined;

  const client = new OpenAI({ apiKey, baseURL: env.OPENAI_BASE_URL?.trim() || undefined });
  const chatModel = env.OPENAI_CHAT_MODEL?.trim() || "gpt-4o-mini";

  const llm: Llm = {
    model: chatModel,
    async chat(messages) {
      const res = await client.chat.completions.create({ model: chatModel, messages });
      return res.choices[0]?.message?.content?.trim() ?? "";
    },
  };

  let embedder: Embedder | undefined;
  if (/^(1|true|yes)$/i.test(env.OPENAI_EMBEDDINGS?.trim() ?? "")) {
    const model = env.OPENAI_EMBEDDING_MODEL?.trim() || "text-embedding-3-small";
    const dims = env.OPENAI_EMBEDDING_DIMENSIONS ? Number(env.OPENAI_EMBEDDING_DIMENSIONS) : undefined;
    embedder = new OpenAiEmbedder(client, model, dims);
  }

  return { llm, embedder };
}
