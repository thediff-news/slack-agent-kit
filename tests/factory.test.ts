/** Factory pipeline tests: scripted LLM, local fixture repo, PR seam. No network. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runFactory, diffHasSecret } from "../src/factory/pipeline.js";
import type { Llm } from "../src/llm/openai.js";

function fixtureRepo(): string {
  const src = mkdtempSync(join(tmpdir(), "factory-fixture-"));
  writeFileSync(join(src, "package.json"), JSON.stringify({
    name: "fixture", type: "module",
    scripts: { test: "node --test tests/*.test.js", typecheck: "true" },
  }));
  mkdirSync(join(src, "src"));
  writeFileSync(join(src, "src", "math.js"), "export function add(a, b) { return a - b; } // BUG\n");
  mkdirSync(join(src, "tests"));
  writeFileSync(join(src, "tests", "math.test.js"), `
import { test } from "node:test";
import assert from "node:assert/strict";
import { add } from "../src/math.js";
test("add", () => assert.equal(add(2, 2), 4));
`);
  execFileSync("git", ["init", "-q"], { cwd: src });
  execFileSync("git", ["add", "-A"], { cwd: src });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: src });
  return src;
}

function cloneSeam(fixture: string) {
  return async (_repo: string, dir: string) => { execFileSync("git", ["clone", "-q", fixture, dir]); };
}

function hooksLog() {
  const notes: string[] = [];
  const audits: string[] = [];
  let planAnswer = true;
  return {
    notes, audits,
    setPlanAnswer(v: boolean) { planAnswer = v; },
    hooks: {
      audit: (e: string, d: string) => audits.push(`${e}: ${d.slice(0, 80)}`),
      approvePlan: async (t: string) => { notes.push(`GATE: ${t.slice(0, 80)}`); return planAnswer; },
      note: (t: string) => { notes.push(t.slice(0, 100)); },
    },
  };
}

const TRIAGE = JSON.stringify({ kind: "bug", severity: "medium", title: "add() subtracts instead of adding", duplicates: [], summary: "src/math.js has a sign error." });
const PLAN = JSON.stringify({ files: ["src/math.js"], approach: "flip the operator", testStrategy: "npm test", reproTest: "tests/repro.test.js" });
const REPRO = JSON.stringify({ files: [{ path: "tests/repro.test.js", content: `
import { test } from "node:test";
import assert from "node:assert/strict";
import { add } from "../src/math.js";
test("repro: add(2,2) must be 4", () => assert.equal(add(2, 2), 4));
` }], notes: "repro of the sign bug" });
const REVIEW_OK = JSON.stringify({ ok: true, issues: [] });
const EDIT = JSON.stringify({ files: [{ path: "src/math.js", content: "export function add(a, b) { return a + b; } // fixed\n" }], notes: "fixed sign" });

function scriptedLlm(over: { triage?: string; plan?: string; repro?: string; review?: string; edit?: string }): Llm {
  return {
    model: "scripted",
    async chat(msgs) {
      const user = String(msgs[msgs.length - 1].content);
      if (/^REPRO STAGE/.test(user)) return over.repro ?? REPRO;
      if (/^SELF REVIEW/.test(user)) return over.review ?? REVIEW_OK;
      if (/PLAN:/.test(user)) return over.edit ?? EDIT;
      if (/REPO:/.test(user)) return over.plan ?? PLAN;
      if (/EXISTING ISSUES/.test(user)) return over.triage ?? TRIAGE;
      throw new Error("unexpected prompt: " + user.slice(0, 80));
    },
  };
}

test("factory: full pipeline - red-to-green repro, self-review, PR with evidence (seams)", async () => {
  const fixture = fixtureRepo();
  const workRoot = mkdtempSync(join(tmpdir(), "factory-work-"));
  const prs: any[] = [];
  const h = hooksLog();
  const result = await runFactory({
    repo: "acme/widget", request: "add(2,2) returns 0",
    llm: scriptedLlm({}), hooks: h.hooks, workRoot,
    clone: cloneSeam(fixture),
    openPr: async (dir, branch, title, body) => { prs.push({ branch, title, body }); return "https://github.com/acme/widget/pull/7"; },
  });
  assert.equal(result.ok, true, `${result.summary} :: ${(result.testOutput ?? "").slice(-400)}`);
  assert.equal(result.stage, "pr");
  assert.equal(result.reproTest, "tests/repro.test.js");
  assert.ok(result.redOutput && /fail 1|not ok/.test(result.redOutput), "red evidence captured");
  assert.ok(result.greenOutput && /pass 1|ok 1/.test(result.greenOutput), "green evidence captured");
  assert.match(prs[0].body, /Repro test \(red to green\)/);
  assert.match(prs[0].body, /Red \(before\)/);
  assert.match(prs[0].body, /Green \(after\)/);
  assert.match(readFileSync(join(workRoot, "repo", "src", "math.js"), "utf8"), /a \+ b/);
  assert.ok(h.notes.some((n) => n.startsWith("GATE:")), "plan gate asked");
  assert.ok(h.audits.some((a) => a.includes("factory_repro_red")), "red run audited");
  assert.ok(h.audits.some((a) => a.includes("factory_self_review")), "self-review audited");
});

test("factory: repro that PASSES on base stops without a PR (bug not reproduced)", async () => {
  const fixture = fixtureRepo();
  const workRoot = mkdtempSync(join(tmpdir(), "factory-work-"));
  const h = hooksLog();
  const greenRepro = JSON.stringify({ files: [{ path: "tests/repro.test.js", content: `
import { test } from "node:test";
import assert from "node:assert/strict";
import { add } from "../src/math.js";
test("repro", () => assert.equal(add(2, 2), 0)); // asserts the buggy behavior: passes on base
` }], notes: "x" });
  const result = await runFactory({
    repo: "acme/widget", request: "add broken",
    llm: scriptedLlm({ repro: greenRepro }), hooks: h.hooks, workRoot,
    clone: cloneSeam(fixture),
    openPr: async () => { throw new Error("must never open a PR"); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.stage, "repro-red");
  assert.match(result.summary, /not reproduced/);
});

test("factory: self-review issues feed back into the coding loop before the PR", async () => {
  const fixture = fixtureRepo();
  const workRoot = mkdtempSync(join(tmpdir(), "factory-work-"));
  const h = hooksLog();
  let reviews = 0;
  let edits = 0;
  const llm: Llm = {
    model: "scripted",
    async chat(msgs) {
      const user = String(msgs[msgs.length - 1].content);
      if (/^REPRO STAGE/.test(user)) return REPRO;
      if (/^SELF REVIEW/.test(user)) { reviews++; return reviews === 1 ? JSON.stringify({ ok: false, issues: ["calls runtime.resolveApproval which does not exist"] }) : REVIEW_OK; }
      if (/PLAN:/.test(user)) { edits++; if (edits === 2) assert.match(user, /self-review found issues/, "review issues fed back"); return EDIT; }
      if (/REPO:/.test(user)) return PLAN;
      if (/EXISTING ISSUES/.test(user)) return TRIAGE;
      throw new Error("unexpected prompt");
    },
  };
  const result = await runFactory({
    repo: "acme/widget", request: "add broken",
    llm, hooks: h.hooks, workRoot,
    clone: cloneSeam(fixture),
    openPr: async () => "https://github.com/acme/widget/pull/9",
  });
  assert.equal(result.ok, true, result.summary);
  assert.equal(reviews, 2);
  assert.equal(edits, 2);
});

test("factory: plan denial stops before any code change", async () => {
  const fixture = fixtureRepo();
  const workRoot = mkdtempSync(join(tmpdir(), "factory-work-"));
  const h = hooksLog();
  h.setPlanAnswer(false);
  const result = await runFactory({
    repo: "acme/widget", request: "add broken",
    llm: scriptedLlm({}), hooks: h.hooks, workRoot,
    clone: cloneSeam(fixture),
    openPr: async () => { throw new Error("must never open a PR"); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.stage, "plan-gate");
  assert.match(readFileSync(join(workRoot, "repo", "src", "math.js"), "utf8"), /a - b/); // unchanged
});

test("factory: question triage short-circuits without cloning", async () => {
  const h = hooksLog();
  const result = await runFactory({
    repo: "acme/widget", request: "how does the sync backoff work?",
    llm: scriptedLlm({ triage: JSON.stringify({ kind: "question", severity: "low", title: "q", duplicates: [], summary: "just a question" }) }),
    hooks: h.hooks, workRoot: mkdtempSync(join(tmpdir(), "factory-work-")),
    clone: async () => { throw new Error("must not clone for a question"); },
  });
  assert.equal(result.ok, true);
  assert.equal(result.stage, "triage");
});

test("factory: secret in the model's edit is blocked before commit", async () => {
  const fixture = fixtureRepo();
  const workRoot = mkdtempSync(join(tmpdir(), "factory-work-"));
  const h = hooksLog();
  const leaking = JSON.stringify({ files: [{ path: "src/math.js", content: "export function add(a, b) { return a + b; }\n// token = \"sk-abcdefghijklmnopqrstuvwxyz123456\"\n" }], notes: "fixed" });
  const result = await runFactory({
    repo: "acme/widget", request: "add broken",
    llm: scriptedLlm({ edit: leaking }), hooks: h.hooks, workRoot,
    clone: cloneSeam(fixture),
    openPr: async () => { throw new Error("must never open a PR"); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.stage, "secret-scan");
  assert.ok(h.audits.some((a) => a.includes("factory_secret_blocked")));
});

test("factory: model writing outside the repo is refused", async () => {
  const fixture = fixtureRepo();
  const workRoot = mkdtempSync(join(tmpdir(), "factory-work-"));
  const h = hooksLog();
  const evil = JSON.stringify({ files: [{ path: "../evil.js", content: "pwned" }], notes: "x" });
  const result = await runFactory({
    repo: "acme/widget", request: "add broken",
    llm: scriptedLlm({ edit: evil }), hooks: h.hooks, workRoot,
    clone: cloneSeam(fixture),
  });
  assert.equal(result.ok, false);
  assert.match(result.summary, /outside repo/);
  assert.ok(!existsSync(join(workRoot, "evil.js")));
});

test("factory: repro stage may only write test files", async () => {
  const fixture = fixtureRepo();
  const workRoot = mkdtempSync(join(tmpdir(), "factory-work-"));
  const h = hooksLog();
  const badRepro = JSON.stringify({ files: [{ path: "src/math.js", content: "export function add(a,b){return a+b;}\n" }], notes: "sneaky fix in repro stage" });
  const result = await runFactory({
    repo: "acme/widget", request: "add broken",
    llm: scriptedLlm({ repro: badRepro }), hooks: h.hooks, workRoot,
    clone: cloneSeam(fixture),
  });
  assert.equal(result.ok, false);
  assert.equal(result.stage, "repro");
  assert.match(readFileSync(join(workRoot, "repo", "src", "math.js"), "utf8"), /a - b/); // untouched
});

test("factory: diffHasSecret only flags added lines", () => {
  assert.ok(diffHasSecret("+const k = \"sk-abcdefghijklmnopqrstuvwxyz123456\"\n"));
  assert.ok(!diffHasSecret("-const k = \"sk-abcdefghijklmnopqrstuvwxyz123456\"\n"));
  assert.ok(!diffHasSecret("+const k = process.env.OPENAI_API_KEY\n"));
});

test("factory: test feedback loop - first edit fails tests, second fixes", async () => {
  const fixture = fixtureRepo();
  const workRoot = mkdtempSync(join(tmpdir(), "factory-work-"));
  const h = hooksLog();
  let edits = 0;
  const llm: Llm = {
    model: "scripted",
    async chat(msgs) {
      const user = String(msgs[msgs.length - 1].content);
      if (/^REPRO STAGE/.test(user)) return REPRO;
      if (/^SELF REVIEW/.test(user)) return REVIEW_OK;
      if (/PLAN:/.test(user)) {
        edits++;
        if (edits === 1) return JSON.stringify({ files: [{ path: "src/math.js", content: "export function add(a, b) { return a - b; } // still wrong\n" }], notes: "wrong op" });
        assert.match(user, /PREVIOUS ATTEMPT FAILED/, "failure fed back to the model");
        return EDIT;
      }
      if (/REPO:/.test(user)) return PLAN;
      if (/EXISTING ISSUES/.test(user)) return TRIAGE;
      throw new Error("unexpected prompt");
    },
  };
  const result = await runFactory({
    repo: "acme/widget", request: "add broken",
    llm, hooks: h.hooks, workRoot,
    clone: cloneSeam(fixture),
    openPr: async () => "https://github.com/acme/widget/pull/8",
  });
  assert.equal(result.ok, true, `${result.summary} :: ${(result.testOutput ?? "").slice(-300)}`);
  assert.equal(edits, 2);
});

test("factory: per-stage llm overrides route code and review to their own models", async () => {
  const fixture = fixtureRepo();
  const workRoot = mkdtempSync(join(tmpdir(), "factory-work-"));
  const seen: Record<string, string[]> = {};
  const rec = (name: string): Llm => {
    const inner = scriptedLlm({});
    return {
      model: name,
      async chat(m) {
        (seen[name] ??= []).push(String(m[m.length - 1].content).slice(0, 60));
        return inner.chat(m);
      },
    };
  };
  const h = hooksLog();
  const result = await runFactory({
    repo: "acme/widget", request: "add(2,2) returns 0",
    llm: rec("default"), llms: { code: rec("coder"), review: rec("reviewer") },
    hooks: h.hooks, workRoot,
    clone: cloneSeam(fixture),
    openPr: async () => "https://github.com/acme/widget/pull/8",
  });
  assert.equal(result.ok, true, result.summary);
  assert.ok(seen.coder?.some((p) => /PLAN:/.test(p)), "coding round used the code model");
  assert.ok(seen.reviewer?.some((p) => /^SELF REVIEW/.test(p)), "self-review used the review model");
  assert.ok(!seen.default?.some((p) => /^SELF REVIEW|PREVIOUS ATTEMPT/.test(p)), "default model got neither coding nor review");
});
