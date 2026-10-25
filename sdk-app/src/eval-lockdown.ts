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
    if (base === "npm" && /^(i|install|ci|add)$/.test(tokens[i + 1] ?? "")) return "eval lockdown: installing packages is not available during evaluation runs";
    if (/(^|=)(\.\.|~)/.test(t)) return `eval lockdown: paths outside the clone are not available during evaluation runs (${t.slice(0, 40)})`;
  }
  return undefined;
}

/** The lockdown command surface: the kit's git/node commands plus the repo's
 * python test runners (test CODE is unconstrained - the sandbox, not the
 * command filter, is the isolation boundary). */
export const EVAL_SAFE_CMD = new RegExp(
  "^(?!.*(\\$\\(|\\`|>|<))(" +
    "npm (test|run (test|typecheck|build|report|render))" +
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
  ")$",
);

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
  if (kind === "bwrap") {
    return {
      file: "env",
      args: [
        ...env,
        "bwrap",
        "--unshare-net", "--die-with-parent", "--new-session",
        "--ro-bind", "/usr", "/usr",
        "--ro-bind", "/bin", "/bin",
        "--ro-bind", "/lib", "/lib",
        "--ro-bind", "/lib64", "/lib64",
        "--ro-bind", "/etc", "/etc",
        "--dev-bind", "/dev", "/dev",
        "--tmpfs", "/tmp",
        "--bind", cloneDir, cloneDir,
        "--chdir", cloneDir,
        "--", "sh", "-c", cmd,
      ],
    };
  }
  return { file: "env", args: [...env, "unshare", "-Urn", "sh", "-c", cmd] };
}
