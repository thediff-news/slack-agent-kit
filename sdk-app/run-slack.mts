/** Production launcher: budget proxy (hard cap) + Slack surface in one process.
 * Tokens come from the environment (launcher injects them), never from the command line or logs. */
import { existsSync, readFileSync } from "node:fs";
import { captureCheckpoint, recordDebt, settleDebt, syncCheckpoints } from "./src/checkpoint.js";
import { startBudgetProxy } from "./budget-proxy.mjs";
import { startSlackApp } from "./src/slack.js";
import { configFromEnv, evalPreflightProblems, githubTargetProblems } from "./src/config.js";

const realKey = process.env.ANTHROPIC_API_KEY ?? (process.env.SDK_APP_KEY_FILE ? readFileSync(process.env.SDK_APP_KEY_FILE, "utf8").trim() : "");
if (!realKey) throw new Error("ANTHROPIC_API_KEY (or SDK_APP_KEY_FILE) is required");
const model0 = process.env.SDK_APP_PROXY_MODELS || "claude-sonnet-5-5";
const rates0 = (() => { try { return JSON.parse(process.env.SDK_APP_PROXY_RATES || "{}") } catch { return {}; } })();
const proxy = await startBudgetProxy({
  totalUsd: Number(process.env.SDK_APP_PROXY_CAP_USD || "2.00"),
  // comma-separated allowlist; every non-first model needs a verified price in
  // SDK_APP_PROXY_RATES (JSON: {"model-id": {"input": <$/MTok>, "output": <$/MTok>}});
  // a rates entry for the FIRST model overrides the fallback reserve price below.
  model: model0, maxOutputTokens: 4096,
  inputRatePerMTok: rates0[model0]?.input ?? 2.50, outputRatePerMTok: rates0[model0]?.output ?? 10,
  rates: rates0,
  upstreamBase: "https://api.anthropic.com", realKey,
  statePath: process.env.SDK_APP_PROXY_STATE || undefined,
  checkpoint: process.env.SDK_APP_CHECKPOINT_REMOTE ? { stateDir: (process.env.SDK_APP_AUDIT_LOG || "sdk-app/state/audit.jsonl").replace(/[^/]+$/, ""), remote: process.env.SDK_APP_CHECKPOINT_REMOTE } : undefined,
  journalPath: process.env.SDK_APP_PROXY_JOURNAL || (process.env.SDK_APP_PROXY_STATE ? process.env.SDK_APP_PROXY_STATE.replace(/\.json$/, '') + '-journal.jsonl' : undefined),
  basisUsd: Number(process.env.SDK_APP_PROXY_BASIS_USD || "0"),
});
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${proxy.port}`;
process.env.ANTHROPIC_API_KEY = "proxy-managed";
console.log(`[run-slack] budget proxy on :${proxy.port} (hard cap ${process.env.SDK_APP_PROXY_CAP_USD || "2.00"} USD)`);
const cfg = configFromEnv();
if ((process.env.SDK_APP_EVAL_LOCKDOWN || "") === "1") {
  const problems = evalPreflightProblems(cfg);
  const { execFile: execFileCb } = await import("node:child_process");
  const ghRunner = (args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>((res) => {
    execFileCb("gh", args, { timeout: 30000 }, (err, stdout, stderr) => res({ code: err ? (err as any).code ?? 1 : 0, stdout: String(stdout), stderr: String(stderr ?? err?.message ?? "") }));
  });
  problems.push(...await githubTargetProblems(cfg.githubRepos, ghRunner, { expectedUser: cfg.githubExpectedUser, requirePrivate: true, requirePush: true }));
  if (problems.length) { console.error("[run-slack] EVAL PREFLIGHT FAILED:\n - " + problems.join("\n - ")); process.exit(1); }
  console.log(`[run-slack] EVAL PREFLIGHT OK: repos=${cfg.githubRepos.join(",")} approvers=${cfg.approvers.length} acls=${Object.keys(cfg.userAcls).length} dryRun=${cfg.dryRun} maxTurns=${cfg.maxTurnsPerMessage} browseAllowlist=${cfg.browseAllowlist.join(",")} proxyState=${process.env.SDK_APP_PROXY_STATE}`);
}
// Restart guard: the app has no in-process restart path - restarts are
// operator kill + relaunch. So durability is wired at the two real edges:
// (a) BOOT: settle any checkpoint debt left by a crash/failed capture; a
//     failure is logged loudly and the debt gates the next work step.
// (b) SHUTDOWN: SIGTERM/SIGINT trigger a bounded pre-restart sync of the whole
//     checkpoint store (covers every captured mutation); failure is recorded
//     as debt so the next boot/next work step blocks until it is durable.
const ckptStateDir = (process.env.SDK_APP_AUDIT_LOG || "sdk-app/state/audit.jsonl").replace(/[^/]+$/, "");
const ckptRemote = process.env.SDK_APP_CHECKPOINT_REMOTE;
const ckptAuthor = { name: "sdk-app-checkpoint", email: "checkpoint@localhost" };
if (ckptRemote) {
  // Abrupt-loss recovery: if a kill landed between a mutation and its capture,
  // no debt marker exists - but the worktree survived on disk. Re-capture the
  // last active worktree NOW, before any new mutation or paid execution, and
  // gate on durability via the debt mechanism if the sync fails. Honest limit:
  // this covers a killed PROCESS; if the whole environment was lost, the
  // worktree is gone and only already-synced checkpoints survive.
  try {
    const pointer = JSON.parse(readFileSync(ckptStateDir + "last-active-worktree.json", "utf8"));
    if (pointer?.repo && pointer?.dir && existsSync(pointer.dir)) {
      const cap = await captureCheckpoint({ stateDir: ckptStateDir, repo: pointer.repo, dir: pointer.dir, reason: "manual", requestId: "boot-recovery" });
      if (!cap.ok) recordDebt(ckptStateDir, { repo: pointer.repo, reason: "manual", at: new Date().toISOString(), error: `boot-recovery capture refused: ${(cap.refused ?? []).join("; ").slice(0, 200)}` });
      else console.log(`[run-slack] boot-recovery capture of ${pointer.repo} ok`);
    }
  } catch { /* no pointer or unreadable: nothing survived to recapture */ }
  const boot = await settleDebt(ckptStateDir, ckptRemote, "auto-checkpoints", ckptAuthor);
  // Any boot-recovery capture above must reach the remote before work resumes:
  const bootSync = await syncCheckpoints({ stateDir: ckptStateDir, remote: ckptRemote, branch: "auto-checkpoints", author: ckptAuthor });
  if (!bootSync.ok) recordDebt(ckptStateDir, { repo: "(boot)", reason: "manual", at: new Date().toISOString(), error: `boot sync failed: ${(bootSync.error ?? "").slice(0, 200)}` });
  if (!boot.cleared) console.error(`[run-slack] CHECKPOINT DEBT at boot: ${boot.pending} unsaved capture(s); sync failed: ${(boot.error ?? "").slice(0, 150)} - the next work step will BLOCK until the checkpoint remote is reachable`);
  let restarting = false;
  const preRestart = (sig: string) => {
    if (restarting) return;
    restarting = true;
    console.log(`[run-slack] ${sig}: pre-restart checkpoint sync (bounded 20s)`);
    const killer = setTimeout(() => { console.error("[run-slack] pre-restart checkpoint TIMED OUT; exiting with debt recorded"); process.exit(1); }, 20000);
    syncCheckpoints({ stateDir: ckptStateDir, remote: ckptRemote, branch: "auto-checkpoints", author: ckptAuthor })
      .then((sync) => {
        if (!sync.ok) {
          recordDebt(ckptStateDir, { repo: "(pre-restart)", reason: "pre-restart", at: new Date().toISOString(), error: `shutdown sync failed: ${(sync.error ?? "").slice(0, 200)}` });
          console.error("[run-slack] pre-restart checkpoint FAILED; recorded as debt - next boot reports it and the next work step is gated");
        } else console.log("[run-slack] pre-restart checkpoint durable");
      })
      .finally(() => { clearTimeout(killer); process.exit(0); });
  };
  process.on("SIGTERM", () => preRestart("SIGTERM"));
  process.on("SIGINT", () => preRestart("SIGINT"));
}
await startSlackApp();
