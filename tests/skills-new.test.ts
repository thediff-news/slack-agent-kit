import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { SqliteStore } from "../src/core/store-sqlite.js";
import { AuditLog } from "../src/core/audit.js";
import { Rag } from "../src/rag/rag.js";
import { HashingEmbedder } from "../src/rag/embed.js";
import { FilesystemConnector } from "../src/connectors/fs.js";
import { KnowledgeSkill } from "../src/skills/knowledge.js";
import { IncidentTriageSkill } from "../src/skills/incident-triage.js";
import { SupportTriageSkill } from "../src/skills/support-triage.js";
import { AlertRouterSkill } from "../src/skills/alert-router.js";
import { cliEvent } from "../src/adapters/cli.js";

function makeCtx(dir: string, acls: string[] = ["public", "finance", "engineering"]): any {
  const ctx: any = {
    store: new SqliteStore(join(dir, "s.db")),
    audit: new AuditLog(join(dir, "a.jsonl")),
    rag: new Rag(join(dir, "r.db"), new HashingEmbedder(256)),
    connectors: { docs: new FilesystemConnector(join(dir, "docs")) },
    config: {},
    reply: async () => {},
    enrich: async (q: string, k = 3) =>
      (await ctx.rag.retrieve(q, k, acls)).map((h: any) => `- (${h.source}, ingested ${h.ingestedAt}) ${h.text.slice(0, 200)}`).join("\n"),
    aclsFor: () => acls,
  };
  mkdirSync(join(dir, "docs"), { recursive: true });
  return ctx;
}

test("company-brain: answers with citations, viewer ACL hides restricted docs, honesty on miss", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kit-kb-"));
  const ctx = makeCtx(dir);
  await ctx.rag.ingest("docs/public.md", "Incident runbook: revert first when customers are impacted, then fix in a draft PR.", "public");
  await ctx.rag.ingest("docs/finance.md", "Q4 wholesale discounts: 18% annual, pre-decisional, finance only.", "finance");

  const skill = new KnowledgeSkill();
  const admin = await skill.handle(cliEvent("what are the Q4 discounts?"), ctx);
  assert.match(admin.findings, /18%/);
  assert.match(admin.findings, /docs\/finance\.md/);
  assert.match(admin.findings, /ingested/);

  const viewerCtx = makeCtx(dir, ["public"]);
  viewerCtx.rag = ctx.rag; // same store, narrower ACLs
  const viewer = await skill.handle(cliEvent("what are the Q4 discounts?", "some-viewer"), viewerCtx);
  assert.doesNotMatch(viewer.findings, /18%/);
  assert.match(viewer.findings, /don't have anything/);

  const miss = await skill.handle(cliEvent("what is the airspeed of a swallow?"), ctx);
  assert.match(miss.findings, /don't have anything/);
  ctx.store.close();
});

test("company-brain: ingest command proposes a gated action that ingests", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kit-kbi-"));
  const ctx = makeCtx(dir);
  writeFileSync(join(dir, "docs", "runbook.md"), "acl: engineering\n\nDeploys freeze on Fridays except security fixes.");
  const skill = new KnowledgeSkill();
  const result = await skill.handle(cliEvent("ingest runbook.md"), ctx);
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].tier, "mutating");
  assert.match(result.actions[0].summary, /ACL: engineering/);
  await result.actions[0].run();
  const hits = await ctx.rag.retrieve("deploy freeze", 2, ["public", "engineering"]);
  assert.match(hits[0]?.text ?? "", /Fridays/);
  ctx.store.close();
});

test("company-brain: ingest unwraps Slack mrkdwn links (<url> and <url|label>)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kit-kbu-"));
  const ctx = makeCtx(dir);
  writeFileSync(join(dir, "docs", "page.md"), "Runbook body.");
  const skill = new KnowledgeSkill();
  for (const raw of ["ingest <page.md>", "ingest <page.md|page.md>", "ingest docs:<page.md>"]) {
    const result = await skill.handle(cliEvent(raw), ctx);
    assert.equal(result.actions.length, 1, raw);
    assert.match(result.actions[0].summary, /Ingest page\.md/);
  }
  ctx.store.close();
});

