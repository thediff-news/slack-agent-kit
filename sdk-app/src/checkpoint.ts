/** Durable auto-checkpoint: persists the case's recoverable truth (worktree
 * patch, untracked test/source files, evidence image BYTES, sanitized cost
 * projection) to a private git remote, so a sandbox rebuild never again
 * destroys uncommitted agent work. ALLOWLIST-only (secret-scan alone is not
 * sufficient); never captures audits, transcripts, ledgers-as-files, env or
 * state files. Capturing never touches the case clone's git index (no
 * intent-to-add): untracked file bytes are read directly from disk.
 *
 * Critical transitions (approval pause, restart, forwarding a paid request)
 * must await requireDurable() and FAIL CLOSED when the remote ACK fails. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync , rmSync } from "node:fs";
import { basename, join } from "node:path";

const run = promisify(execFile);

/** What MAY enter a checkpoint (everything else is excluded by default). */
const SOURCE_EXT = /\.(ts|mts|cts|js|mjs|cjs|vue|jsx|tsx|css|scss|html|json|md|txt|yaml|yml|py|sh|sql)$/;
const IMAGE_EXT = /\.(png|jpg|jpeg|webp)$/i;
/** Never captured, even if allowlisted by extension. */
const DENY = /(^|\/)(\.env|\.git|node_modules|sdk-app\/state|state|dist|coverage|audit\.jsonl|approvals\.jsonl|proxy-ledger|sessions\.json|cli-cmds|env\.sh)(\/|$)/;
/** Defense-in-depth on top of the allowlist: same classes as the PR scan. */
const SECRET_PATTERNS = [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bAKIA[0-9A-Z]{16}\b/, /\b(?:sk|xoxb|xoxp|ghp|github_pat)[-_][A-Za-z0-9_-]{20,}\b/, /ANTHROPIC_API_KEY\s*=\s*\S+/];

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

export type CheckpointCost = {
  /** Settled conservative cumulative spend at capture, if a ledger exists. */
  cumulative: number | null;
  /** Reservations whose settle outcome is UNKNOWN (reqIds); preserved, never dropped. */
  unknownReqIds: string[];
  /** Seed/hold amounts still held (not settled), as recorded. */
  held: number | null;
};

export type CaptureOpts = {
  stateDir: string;
  repo: string;           // owner/name
  dir: string;            // case clone path
  reason: "mutation" | "turn-end" | "pre-approval" | "pre-restart" | "manual";
  evidenceFiles?: string[];   // absolute paths of evidence images (bytes are captured)
  cost?: CheckpointCost;
  requestId?: string;         // idempotency key for retried captures of one transition
};
export type CaptureResult = { ok: boolean; file?: string; refused?: string[]; skipped?: string[]; hash?: string };

function deniedPath(p: string): boolean { return DENY.test(p); }

/** Capture one checkpoint. Fails CLOSED: any read/allowlist/secret failure
 * yields ok:false and NO remote-eligible file is produced. */
