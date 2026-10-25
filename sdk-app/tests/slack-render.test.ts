import { test } from "node:test";
import assert from "node:assert/strict";
import { renderThreadChunks } from "../src/slack.js";

// Behavior-level regression for the mrkdwn bug: the payload that actually
// reaches Slack must render the model's Markdown, not show literal asterisks.
// Against the pre-fix wiring (chunkText(message) with no conversion) every
// one of these assertions fails on the rendered output itself.
test("renderThreadChunks: the payload sent to Slack renders **bold** as *bold*", () => {
  const out = renderThreadChunks("Result: **42 tests green** and **PR open**.");
  assert.equal(out.join(""), "Result: *42 tests green* and *PR open*.");
  assert.doesNotMatch(out.join(""), /\*\*/);
});

test("renderThreadChunks: code spans keep literal asterisks, prose converts", () => {
  const out = renderThreadChunks("run `git add **/*` to stage **everything**");
  assert.equal(out.join(""), "run `git add **/*` to stage *everything*");
});

test("renderThreadChunks: long converted text still chunks within the limit", () => {
  const para = "**bold** ".repeat(700);
  const chunks = renderThreadChunks(para);
  assert.ok(chunks.length >= 2);
  for (const c of chunks) {
    assert.ok(c.length <= 3500);
    assert.doesNotMatch(c, /\*\*/, "each Slack message renders bold, no literal **"); // Slack renders per message: per-chunk is the correct granularity
  }
});
