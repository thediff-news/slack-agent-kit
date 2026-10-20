/** Factory pipeline tests: scripted LLM, local fixture repo, PR seam. No network. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runFactory, diffHasSecret, readRepoContext } from "../src/factory/pipeline.js";
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

function scriptedLlm(replies: Record<string, string>): Llm {
  const calls: string[] = [];
  return {
    model: "scripted",
    async chat(msgs) {
      const user = String(msgs[msgs.length - 1].content);
      calls.push(user.slice(0, 120));
      if (/PLAN:/.test(user) && replies.edit) return replies.edit;
      if (/REPO:/.test(user) && replies.plan) return replies.plan;
      if (/EXISTING ISSUES/.test(user) && replies.triage) return replies.triage;
      return replies.fallback ?? "{}";
    },
  };
}

function hooksLog() {
  const notes: string[] = [];
  const audits: string[] = [];
  let planAnswer = true;
  return {
    notes, audits,
    setPlanAnswer(v: boolean) { planAnswer = v; },
    hooks: {
      audit: (e: string, d: string) => audits.push(`${e}: ${d.slice(0, 60)}`),
      approvePlan: async (t: string) => { notes.push(`GATE: ${t.slice(0, 80)}`); return planAnswer; },
      note: (t: string) => { notes.push(t.slice(0, 100)); },
    },
  };
}

const TRIAGE = JSON.stringify({ kind: "bug", severity: "medium", title: "add() subtracts instead of adding", duplicates: [], summary: "src/math.ts has a sign error." });
const PLAN = JSON.stringify({ files: ["src/math.js"], approach: "flip the operator", testStrategy: "npm test" });
const EDIT = JSON.stringify({ files: [{ path: "src/math.js", content: "export function add(a, b) { return a + b; } // fixed\n" }], notes: "fixed sign" });

test("factory: full pipeline - triage, plan gate, implement, tests green, PR opened (seams)", async () => {
  const fixture = fixtureRepo();
  const workRoot = mkdtempSync(join(tmpdir(), "factory-work-"));
  const prs: any[] = [];
  const h = hooksLog();
  const result = await runFactory({
    repo: "acme/widget", request: "add(2,2) returns 0",
    llm: scriptedLlm({ triage: TRIAGE, plan: PLAN, edit: EDIT }),
    hooks: h.hooks, workRoot,
    clone: async (_repo, dir) => { execFileSync("git", ["clone", "-q", fixture, dir]); },
    openPr: async (dir, branch, title, body) => { prs.push({ branch, title }); return "https://github.com/acme/widget/pull/7"; },
  });
  assert.equal(result.ok, true, `${result.summary} :: ${(result.testOutput ?? "").slice(-600)}`);
  assert.equal(result.stage, "pr");
  assert.equal(result.prUrl, "https://github.com/acme/widget/pull/7");
  assert.match(result.branch ?? "", /^factory\//);
  assert.equal(prs.length, 1);
  assert.match(readFileSync(join(workRoot, "repo", "src", "math.js"), "utf8"), /a \+ b/);
  assert.ok(h.notes.some((n) => n.startsWith("GATE:")), "plan gate asked");
  // main untouched: the PR branch is factory/* and default branch has no factory commit
  const branches = execFileSync("git", ["branch"], { cwd: join(workRoot, "repo"), encoding: "utf8" });
  assert.match(branches, /factory\//);
});

test("factory: plan denial stops before any code change", async () => {
  const fixture = fixtureRepo();
  const workRoot = mkdtempSync(join(tmpdir(), "factory-work-"));
  const h = hooksLog();
  h.setPlanAnswer(false);
  const result = await runFactory({
    repo: "acme/widget", request: "add broken",
    llm: scriptedLlm({ triage: TRIAGE, plan: PLAN, edit: EDIT }),
    hooks: h.hooks, workRoot,
    clone: async (_r, dir) => { execFileSync("git", ["clone", "-q", fixture, dir]); },
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
    llm: scriptedLlm({ triage: TRIAGE, plan: PLAN, edit: leaking }),
    hooks: h.hooks, workRoot,
    clone: async (_r, dir) => { execFileSync("git", ["clone", "-q", fixture, dir]); },
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
  const evil = JSON.stringify({ files: [{ path: "../evil.ts", content: "pwned" }], notes: "x" });
  const result = await runFactory({
    repo: "acme/widget", request: "add broken",
    llm: scriptedLlm({ triage: TRIAGE, plan: PLAN, edit: evil }),
    hooks: h.hooks, workRoot,
    clone: async (_r, dir) => { execFileSync("git", ["clone", "-q", fixture, dir]); },
  });
  assert.equal(result.ok, false);
  assert.match(result.summary, /outside repo/);
  assert.ok(!existsSync(join(workRoot, "evil.ts")));
});

test("factory: diffHasSecret only flags added lines", () => {
  assert.ok(diffHasSecret("+const k = \"sk-abcdefghijklmnopqrstuvwxyz123456\"\n"));
  assert.ok(!diffHasSecret("-const k = \"sk-abcdefghijklmnopqrstuvwxyz123456\"\n")); // removed line
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
      if (/PLAN:/.test(user)) { edits++;
      if (edits === 1) return JSON.stringify({ files: [{ path: "src/math.js", content: "export function add(a, b) { return a - b; } // still wrong\n" }], notes: "wrong op" });
      assert.match(user, /PREVIOUS ATTEMPT FAILED/, "failure fed back to the model");
      return EDIT; }
      if (/REPO:/.test(user)) return PLAN;
      if (/EXISTING ISSUES/.test(user)) return TRIAGE;
      throw new Error("unexpected prompt"); },
  };
  const result = await runFactory({
    repo: "acme/widget", request: "add broken",
    llm, hooks: h.hooks, workRoot,
    clone: async (_r, dir) => { execFileSync("git", ["clone", "-q", fixture, dir]); },
    openPr: async () => "https://github.com/acme/widget/pull/8",
  });
  assert.equal(result.ok, true, `${result.summary} :: ${(result.testOutput ?? "").slice(-600)}`);
  assert.equal(edits, 2, `audits: ${h.audits.join(" | ")}; out: ${(result.testOutput ?? "").slice(-400)}`);
});
