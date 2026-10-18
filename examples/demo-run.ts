/**
 * Full-loop demo with no Slack and no API keys:
 *   ingest docs into the RAG -> alert event arrives -> dedup -> RBAC ->
 *   credential-triage skill investigates the fixture repo -> report enriched
 *   with the rotation policy -> approval gate -> idempotent execution ->
 *   audit trail printed and verified.
 *
 * Run: npm run demo          (asks before executing the rotation)
 *      npm run demo -- --approve   (auto-approves, for CI)
 */
import { mkdirSync } from "node:fs";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { buildRuntime } from "../src/kit.js";
import { cliEvent, cliHooks } from "../src/adapters/cli.js";
import { AuditLog } from "../src/core/audit.js";

mkdirSync("data", { recursive: true });

const autoApprove = process.argv.includes("--approve");
const kit = await buildRuntime("kit.config.yaml", cliHooks({ autoApprove }));

console.log("== 1. Ingest demo docs into the RAG ==");
for (const f of readdirSync("examples/fixtures/demo-docs")) {
  const n = kit.rag.ingest(`docs/${f}`, readFileSync(join("examples/fixtures/demo-docs", f), "utf8"));
  console.log(`   ${f}: ${n} chunks`);
}
console.log(`   total chunks in store: ${kit.rag.count()}`);

// The fixture target repo ships without .git (nested repos do not survive
// cloning); initialize it on first run so git grep has a repo to search.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
if (!existsSync("examples/fixtures/target-repo/.git")) {
  const cwd = "examples/fixtures/target-repo";
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd });
  execFileSync("git", ["add", "-A"], { cwd });
  execFileSync("git", ["-c", "user.name=demo", "-c", "user.email=demo@example.com", "commit", "-qm", "fixture app with planted fake key"], { cwd });
}

console.log("\n== 2. Alert arrives (as if from a Slack channel watch) ==");
const alert = cliEvent(
  "[secret-alert] scanner flagged a live-looking key in demo-app\nkey_hint: paydemo_live_f4k3",
);
await kit.runtime.handleEvent(alert);

console.log("\n== 3. Same alert delivered again (retry): must be dropped as duplicate ==");
await kit.runtime.handleEvent(alert);

console.log("\n== 4. Audit trail ==");
console.log(readFileSync("data/audit.jsonl", "utf8")
  .trim().split("\n")
  .map((l) => { const e = JSON.parse(l); return `   #${e.seq} ${e.kind} - ${e.detail.slice(0, 90)}`; })
  .join("\n"));
const bad = AuditLog.verify("data/audit.jsonl");
console.log(bad === null ? "   hash chain: VALID" : `   hash chain: BROKEN at #${bad}`);

console.log("\n== 5. Restart simulation: pending approvals resurface, nothing re-executes ==");
const kit2 = await buildRuntime("kit.config.yaml", cliHooks({ autoApprove }));
console.log(`   resurfaced pending approvals: ${(await kit2.runtime.resumePending()).length}`);
await kit2.runtime.handleEvent(alert); // duplicate delivery after restart

await kit.store.close();
await kit2.store.close();
kit.rag.close();
kit2.rag.close();
console.log("\ndemo complete");
