import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { CredentialTriageSkill } from "../src/skills/credential-triage.js";
import { cliEvent } from "../src/adapters/cli.js";
import { SqliteStore } from "../src/core/store-sqlite.js";
import { AuditLog } from "../src/core/audit.js";
import { Rag } from "../src/rag/rag.js";
import { HashingEmbedder } from "../src/rag/embed.js";
import type { KitConfig } from "../src/core/config.js";

function fixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-skill-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "config"), { recursive: true });
  mkdirSync(join(dir, ".github"), { recursive: true });
  writeFileSync(join(dir, "src", "pay.py"), 'PAYDEMO_API_KEY = "paydemo_live_f4k3d3m0_1a2b3c4d5e6f7g8h9i0"\n');
  writeFileSync(join(dir, "config", "production.yaml"), "api_key: ${PAYDEMO_API_KEY}\n");
  writeFileSync(join(dir, ".github", "CODEOWNERS"), "src/ @payments-team\n");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "x"], { cwd: dir });
  return dir;
}

test("credential-triage: locate, blast radius, owner, proposed gated action", async () => {
  const repo = fixtureRepo();
  const dir = mkdtempSync(join(tmpdir(), "kit-skill-ctx-"));
  const skill = new CredentialTriageSkill(repo);
  const ctx: any = {
    store: new SqliteStore(join(dir, "s.db")),
    audit: new AuditLog(join(dir, "a.jsonl")),
    rag: new Rag(join(dir, "r.db"), new HashingEmbedder(128)),
    connectors: {},
    config: {} as KitConfig,
    reply: async () => {},
    enrich: async () => "- (policy.md) revoke first",
  };
  const event = cliEvent("alert!\nkey_hint: paydemo_live_f4k3");
  assert.equal(skill.matches(event), true);
  const result = await skill.handle(event, ctx);
  assert.match(result.findings, /PAYDEMO_API_KEY/);
  assert.match(result.findings, /production/);
  assert.match(result.findings, /@payments-team/);
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].tier, "mutating");
  // run the proposed action and verify the edit
  await result.actions[0].run();
  const edited = (await import("node:fs")).readFileSync(join(repo, "src", "pay.py"), "utf8");
  assert.match(edited, /os\.environ\["PAYDEMO_API_KEY"\]/);
  assert.doesNotMatch(edited, /paydemo_live_f4k3d3m0/);
  ctx.store.close();
  ctx.rag.close();
});
