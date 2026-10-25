import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir, tmpdir } from "node:os";
import { buildSrtSettings, claudeSandboxEnv } from "../src/factory/pipeline.js";
import { parseArgs } from "../scripts/claude-code-stage.mjs";

test("srt settings confine reads, writes, and network to the workdir + API", () => {
  const s = buildSrtSettings("/tmp/factory-work-xyz") as any;
  assert.deepEqual(s.filesystem.denyRead, [homedir()]);
  assert.ok(s.filesystem.allowRead.includes("/tmp/factory-work-xyz"));
  assert.ok(s.filesystem.allowRead.some((p: string) => p.endsWith("node_modules")), "SDK/CLI binaries readable");
  assert.ok(s.filesystem.allowWrite.includes("/tmp/factory-work-xyz"));
  assert.ok(s.filesystem.allowWrite.includes(tmpdir()));
  assert.deepEqual(s.network.allowedDomains, ["api.anthropic.com"]);
});

test("sandbox env keeps only SDK-required vars, drops other secrets", () => {
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  process.env.OPENAI_API_KEY = "sk-should-not-leak";
  process.env.GITHUB_TOKEN = "ghp-should-not-leak";
  const env = claudeSandboxEnv();
  assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-test");
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
});

test("wrapper arg parsing: defaults and explicit values", () => {
  const a = parseArgs(["--dir", ".", "--prompt-file", "p.txt", "--result-file", "r.json"]);
  assert.equal(a.model, "claude-sonnet-5-5");
  assert.equal(a.maxTurns, 8);
  const b = parseArgs(["--dir", ".", "--prompt-file", "p", "--result-file", "r", "--model", "claude-haiku-4.5", "--max-turns", "5"]);
  assert.equal(b.model, "claude-haiku-4.5");
  assert.equal(b.maxTurns, 5);
  assert.throws(() => parseArgs(["--prompt-file", "p", "--result-file", "r"]));
});