export async function captureCheckpoint(opts: CaptureOpts): Promise<CaptureResult> {
  const refused: string[] = [];
  const skipped: string[] = [];
  // 1. Tracked worktree patch WITHOUT touching the index.
  const { stdout: patch } = await run("git", ["-C", opts.dir, "diff", "--binary", "HEAD"], { maxBuffer: 64 * 1024 * 1024 });
  // 2. Untracked files (bytes read directly; the agent's index is untouched).
  const { stdout: untrackedRaw } = await run("git", ["-C", opts.dir, "ls-files", "--others", "--exclude-standard"]);
  const files: { path: string; sha256: string; b64: string }[] = [];
  for (const rel of untrackedRaw.split("\n").filter(Boolean)) {
    if (deniedPath(rel) || !SOURCE_EXT.test(rel)) { skipped.push(rel); continue; }
    const bytes = readFileSync(join(opts.dir, rel));
    files.push({ path: rel, sha256: sha256(bytes), b64: bytes.toString("base64") });
  }
  // 3. Evidence image bytes (allowlisted extensions only).
  const evidence: { name: string; sha256: string; b64: string }[] = [];
  for (const f of opts.evidenceFiles ?? []) {
    const name = basename(f);
    if (!IMAGE_EXT.test(name) || deniedPath(f)) { refused.push(`evidence not allowlisted: ${name}`); continue; }
    const bytes = readFileSync(f);
    evidence.push({ name, sha256: sha256(bytes), b64: bytes.toString("base64") });
  }
  // 4. Secret re-check over every text payload (allowlist is primary; this is net #2).
  for (const pat of SECRET_PATTERNS) {
    if (pat.test(patch)) refused.push(`secret-like content in worktree patch: ${pat.source}`);
    for (const f of files) if (pat.test(Buffer.from(f.b64, "base64").toString("utf8"))) refused.push(`secret-like content in ${f.path}: ${pat.source}`);
  }
  if (refused.length) return { ok: false, refused };
  const at = new Date().toISOString();
  const head = (await run("git", ["-C", opts.dir, "rev-parse", "HEAD"])).stdout.trim();
  const checkpoint = {
    version: 1, at, reason: opts.reason, requestId: opts.requestId ?? null,
    repo: opts.repo, head, patch,
    untracked: files, evidence,
    cost: opts.cost ?? { cumulative: null, unknownReqIds: [], held: null },
  };
  const hash = sha256(JSON.stringify(checkpoint));
  const dir = join(opts.stateDir, "checkpoints");
  mkdirSync(dir, { recursive: true });
  const name = `${opts.repo.replace(/[^\w.-]+/g, "_")}-${at.replace(/[:.]/g, "-")}-${hash.slice(0, 8)}.json`;
  const target = join(dir, name);
  writeFileSync(target + ".tmp", JSON.stringify(checkpoint));
  renameSync(target + ".tmp", target); // atomic publish
  return { ok: true, file: target, hash, skipped };
}

export type SyncResult = { ok: boolean; acked: boolean; commit?: string; error?: string };

/** Push the checkpoints dir to the private remote branch. The remote ACK is
 * the durability proof; callers at critical transitions must fail closed on
 * ok:false. Idempotent: a restart that re-syncs unchanged content is a no-op. */
export async function syncCheckpoints(opts: { stateDir: string; remote: string; branch: string; author: { name: string; email: string } }): Promise<SyncResult> {
  const dir = join(opts.stateDir, "checkpoints");
  if (!existsSync(dir) || !readdirSync(dir).some((f) => f.endsWith(".json"))) return { ok: true, acked: true, commit: "none" };
  const git = (args: string[]) => run("git", ["-C", dir, ...args]);
  if (!existsSync(join(dir, ".git"))) {
    await git(["init", "-q", "-b", opts.branch]);
  }
  await git(["add", "-A"]);
  const { stdout: status } = await git(["status", "--porcelain"]);
  let commit = "none";
  if (status.trim()) {
    await git(["-c", `user.name=${opts.author.name}`, "-c", `user.email=${opts.author.email}`, "commit", "-q", "-m", `checkpoint ${new Date().toISOString()}`]);
    commit = (await git(["rev-parse", "HEAD"])).stdout.trim().slice(0, 8);
  }
  try {
    // Push to the explicit URL, never a cached origin: an earlier sync attempt
    // against a dead remote must not stick and swallow every later settle.
    await git(["push", "-q", opts.remote, `${opts.branch}:refs/heads/${opts.branch}`]);
    return { ok: true, acked: true, commit };
  } catch (e) {
    return { ok: false, acked: false, error: String(e).slice(0, 300) };
  }
}

/** Critical-transition guard: capture + sync, FAIL CLOSED unless the remote
 * ACK landed. Returns the sync result; callers must not proceed on !ok. */
export async function requireDurable(opts: CaptureOpts & { remote: string; branch: string; author: { name: string; email: string } }): Promise<SyncResult> {
  const cap = await captureCheckpoint(opts);
  if (!cap.ok) return { ok: false, acked: false, error: `capture refused: ${(cap.refused ?? []).join("; ")}` };
  return syncCheckpoints(opts);
}

/** Sanitized meter projection: per-request ID/bound/state/measured plus
 * reconciled totals. NEVER contains request/response bodies, headers, keys,
 * or prompt fragments - only the wallet-relevant meter state. */
export type MeterProjection = {
  version: 1;
  at: string;
  cumulative: number;
  basis: number;
  totals: { acceptedBound: number; settledMeasured: number; released: number; heldBound: number; provableZero: number; unknownCount: number };
  requests: Record<string, { state: string; bound: number; measured?: number }>;
};


