/** Eval lockdown: when SDK_APP_EVAL_LOCKDOWN=1, factory_run_checks executes
 * inside a bubblewrap sandbox: a fresh network namespace with NO networking
 * plus a mount namespace that exposes only the clone and read-only system
 * dirs - nothing else on the filesystem exists for the command.
 *
 * Why: proxies and command blocking are not isolation. Test code the agent
 * writes runs with the app's full privileges: it can open(2) any file the
 * user can read (vault secrets, grader material) and socket(2) any host
 * (the upstream fix). bwrap removes both: ENETUNREACH for every connection
 * and ENOENT for every path outside the sandbox. If no sandbox tool works,
 * eval checks are REFUSED - lockdown fails closed, never open. */

const BANNED_EXECS = new Set([
  "curl", "wget", "nc", "ncat", "socat", "ssh", "scp", "sftp", "telnet", "ftp",
  "gh", "hub", "pip", "pip3", "pipx", "apt", "apt-get", "yum", "dnf", "brew",
  "docker", "podman", "kubectl", "nslookup", "dig", "host", "ping", "unshare", "bwrap", "sudo",
]);

/** Returns a block reason, or undefined when the command may run. Second
 * layer behind the sandbox: cheap insurance against sandbox misconfig. */
export function checkEvalCommand(cmd: string): string | undefined {
  const tokens = cmd.split(/[\s;|&]+/).map((t) => t.replace(/^['"]|['"]$/g, "")).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const base = t.split("/").pop()!;
    if (BANNED_EXECS.has(base)) return `eval lockdown: '${base}' is not available during evaluation runs`;
    if (base === "python" || base === "python3") {
      if (tokens[i + 1] === "-m" && tokens[i + 2] === "pip") return "eval lockdown: installing packages is not available during evaluation runs";
    }
    if (base === "npm" && /^(i|install|add)$/.test(tokens[i + 1] ?? "")) return "eval lockdown: installing packages is not available during evaluation runs";
    if (/(^|=)(\.\.|~)/.test(t)) return `eval lockdown: paths outside the clone are not available during evaluation runs (${t.slice(0, 40)})`;
  }
  return undefined;
}

/** The lockdown command surface: the kit's git/node commands plus the repo's
 * python test runners (test CODE is unconstrained - the sandbox, not the
 * command filter, is the isolation boundary). */
export const EVAL_SAFE_CMD = new RegExp(
  "^(?!.*(\\$\\(|\\`|>|<))(" +
    "npm (test|run (test[\\w:-]*|typecheck|build|report|render))" +
    "|npm ci\\b[^\\n;|&]*" +
    // Offline native-module self-repair: a dependency whose prebuilt binary
    // cannot download in the network-isolated sandbox can be rebuilt from
    // source (toolchain + node headers are ro-bound). Scoped to explicit
    // package names; same script-execution exposure as the already-allowed
    // npm ci. node-gyp finds headers via --nodedir=/usr.
    "|npm rebuild( [\\w@][\\w@./-]*)+\\b[^\\n;|&]*" +
    "|npx (tsc|tsx --test\\b.*)" +
    "|pytest\\b[^\\n;|&]*" +
    "|python3? -m pytest\\b[^\\n;|&]*" +
    "|(\\.?\\/)?venv\\/bin\\/(pytest|python)\\b[^\\n;|&]*" +
    "|git (status|diff|log|show|blame|branch|rev-parse|ls-files|grep)\\b[^\\n;|&]*" +
    "|git add(?!.*\\s(-A|--all|-u))(?!.*\\s\\.(\\s|$)) -- [^\\n;|&]+" +
    "|git commit\\b[^\\n;|&]*" +
    "|git checkout\\s+(-[bB]\\s+)?[\\w.][\\w./-]*\\s*" +
    "|git rm --cached( -f)? -- [^\\n;|&]+" +
    "|git restore --staged -- [^\\n;|&]+" +
    "|git reset -q -- [^\\n;|&]+" +
    "|grep\\b[^\\n;|&]*" +
    "|ls\\b[^\\n;|&]*" +
    "|cat [\\w./-]+" +
    "|corepack pnpm install\\b[^\\n;|&]*" +
    "|corepack pnpm (exec )?vitest run\\b[^\\n;|&]*" +
    "|corepack pnpm run (test|test:unit|typecheck)\\b[^\\n;|&]*" +
  ")$",
);

import { existsSync } from "node:fs";
import { homedir } from "node:os";

/** Warm package-manager caches bound into the sandbox so the agent can install
 * deps OFFLINE from a fresh clone (eval blindness: no network inside). Only
 * cache dirs - no credentials, no grader paths. Computed once at load. */
/** The lockdown rule, pure and testable: a cache dir is ro-bound into the
 * sandbox IFF it exists on the host. Behavior unchanged; extracted so tests
 * can exercise both branches instead of assuming a host store exists. */
export function computeSandboxExtras(paths: { pnpmStore: string; corepackHome: string; npmCache: string }): { binds: string[]; env: string[] } {
  const binds: string[] = [];
  const env: string[] = [];
  if (existsSync(paths.pnpmStore)) { binds.push("--ro-bind", paths.pnpmStore, "/opt/pnpm-store"); env.push("npm_config_store_dir=/opt/pnpm-store"); }
  if (existsSync(paths.corepackHome)) { binds.push("--ro-bind", paths.corepackHome, "/opt/corepack"); env.push("COREPACK_HOME=/opt/corepack"); }
  if (existsSync(paths.npmCache)) { binds.push("--ro-bind", paths.npmCache, "/opt/npm-cache"); env.push("npm_config_cache=/opt/npm-cache"); }
  return { binds, env };
}

const SANDBOX_EXTRA: { binds: string[]; env: string[] } = computeSandboxExtras({
  pnpmStore: process.env.PNPM_STORE_DIR ?? `${homedir()}/.local/share/pnpm/store`,
  corepackHome: `${homedir()}/.cache/node/corepack`,
  npmCache: process.env.NPM_CACHE_DIR ?? `${homedir()}/.npm`,
});

export type SandboxKind = "bwrap" | "unshare" | "none";

/** Build the sandboxed invocation. bwrap (preferred) isolates mounts + net;
 * unshare -Urn isolates net only (fs escape then relies on the command
 * filter - a weaker boundary, surfaced honestly in the audit). */
export function lockdownInvocation(cmd: string, cloneDir: string, kind: SandboxKind): { file: string; args: string[] } {
  const env = [
    "-i",
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "HOME=/tmp",
    "LANG=C.UTF-8",
    "GIT_TERMINAL_PROMPT=0",
    "GIT_CONFIG_GLOBAL=/dev/null",
    "GH_TOKEN=", "GITHUB_TOKEN=", "GH_CONFIG_DIR=/dev/null",
  ];
  if (kind === "bwrap") return bwrapInvocation(cmd, cloneDir, false);
  return { file: "env", args: [...env, "unshare", "-Urn", "sh", "-c", cmd] };
}

/** Shared bwrap builder. net=false (checks): fresh netns, NO networking.
 * net=true (app server): shares the host network so the app's local browser
 * can reach the dev server on 127.0.0.1 - mounts/secrets stay isolated, but
 * server-side egress is possible and the run is labeled NONBLIND for that
 * component. */
function bwrapInvocation(cmd: string, cloneDir: string, net: boolean): { file: string; args: string[] } {
  const env = [
    "-i",
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "HOME=/tmp",
    "LANG=C.UTF-8",
    "GIT_TERMINAL_PROMPT=0",
    "GIT_CONFIG_GLOBAL=/dev/null",
    "GH_TOKEN=", "GITHUB_TOKEN=", "GH_CONFIG_DIR=/dev/null",
    ...SANDBOX_EXTRA.env,
  ];
  return {
    file: "env",
    args: [
      ...env,
      "bwrap",
      ...(net ? [] : ["--unshare-net"]),
      "--die-with-parent", "--new-session",
      "--ro-bind", "/usr", "/usr",
      "--ro-bind", "/bin", "/bin",
      "--ro-bind", "/lib", "/lib",
      "--ro-bind", "/lib64", "/lib64",
      "--ro-bind", "/etc", "/etc",
      "--dev-bind", "/dev", "/dev",
      "--tmpfs", "/tmp",
      ...SANDBOX_EXTRA.binds,
      "--bind", cloneDir, cloneDir,
      "--chdir", cloneDir,
      "--", "sh", "-c", cmd,
    ],
  };
}

/** App-server variant: mount/secret isolation identical to checks, host
 * network shared (loopback reach for the local browser). NONBLIND label. */
export function appServerInvocation(cmd: string, cloneDir: string): { file: string; args: string[] } {
  return bwrapInvocation(cmd, cloneDir, true);
}
