/** SDK-native app configuration. All env-driven; no secrets in code. */
export type AppConfig = {
  /** Model the SDK loop runs on. */
  model: string;
  /** Root dir the filesystem connector indexes (docs the agent can search). */
  docsRoot: string;
  /** GitHub repos the github connector can search, e.g. ["thediff-news/slack-agent-kit"]. */
  githubRepos: string[];
  /** Append-only audit JSONL path. */
  auditLog: string;
  /** Approval ledger JSONL path. */
  approvalsLog: string;
  /** Max SDK turns per user message (bounds tool loop + cost per reply). */
  maxTurnsPerMessage: number;
  /** When true (default), mutating tools simulate instead of executing. */
  dryRun: boolean;
  /** Extra env passed to SDK sessions (e.g. ANTHROPIC_BASE_URL for the budget proxy). */
  sessionEnv: Record<string, string>;
};

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    model: env.SDK_APP_MODEL || "claude-sonnet-5-5",
    docsRoot: env.SDK_APP_DOCS_ROOT || "docs",
    githubRepos: (env.SDK_APP_GITHUB_REPOS || "").split(",").map((s) => s.trim()).filter(Boolean),
    auditLog: env.SDK_APP_AUDIT_LOG || "sdk-app/state/audit.jsonl",
    approvalsLog: env.SDK_APP_APPROVALS_LOG || "sdk-app/state/approvals.jsonl",
    maxTurnsPerMessage: Number(env.SDK_APP_MAX_TURNS) || 8,
    dryRun: env.SDK_APP_DRY_RUN !== "0",
    sessionEnv: {
      ...(env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY } : {}),
      ...(env.ANTHROPIC_BASE_URL ? { ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL } : {}),
    },
  };
}
