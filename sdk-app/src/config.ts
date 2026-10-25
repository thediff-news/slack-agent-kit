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
  /** Ranked index DB path. */
  ragDb: string;
  /** Seed hosts for the browse allowlist (persisted file wins once written). */
  browseAllowlist: string[];
  /** Named approvers (Slack user IDs) for the Slack surface. */
  approvers: string[];
  /** Slack user ID -> RAG ACL tags (SDK_APP_USER_ACLS JSON, e.g. {"U123":["engineering"]}).
   * Unknown users get ["public"]; a user tagged "*" sees everything. */
  userAcls: Record<string, string[]>;
  /** Retrieval ACL tags for a requester: undefined = unfiltered (operator/"*"). */
  aclTagsFor(userId?: string): string[] | undefined;
  /** A requester we can bind to a configured identity (ACL entry or named approver). */
  isKnownIdentity(userId?: string): boolean;
};

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): AppConfig {
  let userAcls: Record<string, string[]> = {};
  try {
    userAcls = JSON.parse(env.SDK_APP_USER_ACLS || "{}") as Record<string, string[]>;
  } catch {
    userAcls = {}; // fail closed: a broken map grants nothing
  }
  const cfg: AppConfig = {
    model: env.SDK_APP_MODEL || "claude-sonnet-5-5",
    docsRoot: env.SDK_APP_DOCS_ROOT || "docs",
    githubRepos: (env.SDK_APP_GITHUB_REPOS || "").split(",").map((s) => s.trim()).filter(Boolean),
    auditLog: env.SDK_APP_AUDIT_LOG || "sdk-app/state/audit.jsonl",
    approvalsLog: env.SDK_APP_APPROVALS_LOG || "sdk-app/state/approvals.jsonl",
    maxTurnsPerMessage: Number(env.SDK_APP_MAX_TURNS) || 8,
    dryRun: env.SDK_APP_DRY_RUN !== "0",
    ragDb: env.SDK_APP_RAG_DB || "sdk-app/state/rag.db",
    browseAllowlist: (env.SDK_APP_BROWSE_ALLOWLIST || "").split(",").map((x) => x.trim()).filter(Boolean),
    approvers: (env.SDK_APP_APPROVERS || "").split(",").map((x) => x.trim()).filter(Boolean),
    userAcls,
    sessionEnv: {
      ...(env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY } : {}),
      ...(env.ANTHROPIC_BASE_URL ? { ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL } : {}),
    },
    aclTagsFor(userId?: string) {
      const extra = (userId && userAcls[userId]) || [];
      if (extra.includes("*")) return undefined; // unfiltered
      return [...new Set(["public", ...extra])];
    },
    isKnownIdentity(userId?: string) {
      return Boolean(userId && (userAcls[userId] !== undefined || cfg.approvers.includes(userId)));
    },
  };
  return cfg;
}