/** Checkpoint debt: a mutation capture that could NOT be durably saved (local
 * capture failed, or the remote ACK failed) is recorded as debt. The next
 * mutation tool, approval pause, or restart MUST settle the debt (successful
 * remote sync) before proceeding - best-effort capture failure must never be
 * silently ignored while work continues. */
export interface DebtEntry { repo: string; reason: string; at: string; error: string }
export function debtPath(stateDir: string): string { return join(stateDir, "checkpoint-debt.json"); }
export function readDebt(stateDir: string): DebtEntry[] {
  try { const d = JSON.parse(readFileSync(debtPath(stateDir), "utf8")); return Array.isArray(d.pending) ? d.pending : []; } catch { return []; }
}
export function recordDebt(stateDir: string, e: DebtEntry): void {
  const pending = [...readDebt(stateDir), e].slice(-50);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(debtPath(stateDir) + ".tmp", JSON.stringify({ version: 1, pending }, null, 1));
  renameSync(debtPath(stateDir) + ".tmp", debtPath(stateDir));
}
export function clearDebt(stateDir: string): void {
  try { rmSync(debtPath(stateDir)); } catch { /* already clear */ }
}
/** Attempt to settle outstanding debt: one remote sync covers every pending
 * entry (checkpoints accumulate in the same local store). Clears the marker
 * only on an ACKed sync. */
export async function settleDebt(stateDir: string, remote: string, branch: string, author: { name: string; email: string }): Promise<{ cleared: boolean; pending: number; error?: string }> {
  const pending = readDebt(stateDir);
  if (pending.length === 0) return { cleared: true, pending: 0 };
  // A no-op sync must NOT clear debt: an empty store means the captured bytes
  // are missing, not saved. The caller must re-capture the worktree first.
  const store = join(stateDir, "checkpoints");
  if (!existsSync(store) || !readdirSync(store).some((f) => f.endsWith(".json"))) {
    return { cleared: false, pending: pending.length, error: "checkpoint store empty - the captured bytes are missing; re-capture the worktree before settling" };
  }
  const sync = await syncCheckpoints({ stateDir, remote, branch, author });
  if (sync.ok) { clearDebt(stateDir); return { cleared: true, pending: 0 }; }
  return { cleared: false, pending: pending.length, error: sync.error };
}

export function buildMeterProjection(events: { ev: string; reqId: string; bound?: number; measured?: number; parsed?: boolean; complete?: boolean; decision?: string }[], reconcile: (ev: never[]) => { requests: Record<string, { state: string; bound: number; measured?: number }>; totals: MeterProjection["totals"] }, cumulative: number, basis: number): MeterProjection {
  const { requests: reservations, totals } = reconcile(events as never[]);
  const requests: MeterProjection["requests"] = {};
  for (const [id, r] of Object.entries(reservations)) requests[id] = { state: r.state, bound: r.bound, ...(r.measured !== undefined ? { measured: r.measured } : {}) };
  return { version: 1, at: new Date().toISOString(), cumulative, basis, totals, requests };
}

/** Idempotent meter sync: one fixed-name projection file (full reconcile
 * every time, so a missed settle sync heals on the next transition), pushed
 * through the same ACK-gated remote sync as worktree checkpoints. */
export async function syncMeter(opts: { stateDir: string; remote: string; branch?: string; projection: MeterProjection }): Promise<{ ok: boolean; acked: boolean; error?: string }> {
  const dir = join(opts.stateDir, "checkpoints");
  mkdirSync(dir, { recursive: true });
  const target = join(dir, "meter-latest.json");
  // Idempotency: `at` is volatile, so a fresh projection of an unchanged meter
  // must reuse the existing timestamp; otherwise every sync writes new bytes
  // and forces a new checkpoint commit for zero information.
  let projection = opts.projection;
  try {
    const prior: MeterProjection = JSON.parse(readFileSync(target, "utf8"));
    const { at: _a, ...priorRest } = prior;
    const { at: _b, ...nextRest } = projection;
    if (JSON.stringify(priorRest) === JSON.stringify(nextRest)) projection = { ...projection, at: prior.at };
  } catch { /* no readable prior: fresh write */ }
  writeFileSync(target + ".tmp", JSON.stringify(projection, null, 1));
  renameSync(target + ".tmp", target);
  return syncCheckpoints({ stateDir: opts.stateDir, remote: opts.remote, branch: opts.branch ?? "auto-checkpoints", author: { name: "sdk-app-checkpoint", email: "checkpoint@localhost" } });
}
