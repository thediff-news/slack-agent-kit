/**
 * Full-loop demo of every reference skill, with no Slack and no API keys:
 *   1. ingest docs (with ACLs) into the knowledge base
 *   2. company-brain: a question, answered with citations + freshness
 *   3. company-brain: same question from a viewer - restricted doc invisible
 *   4. company-brain: "ingest" command -> gated action
 *   5. credential-triage: fake leaked key -> report -> gated rotation
 *   6. incident-triage: traceback -> suspect commit -> gated fix
 *   7. support-triage: ticket -> classification -> gated draft reply
 *   8. alert-router: same alert 3x -> dedup -> gated escalation
 *   9. audit trail + hash-chain verification + restart resume
 *
 * Run: npm run demo          (asks before mutating actions)
 *      npm run demo -- --approve   (auto-approves, for CI)
 */
import { mkdirSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { buildRuntime } from "../src/kit.js";
import { cliEvent, cliHooks } from "../src/adapters/cli.js";
import { AuditLog } from "../src/core/audit.js";

mkdirSync("data", { recursive: true });
const autoApprove = process.argv.includes("--approve");
const kit = await buildRuntime("kit.config.yaml", cliHooks({ autoApprove }));
const fire = (text: string, actor = "cli-operator") => kit.runtime.handleEvent(cliEvent(text, actor));

// fixture repos need their git history (nested repos cannot ship in git)
if (!existsSync("examples/fixtures/target-repo/.git")) {
  const cwd = "examples/fixtures/target-repo";
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd });
  execFileSync("git", ["add", "-A"], { cwd });
  execFileSync("git", ["-c", "user.name=demo", "-c", "user.email=demo@example.com", "commit", "-qm", "fixture app with planted fake key"], { cwd });
}
if (!existsSync("examples/fixtures/incident-repo/.git")) {
  execFileSync("bash", ["examples/fixtures/make-incident-repo.sh"]);
}

console.log("== 1. Ingest demo docs (public + ACL-tagged) ==");
for (const f of readdirSync("examples/fixtures/demo-docs")) {
  const body = readFileSync(join("examples/fixtures/demo-docs", f), "utf8");
  const acl = /^acl:\s*(\S+)/m.exec(body)?.[1] ?? "public";
  console.log(`   ${f}: ${await kit.rag.ingest(`docs/${f}`, body, acl)} chunk(s), acl=${acl}`);
}
console.log(`   total chunks: ${kit.rag.count()}`);

console.log("\n== 2. company-brain: operator asks about incident response ==");
await fire("what do we do when checkout throws a TypeError?");

console.log("\n== 3. company-brain: a viewer asks about Q4 discounts (restricted doc) ==");
await fire("what are the Q4 wholesale discounts?", "cli-viewer");

console.log("\n== 4. company-brain: same question from an admin (sees the finance ACL) ==");
await fire("what are the Q4 wholesale discounts?");

console.log("\n== 5. company-brain: ingest-on-command (gated) ==");
await fire("ingest rotation-policy.md");

console.log("\n== 6. credential-triage: leaked key alert ==");
await fire("[secret-alert] scanner flagged a live-looking key in demo-app\nkey_hint: paydemo_live_f4k3");

console.log("\n== 7. incident-triage: production traceback ==");
await fire("incident: checkout-api 500ing on guest checkout\n" + readFileSync("examples/fixtures/incident-log.txt", "utf8"));

console.log("\n== 8. support-triage: a refund ticket ==");
await fire("ticket: I was billed twice for my annual plan and need a refund, the charge appears twice on my card");

console.log("\n== 9. alert-router: the same alert three times ==");
await fire("alert: checkout-api error rate 14% above threshold in us-east");
await fire("alert: checkout-api error rate 19% above threshold in us-east");
await fire("alert: checkout-api error rate 23% above threshold in us-east");

console.log("\n== 10. Audit trail ==");
console.log(readFileSync("data/audit.jsonl", "utf8")
  .trim().split("\n")
  .map((l) => { const e = JSON.parse(l); return `   #${e.seq} ${e.kind} - ${e.detail.slice(0, 85)}`; })
  .join("\n"));
const bad = AuditLog.verify("data/audit.jsonl");
console.log(bad === null ? "   hash chain: VALID" : `   hash chain: BROKEN at #${bad}`);

console.log("\n== 11. Restart simulation ==");
const kit2 = await buildRuntime("kit.config.yaml", cliHooks({ autoApprove }));
console.log(`   resurfaced pending approvals: ${(await kit2.runtime.resumePending()).length}`);

await kit.store.close();
await kit2.store.close();
kit.rag.close();
kit2.rag.close();
console.log("\ndemo complete");
