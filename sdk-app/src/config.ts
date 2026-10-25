/** SDK-native app configuration. All env-driven; no secrets in code. */
export type Capability = "read" | "propose" | "execute" | "approve";

export type AppConfig = {
  /** Model the SDK loop runs on. */
  model: string;
  /** Optional cheaper model for turns that carry no factory signals at all
   * (plain chat). Empty = every turn runs `model`. The SDK fixes the model per
   * query() turn, so a chat-classified turn that escalates mid-turn stays on
   * the chat model until the next message; the classifier therefore errs
   * toward `model` on any ambiguity. */
  chatModel: string;
  /** Root dir the filesystem connector indexes (docs the agent can search). */
  docsRoot: string;
  /** GitHub repos the github connector can search, e.g. ["thediff-news/slack-agent-kit"]. */
  githubRepos: string[];
  /** Eval lockdown: run_checks is sandboxed (netns, no network) + command-sanitized. */
  evalLockdown: boolean;
  /** Append-only audit JSONL path. */
  auditLog: string;
  /** Private remote (URL or file://) the auto-checkpoint syncs to; when set, critical transitions require its ACK (fail closed). */
  checkpointRemote?: string;
  /** Budget-proxy ledger path for the sanitized cost projection. */
  proxyState?: string;
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
  /** Connector settings (SDK_APP_CONNECTORS JSON array). Empty = legacy
   * default: filesystem docsRoot + github repos. */
  connectors: import("./connectors.js").ConnectorCfg[];
  /** Retrieval ACL tags for a requester: undefined = unfiltered (operator/"*"). */
  aclTagsFor(userId?: string): string[] | undefined;
  /** A requester we can bind to a configured identity (ACL entry or named approver). */
  isKnownIdentity(userId?: string): boolean;
  /** Approval authority comes ONLY from the approvers list - ACL enrollment
   * must never grant it (no role collapse). */
  isApprover(userId?: string): boolean;
  /** Explicit opt-in: let UNENROLLED users run sync_docs (index rebuild).
   * Default false: sync mutates the index and discloses existence counts. */
  publicSync: boolean;
  /** Roles/capabilities model ported from the kit's core/permissions.ts.
   * users maps Slack user ID -> ONE role (default "viewer"); roles maps role
   * -> capabilities ("read"|"propose"|"execute"|"approve"); roleAcls adds RAG
   * tags per role; channels maps channel ID -> tool allowlist ("*" = all).
   * Env: SDK_APP_RBAC_USERS / SDK_APP_RBAC_ROLES / SDK_APP_RBAC_ROLE_ACLS /
   * SDK_APP_CHANNEL_POLICIES, all JSON. Missing maps fail closed. */
  rbac: {
    users: Record<string, string>;
    roles: Record<string, Capability[]>;
    roleAcls: Record<string, string[]>;
    channels: Record<string, { allow: string[] }>;
  };
  /** Capability set for a requester. Unknown users still get "read" (public
   * docs only); operator surfaces are unrestricted. */
  capsFor(userId: string | undefined, operator: boolean): Capability[];
};

/** Words that mark a turn as factory-grade work (or a screenshot rides in).
 * Conservative on purpose: misses cost quality, false positives only cost money. */
const FACTORY_SIGNAL = /\b(bug|error|fix|broken|wrong|fail\w*|crash|regression|screenshot|repo|commit|branch|pr|pull request|deploy|implement|refactor|test|issue|incident|stack\s?trace|exception|slow\w*|investigat\w*|triage)\b/i;

/** Per-turn model routing. Any factory signal or an attached image -> the main
 * model; only plainly conversational turns take chatModel. */
