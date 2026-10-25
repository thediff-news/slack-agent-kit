import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { FactoryTools } from "../src/factory-tools.js";
import { configFromEnv, pickModel } from "../src/config.js";
import { AuditLog } from "../src/audit.js";
import { acquireInstanceLock, preflightProblems } from "../src/slack.js";
import { startBudgetProxy } from "../budget-proxy.mjs";

const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });

/** Hand-built clone at the factory's owner_name dir with a real test suite:
 * npm test is RED while src/fix.txt is missing, GREEN once it exists. */
function fixture(pageText = "Globex Net $166.00") {
  const tmp = mkdtempSync(join(tmpdir(), "factory-wf-"));
  const config = configFromEnv({ SDK_APP_AUDIT_LOG: join(tmp, "state", "audit.jsonl"), SDK_APP_APPROVALS_LOG: join(tmp, "state", "approvals.jsonl") } as any);
  const page = { url: "", text: pageText };
  const tools = new FactoryTools({
    config,
    audit: new AuditLog(join(tmp, "state", "audit.jsonl")),
    pageState: async () => (page.url ? { url: page.url, text: page.text } : undefined),
  });
  const dir = join(tmp, "state", "factory-clones", "owner_name");
  mkdirSync(join(dir, "test"), { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fix", scripts: { test: "node test/run.js" } }));
  writeFileSync(join(dir, "test", "run.js"), 'process.exit(require("node:fs").existsSync("src/fix.txt") ? 0 : 1);\n');
  writeFileSync(join(dir, "index.html"), "<html><body>statement</body></html>\n");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "--", ".");
  git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "base");
  const base = git(dir, "rev-parse", "HEAD").trim();
  writeFileSync(join(dir, ".git", "factory-base"), base + "\n");
  git(dir, "checkout", "-q", "-B", "factory/sdk-test");
  return { tools, dir, tmp, page };
}

test("non-UI case: source edit refused before red evidence; full happy path opens the PR gate", async () => {
  const { tools } = fixture();
  assert.match(await tools.writeFile("owner/name", "src/fix.txt", "fixed"), /BLOCKED: no reproduction evidence/);
  // test files are writable before evidence (no deadlock on the repro test itself)
  assert.match(await tools.writeFile("owner/name", "test/extra.test.js", "// ok"), /^wrote /);
  assert.match(await tools.runChecks("owner/name", "npm test"), /EXIT 1/); // red recorded
  assert.match(await tools.writeFile("owner/name", "src/fix.txt", "fixed"), /^wrote /);
  assert.doesNotMatch(await tools.runChecks("owner/name", "npm test"), /^EXIT/); // green
  const out = await tools.createPr("owner/name", "t", "b");
  assert.match(out, /\[dry-run\] would/);
});

test("a failing test run after source edits is NOT reproduction evidence", async () => {
  const { tools, dir } = fixture();
  writeFileSync(join(dir, "src", "sneaky.txt"), "changed via shell\n"); // bypasses the tool counter
  assert.match(await tools.runChecks("owner/name", "npm test"), /EXIT 1/);
  assert.match(await tools.writeFile("owner/name", "src/fix.txt", "fixed"), /BLOCKED: no reproduction evidence/);
});

