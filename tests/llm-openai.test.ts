import { test } from "node:test";
import assert from "node:assert/strict";
import { openAiFromEnv } from "../src/llm/openai.js";

test("openai provider: disabled without a key, keyless kit unaffected", () => {
  assert.equal(openAiFromEnv({} as NodeJS.ProcessEnv), undefined);
  assert.equal(openAiFromEnv({ OPENAI_API_KEY: "  " } as NodeJS.ProcessEnv), undefined);
});

test("openai provider: key enables chat; embeddings opt-in via OPENAI_EMBEDDINGS", () => {
  const chatOnly = openAiFromEnv({ OPENAI_API_KEY: "sk-test-fake" } as NodeJS.ProcessEnv);
  assert.ok(chatOnly?.llm);
  assert.equal(chatOnly?.llm.model, "gpt-4o-mini");
  assert.equal(chatOnly?.embedder, undefined);

  const withEmb = openAiFromEnv({
    OPENAI_API_KEY: "sk-test-fake",
    OPENAI_EMBEDDINGS: "1",
    OPENAI_CHAT_MODEL: "gpt-4o",
    OPENAI_EMBEDDING_DIMENSIONS: "512",
  } as NodeJS.ProcessEnv);
  assert.equal(withEmb?.llm.model, "gpt-4o");
  assert.equal(withEmb?.embedder?.dimensions, 512);
});
