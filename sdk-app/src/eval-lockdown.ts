/** Eval lockdown: when SDK_APP_EVAL_LOCKDOWN=1, factory_run_checks runs in an
 * OS network namespace with ALL networking removed (unshare -Urn) and a
 * scrubbed environment, and the command passes a sanitizer first.
 *
 * Why: proxy variables and command blocking alone are not isolation - a test
 * can open a raw socket in Python and read the upstream fix. The netns makes
 * every external connection fail with ENETUNREACH regardless of what the
 * command does; the sanitizer + scrubbed env cover what netns cannot (local
 * file escape, git credential leaks). If the namespace cannot be created the
 * check is REFUSED - eval lockdown fails closed, never open. */

const BANNED_EXECS = new Set([
  "curl", "wget", "nc", "ncat", "socat", "ssh", "scp", "sftp", "telnet", "ftp",
  "gh", "hub", "pip", "pip3", "pipx", "apt", "apt-get", "yum", "dnf", "brew",
  "docker", "podman", "kubectl", "nslookup", "dig", "host", "ping", "unshare", "bwrap", "sudo",
]);
const GIT_ALLOWED = new Set(["status", "diff", "log", "show", "blame", "branch", "rev-parse", "ls-files", "grep", "describe", "tag", "checkout", "switch", "add", "commit", "stash"]);

/** Returns a block reason, or undefined when the command may run. */
export function checkEvalCommand(cmd: string): string | undefined {
  const tokens = cmd.split(/[\s;|&]+/).map((t) => t.replace(/^['"]|['"]$/g, "")).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const base = t.split("/").pop()!;
    if (BANNED_EXECS.has(base)) return `eval lockdown: '${base}' is not available during evaluation runs`;
    if (base === "git") {
      const sub = tokens[i + 1];
      if (!sub || !GIT_ALLOWED.has(sub)) return `eval lockdown: 'git ${sub ?? ""}' is not available during evaluation runs (read-only git only)`;
    }
    if (base === "python" || base === "python3" || base === "pip") {
      if (tokens[i + 1] === "-m" && tokens[i + 2] === "pip") return "eval lockdown: installing packages is not available during evaluation runs";
    }
    if (base === "npm" && /^(i|install|ci|add)$/.test(tokens[i + 1] ?? "")) return "eval lockdown: installing packages is not available during evaluation runs";
    // local file escape: no parent refs, no absolute paths, no home refs
    if (/(^|=)(\.\.|~)/.test(t) || /(^|=)\//.test(t)) return `eval lockdown: paths outside the clone are not available during evaluation runs (${t.slice(0, 40)})`;
  }
  return undefined;
}

/** Build the sandboxed invocation: env scrubbed to a whitelist, netns removes
 * all networking, loopback brought up inside for in-process test clients. */
export function lockdownInvocation(cmd: string, scriptPath: string): { file: string; args: string[] } {
  return {
    file: "env",
    args: [
      "-i",
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      `HOME=${process.env.HOME ?? "/tmp"}`,
      "LANG=C.UTF-8",
      "GIT_TERMINAL_PROMPT=0",
      "GIT_CONFIG_GLOBAL=/dev/null",
      "GH_TOKEN=", "GITHUB_TOKEN=", "GH_CONFIG_DIR=/dev/null",
      "unshare", "-Urn", "sh", scriptPath,
    ],
  };
}