test("UI case: interaction + screenshot before edits, fresh after-evidence before PR", async () => {
  const { tools, page } = fixture();
  const url = (await tools.serve("owner/name", ".")).match(/http:\/\/127\.0\.0\.1:\d+\//)![0];
  page.url = url;
  assert.match(await tools.writeFile("owner/name", "src/fix.txt", "fixed"), /BLOCKED: no BEFORE-FIX UI evidence/);
  await tools.noteBrowseEvidence(url, "screenshot"); // screenshot without driving the UI
  assert.match(await tools.writeFile("owner/name", "src/fix.txt", "fixed"), /^wrote /);
  assert.doesNotMatch(await tools.runChecks("owner/name", "npm test"), /^EXIT/); // green
  let out = await tools.createPr("owner/name", "t", "b");
  assert.match(out, /BLOCKED: factory workflow incomplete/);
  assert.match(out, /lacks interaction/);
  assert.match(out, /no AFTER-fix UI evidence/);
  await tools.close();
  // proper order: interact + screenshot on the untouched base
  const { tools: t2, page: p2 } = fixture();
  const url2 = (await t2.serve("owner/name", ".")).match(/http:\/\/127\.0\.0\.1:\d+\//)![0];
  p2.url = url2;
  await t2.noteBrowseEvidence(url2, "interact");
  await t2.noteBrowseEvidence(url2, "screenshot");
  // a claimed observation the app's own page read contradicts is rejected
  assert.match(await t2.recordUiState("owner/name", "before", "Globex Net $999.00", "wrong total"), /^REJECTED: your claimed observation/);
  assert.match(await t2.recordUiState("owner/name", "before", "Globex Net $166.00", "refund sign dropped, net too high"), /^verified:/);
  assert.match(await t2.writeFile("owner/name", "src/fix.txt", "fixed"), /^wrote /);
  await t2.runChecks("owner/name", "npm test");
  p2.text = "Globex Net $144.00";
  await t2.noteBrowseEvidence(url2, "screenshot"); // after-fix, on the final diff
  assert.match(await t2.recordUiState("owner/name", "after", "Globex Net $144.00", "sign kept, net correct"), /^verified:/);
  out = await t2.createPr("owner/name", "t", "b");
  assert.match(out, /\[dry-run\] would/);
  await t2.close();
});

test("staleness: any change after green/after-evidence invalidates the PR gate - including shell writes", async () => {
  const { tools, dir, page } = fixture();
  const url = (await tools.serve("owner/name", ".")).match(/http:\/\/127\.0\.0\.1:\d+\//)![0];
  page.url = url;
  await tools.noteBrowseEvidence(url, "interact");
  await tools.noteBrowseEvidence(url, "screenshot");
  await tools.writeFile("owner/name", "src/fix.txt", "fixed");
  await tools.runChecks("owner/name", "npm test");
  await tools.noteBrowseEvidence(url, "screenshot");
  await tools.recordUiState("owner/name", "after", "Globex Net $166.00", "seeded after state");
  // shell-side edit (no tool): the git tree hash must catch it
  writeFileSync(join(dir, "src", "fix.txt"), "fixed harder\n");
  const out = await tools.createPr("owner/name", "t", "b");
  assert.match(out, /BLOCKED: factory workflow incomplete/);
  assert.match(out, /STALE/);
  await tools.close();
});

test("evidence ledger lives in the app state dir, never inside the clone", async () => {
  const { tools, dir, tmp } = fixture();
  await tools.runChecks("owner/name", "npm test"); // red -> writes the ledger
  assert.ok(existsSync(join(tmp, "state", "factory-workflow", "owner_name.json")));
  assert.ok(!existsSync(join(dir, ".git", "factory-workflow.json")));
});

test("pickModel: factory signals and images keep the main model; plain chat routes cheap", () => {
  const cfg = { model: "claude-sonnet-5-5", chatModel: "chat-cheap" };
  assert.equal(pickModel(cfg, "hello, how are you?", false), "chat-cheap");
  assert.equal(pickModel(cfg, "there is a bug in checkout", false), "claude-sonnet-5-5");
  assert.equal(pickModel(cfg, "can you open a PR?", false), "claude-sonnet-5-5");
  assert.equal(pickModel(cfg, "hello", true), "claude-sonnet-5-5"); // image = factory-grade
  assert.equal(pickModel({ model: "m", chatModel: "" }, "hello", false), "m"); // no routing configured
  assert.equal(pickModel({ model: "m", chatModel: "m" }, "hello", false), "m");
});

test("preflight: missing tokens named before boot, not mid-run", () => {
  assert.deepEqual(preflightProblems({}), [
    "SLACK_BOT_TOKEN missing or not an xoxb- bot token",
    "SLACK_APP_TOKEN missing or not an xapp- app-level token",
    "no Anthropic credential: ANTHROPIC_API_KEY or SDK_APP_KEY_FILE required",
  ]);
  assert.deepEqual(preflightProblems({ SLACK_BOT_TOKEN: "xoxb-1", SLACK_APP_TOKEN: "xapp-1", ANTHROPIC_API_KEY: "k", SDK_APP_DRY_RUN: "0" }),
    ["armed (SDK_APP_DRY_RUN=0) but GH_TOKEN missing: factory pushes use `gh auth git-credential` and would fail mid-case"]);
  assert.deepEqual(preflightProblems({ SLACK_BOT_TOKEN: "xoxb-1", SLACK_APP_TOKEN: "xapp-1", ANTHROPIC_API_KEY: "k", SDK_APP_DRY_RUN: "0", GH_TOKEN: "g" }), []);
});

test("instance lock: a live second process is refused, a stale lock is replaced", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdk-lock-"));
  const lock = join(tmp, "slack-app.lock");
  const child = spawn("sleep", ["30"]);
  try {
    writeFileSync(lock, `${child.pid}\n`);
    assert.throws(() => acquireInstanceLock(lock), /already running/);
  } finally {
    child.kill();
  }
  await new Promise((r) => setTimeout(r, 300)); // let the exit land
  acquireInstanceLock(lock); // stale lock replaced
  assert.match(readFileSync(lock, "utf8"), new RegExp(`^${process.pid}`));
});

test("budget proxy: model allowlist with per-model verified prices; unpriced model fails closed", async () => {
  const upstream = http.createServer((req, res) => {
    if (req.url === "/v1/messages/count_tokens") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ input_tokens: 100 }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "m", usage: { input_tokens: 100, output_tokens: 5 } }));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const port = (upstream.address() as any).port;
  const post = (p: number, body: any) => new Promise<{ status: number; body: string }>((res) => {
    const r = http.request({ host: "127.0.0.1", port: p, path: "/v1/messages", method: "POST" }, (resp) => {
      let b = "";
      resp.on("data", (c) => (b += c));
      resp.on("end", () => res({ status: resp.statusCode ?? 0, body: b }));
    });
    r.end(JSON.stringify(body));
  });
  try {
    // second model with a verified price: admitted
    const proxy = await startBudgetProxy({
      totalUsd: 1, model: "claude-sonnet-5-5,claude-haiku-x", maxOutputTokens: 100,
      inputRatePerMTok: 2.5, outputRatePerMTok: 10,
      upstreamBase: `http://127.0.0.1:${port}`, realKey: "k",
      rates: { "claude-haiku-x": { input: 1, output: 5 } },
    });
    assert.equal((await post(proxy.port, { model: "claude-haiku-x", messages: [] })).status, 200);
    assert.equal((await post(proxy.port, { model: "claude-sonnet-5-5", messages: [] })).status, 200);
    const denied = await post(proxy.port, { model: "claude-other", messages: [] });
    assert.equal(denied.status, 403);
    assert.match(denied.body, /allows only/);
    await proxy.close();
    // second model WITHOUT a verified price: fail closed
    const proxy2 = await startBudgetProxy({
      totalUsd: 1, model: "claude-sonnet-5-5,claude-haiku-x", maxOutputTokens: 100,
      inputRatePerMTok: 2.5, outputRatePerMTok: 10,
      upstreamBase: `http://127.0.0.1:${port}`, realKey: "k",
    });
    const unpriced = await post(proxy2.port, { model: "claude-haiku-x", messages: [] });
    assert.equal(unpriced.status, 403);
    assert.match(unpriced.body, /no verified price/);
    await proxy2.close();
  } finally {
    upstream.close();
  }
});

test("render-only fallback matches VISIBLE text only - hidden elements cannot false-pass a claim", async () => {
  const { tools, dir } = fixture();
  writeFileSync(join(dir, "test", "render.js"),
    'require("node:fs").writeFileSync("render.html", \'<html><body><div>Globex Net $144.00</div><div style="display:none">Hidden Net $999.00</div><script>/* script Net $777.00 */</script></body></html>\');\n');
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fix", scripts: { test: "node test/run.js", render: "node test/render.js" } }));
  const shot = await tools.screenshotEvidence("owner/name", "npm run render", "render.html");
  assert.ok(existsSync(shot.path));
  // hidden (display:none) and script content are NOT on the rendered page as visible text
  assert.match(await tools.recordUiState("owner/name", "after", "Hidden Net $999.00", "hidden value"), /^REJECTED: your claimed observation/);
  assert.match(await tools.recordUiState("owner/name", "after", "script Net $777.00", "script source"), /^REJECTED: your claimed observation/);
  assert.match(await tools.recordUiState("owner/name", "after", "Globex Net $144.00", "visible total"), /^verified:/);
  await tools.close();
});