export function pickModel(cfg: Pick<AppConfig, "model" | "chatModel">, text: string, hasImages: boolean): string {
  if (!cfg.chatModel || cfg.chatModel === cfg.model) return cfg.model;
  if (hasImages) return cfg.model;
  return FACTORY_SIGNAL.test(text) ? cfg.model : cfg.chatModel;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): AppConfig {
  let userAcls: Record<string, string[]> = {};
  try {
    userAcls = JSON.parse(env.SDK_APP_USER_ACLS || "{}") as Record<string, string[]>;
  } catch {
    userAcls = {}; // fail closed: a broken map grants nothing
  }
  const j = (raw?: string): any => { try { return JSON.parse(raw || "{}") } catch { return {}; } };
  const cfg: AppConfig = {
    model: env.SDK_APP_MODEL || "claude-sonnet-5-5",
    chatModel: env.SDK_APP_MODEL_CHAT || "",
    docsRoot: env.SDK_APP_DOCS_ROOT || "docs",
    githubRepos: (env.SDK_APP_GITHUB_REPOS || "").split(",").map((s) => s.trim()).filter(Boolean),
    evalLockdown: (env.SDK_APP_EVAL_LOCKDOWN || "") === "1",
    auditLog: env.SDK_APP_AUDIT_LOG || "sdk-app/state/audit.jsonl",
    checkpointRemote: env.SDK_APP_CHECKPOINT_REMOTE || undefined,
    proxyState: env.SDK_APP_PROXY_STATE || undefined,
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
      const role = (userId && cfg.rbac.users[userId]) || "viewer";
      const extra = [...((userId && userAcls[userId]) || []), ...(cfg.rbac.roleAcls[role] || [])];
      if (extra.includes("*")) return undefined; // unfiltered
      return [...new Set(["public", ...extra])];
    },
    capsFor(userId, operator) {
      if (operator) return ["read", "propose", "execute", "approve"];
      const role = (userId && cfg.rbac.users[userId]) || "viewer";
      return [...new Set<Capability>(["read", ...(cfg.rbac.roles[role] || [])])];
    },
    isKnownIdentity(userId?: string) {
      return Boolean(userId && (userAcls[userId] !== undefined || cfg.approvers.includes(userId)));
    },
    isApprover(userId?: string) {
      // approvers list OR an explicit "approve" capability via role - the
      // per-user ACL map (userAcls) never grants approval authority.
      return Boolean(userId) && (cfg.approvers.includes(userId!) || cfg.capsFor(userId, false).includes("approve"));
    },
    publicSync: env.SDK_APP_PUBLIC_SYNC === "1",
    connectors: (() => { try { return JSON.parse(env.SDK_APP_CONNECTORS || "[]") } catch { return []; } })(),
    rbac: {
      users: j(env.SDK_APP_RBAC_USERS),
      roles: j(env.SDK_APP_RBAC_ROLES),
      roleAcls: j(env.SDK_APP_RBAC_ROLE_ACLS),
      channels: j(env.SDK_APP_CHANNEL_POLICIES),
    },
  };
  return cfg;
}

/** EVAL-context startup preflight: returns every missing required setting as a
 * human-readable problem (empty = OK). Silent defaults have silently disabled
 * enrollment/allowlists before; run-slack fails fast on any problem when
 * SDK_APP_EVAL_LOCKDOWN=1. */
export function evalPreflightProblems(c: ReturnType<typeof configFromEnv>): string[] {
  const problems: string[] = [];
  if (!c.evalLockdown) problems.push("SDK_APP_EVAL_LOCKDOWN is not '1'");
  if (c.githubRepos.length === 0) problems.push("SDK_APP_GITHUB_REPOS is empty (agent cannot clone the case repo)");
  if (c.approvers.length === 0) problems.push("SDK_APP_APPROVERS is empty (nobody can approve)");
  if (Object.keys(c.userAcls).length === 0) problems.push("SDK_APP_USER_ACLS is empty (no enrolled identity; agent is locked out of factory/browser)");
  if (c.dryRun) problems.push("SDK_APP_DRY_RUN is not 0 (writes would be simulated)");
  if (!process.env.SDK_APP_PROXY_CAP_USD) problems.push("SDK_APP_PROXY_CAP_USD unset (budget cap would silently default)");
  if (!process.env.SDK_APP_PROXY_STATE) problems.push("SDK_APP_PROXY_STATE unset (spend ledger not durable)");
  if (!process.env.SDK_APP_CHECKPOINT_REMOTE) problems.push("SDK_APP_CHECKPOINT_REMOTE unset (worktree/evidence checkpoints are local-only; a sandbox rebuild would lose uncommitted work)");
  const rbacOk = Object.entries(c.rbac.users).some(([u, role]) => (c.rbac.roles[role] ?? []).includes("propose") && (c.userAcls[u] !== undefined || c.approvers.includes(u)));
  if (!rbacOk) problems.push("no enrolled identity has an RBAC role granting 'propose' (SDK_APP_RBAC_USERS/SDK_APP_RBAC_ROLES) - factory/browser stay locked");
  return problems;
}
