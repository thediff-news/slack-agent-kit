/**
 * Isolation probe for the Claude code-stage sandbox (no API key needed).
 *
 * Runs six checks through the SAME srt settings the pipeline builds for a
 * Claude code round, and prints PASS/FAIL evidence per check:
 *   1. files under $HOME outside the workdir are unreadable (read confinement)
 *   2. files inside the workdir are readable
 *   3. writes outside the workdir do not land
 *   4. writes inside the workdir work
 *   5. api.anthropic.com is reachable through the sandbox proxy (SDK egress)
 *   6. any other host is blocked by the network allowlist
 *
 * Usage: npx tsx scripts/claude-sandbox-probe.mts
 * Exit code 0 only if every check passes.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const srt = join(REPO_ROOT, "node_modules", ".bin", "srt");
const work = join(tmpdir(), `srt-probe-${process.pid}`);
mkdirSync(work, { recursive: true });
writeFileSync(join(work, "workfile.txt"), "workdir-file-ok");
const canary = join(homedir(), "srt-probe-canary.txt");
writeFileSync(canary, "TOP-SECRET-CANARY");

const settings = {
  filesystem: {
    denyRead: [homedir()],
    allowRead: [work, join(REPO_ROOT, "node_modules")],
    allowWrite: [work, tmpdir()],
    denyWrite: [],
  },
  network: { allowedDomains: ["api.anthropic.com"], deniedDomains: [] },
};
const settingsFile = join(work, "srt-settings.json");
writeFileSync(settingsFile, JSON.stringify(settings, null, 2));

function run(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(srt, ["--settings", settingsFile, "--", ...args], { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (e: any) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

const results: { name: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail: string) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}  (${detail.trim().split("\n").pop()?.slice(0, 120)})`);
};

// 1. $HOME read outside workdir is confined (bwrap: file is not even visible)
let r = run(["cat", canary]);
check("read $HOME canary blocked", r.code !== 0 && !r.out.includes("TOP-SECRET-CANARY"), r.out || `rc=${r.code}`);
// 2. workdir read works
r = run(["cat", join(work, "workfile.txt")]);
check("read workdir file works", r.code === 0 && r.out.includes("workdir-file-ok"), r.out);
// 3. write outside workdir does not land
const escapePath = join(homedir(), `srt-probe-escape-${process.pid}.txt`);
r = run(["touch", escapePath]);
check("write outside workdir blocked", !existsSync(escapePath), existsSync(escapePath) ? "FILE CREATED - ESCAPE" : "no file created");
// 4. write inside workdir works
r = run(["bash", "-c", `echo wrote > ${join(work, "inside.txt")}`]);
check("write inside workdir works", existsSync(join(work, "inside.txt")), `rc=${r.code}`);
// 5. api.anthropic.com reachable (401 unauthenticated = TLS+API through proxy)
r = run(["curl", "-sS", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "20", "https://api.anthropic.com/v1/models"]);
check("api.anthropic.com reachable", r.out.trim() === "401", `http=${r.out.trim()} rc=${r.code}`);
// 6. non-allowlisted host blocked
r = run(["curl", "-sS", "--max-time", "10", "-o", "/dev/null", "-w", "%{http_code}", "https://example.com"]);
check("example.com blocked", r.code !== 0 || r.out.trim().startsWith("000"), `http=${r.out.trim()} rc=${r.code}`);

rmSync(canary, { force: true });
rmSync(escapePath, { force: true });
const failed = results.filter((x) => !x.pass);
console.log(failed.length === 0 ? "ALL 6 CHECKS PASSED" : `${failed.length} CHECKS FAILED`);
process.exit(failed.length === 0 ? 0 : 1);