test("incident-triage: parses trace, names suspect commit, proposes gated fix", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kit-inc-"));
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repo });
  writeFileSync(join(repo, "src", "pricing.py"), 'def f(total, coupon):\n    if coupon is None:\n        return total\n    return total - int(coupon["percent"])\n');
  git("init", "-q", "-b", "main"); git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "safe pricing");
  writeFileSync(join(repo, "src", "pricing.py"), 'def f(total, coupon):\n    return total - int(coupon["percent"])\n');
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "simplify coupon handling");

  const ctx = makeCtx(dir);
  const skill = new IncidentTriageSkill(repo);
  const event = cliEvent('incident: checkout 500s\nTraceback (most recent call last):\n  File "src/checkout.py", line 4, in checkout\n  File "src/pricing.py", line 2, in f\nTypeError: \'NoneType\' object is not subscriptable');
  const result = await skill.handle(event, ctx);
  assert.match(result.findings, /src\/pricing\.py/);
  assert.match(result.findings, /simplify coupon handling/);
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].tier, "mutating");
  ctx.store.close();
});

test("incident-triage: resolves site-packages frame paths to repo-relative", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kit-inc-abs-"));
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "pkg"), { recursive: true });
  writeFileSync(join(repo, "pkg", "mod.py"), "x = 1\n");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "add mod"], { cwd: repo });
  const ctx = makeCtx(dir);
  const skill = new IncidentTriageSkill(repo);
  const result = await skill.handle(cliEvent(`incident: prod crash
Traceback (most recent call last):
  File "/usr/lib/python3.12/site-packages/pkg/mod.py", line 1, in <module>
RuntimeError: boom`), ctx);
  assert.match(result.findings, /pkg\/mod\.py/);
  assert.match(result.findings, /add mod/);
  ctx.store.close();
});

test("incident-triage: resolves Windows backslash frame paths to repo-relative", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kit-inc-win-"));
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "httpx"), { recursive: true });
  writeFileSync(join(repo, "httpx", "_client.py"), "x = 1\n");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "add client"], { cwd: repo });
  const ctx = makeCtx(dir);
  const skill = new IncidentTriageSkill(repo);
  const result = await skill.handle(cliEvent(`incident: prod crash
Traceback (most recent call last):
  File "C:\\Users\\User\\site-packages\\httpx\\_client.py", line 914, in send
RuntimeError: deque mutated during iteration`), ctx);
  assert.match(result.findings, /httpx\/_client\.py/);
  assert.match(result.findings, /add client/);
  ctx.store.close();
});

test("support-triage: classifies billing, drafts grounded reply, gates the send", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kit-sup-"));
  const ctx = makeCtx(dir);
  await ctx.rag.ingest("docs/refunds.md", "Refund policy: duplicate charges are refunded in full within 5 business days.");
  const skill = new SupportTriageSkill();
  const result = await skill.handle(cliEvent("ticket: I was billed twice, please refund the duplicate charge"), ctx);
  assert.match(result.findings, /billing/);
  assert.match(result.findings, /refunded in full/);
  assert.equal(result.actions[0].tier, "mutating");
  const out = await result.actions[0].run();
  assert.match(out, /billing/);
  ctx.store.close();
});

test("alert-router: first routes, repeat dedups, third escalates with gated action", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kit-al-"));
  const ctx = makeCtx(dir);
  const skill = new AlertRouterSkill({ checkout: "@payments-oncall" }, 3);
  const first = await skill.handle(cliEvent("alert: checkout error rate 11% high"), ctx);
  assert.match(first.findings, /@payments-oncall/);
  assert.match(first.findings, /11% high/);
  assert.equal(first.actions.length, 0);
  const second = await skill.handle(cliEvent("alert: checkout error rate 15% high"), ctx);
  assert.match(second.findings, /occurrence \*?2/);
  // original alert text in messages; digit-normalization only feeds the fingerprint
  assert.match(second.findings, /15% high/);
  assert.doesNotMatch(second.findings, /N%/);
  assert.equal(second.actions.length, 0);
  const third = await skill.handle(cliEvent("alert: checkout error rate 21% high"), ctx);
  assert.match(third.findings, /occurrence \*?3/);
  assert.equal(third.actions.length, 1);
  assert.equal(third.actions[0].tier, "mutating");
  assert.match(third.actions[0].summary, /@payments-oncall/);
  ctx.store.close();
});
