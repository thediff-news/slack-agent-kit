/** Composition root: wires config -> store -> audit -> RBAC -> RAG ->
 * connectors -> skills -> Runtime. Adapters (Slack, CLI) call buildRuntime
 * with their own hooks. */
import { loadConfig, type KitConfig } from "./core/config.js";
import { SqliteStore } from "./core/store-sqlite.js";
import type { DurableStore } from "./core/store.js";
import { AuditLog } from "./core/audit.js";
import { Permissions } from "./core/permissions.js";
import { SkillRegistry, type SkillContext } from "./core/skills.js";
import { Runtime, type RuntimeHooks } from "./core/runtime.js";
import type { AgentEvent } from "./core/events.js";
import { Rag } from "./rag/rag.js";
import { HashingEmbedder } from "./rag/embed.js";
import { FilesystemConnector } from "./connectors/fs.js";
import { GitHubConnector } from "./connectors/github.js";
import type { Connector } from "./connectors/types.js";
import { CredentialTriageSkill } from "./skills/credential-triage.js";
import { KnowledgeSkill } from "./skills/knowledge.js";
import { IncidentTriageSkill } from "./skills/incident-triage.js";
import { SupportTriageSkill } from "./skills/support-triage.js";
import { AlertRouterSkill } from "./skills/alert-router.js";

export interface Kit {
  config: KitConfig;
  store: DurableStore;
  audit: AuditLog;
  permissions: Permissions;
  rag: Rag;
  connectors: Record<string, Connector>;
  registry: SkillRegistry;
  runtime: Runtime;
}

export async function buildRuntime(configPath: string, hooks: RuntimeHooks): Promise<Kit> {
  const config = loadConfig(configPath);

  // The pi-durable adapter is the foundation store; SQLite remains the
  // zero-friction default while pi-durable's API is experimental.
  let store: DurableStore;
  if (config.store.driver === "pi-durable") {
    const { PiDurableStore } = await import("./core/store-pi.js"); // lazy: keeps node:sqlite warning off the default path
    store = await PiDurableStore.open(config.store.path);
  } else {
    store = new SqliteStore(config.store.path);
  }
  const audit = new AuditLog(config.auditLogPath);
  const permissions = new Permissions(config.permissions);
  const rag = new Rag(config.rag.dbPath, new HashingEmbedder(config.rag.dimensions));

  const connectors: Record<string, Connector> = {};
  for (const [name, cfg] of Object.entries(config.connectors)) {
    if (cfg.type === "filesystem") connectors[name] = new FilesystemConnector(cfg.root);
    if (cfg.type === "github") connectors[name] = new GitHubConnector(cfg.repos.split(",").map((s) => s.trim()));
  }

  const registry = new SkillRegistry();
  const triageRepo = config.connectors["triage-target"]?.root ?? ".";
  registry.register(new CredentialTriageSkill(triageRepo));
  registry.register(new KnowledgeSkill());
  const incidentRepo = config.connectors["incident-target"]?.root ?? triageRepo;
  registry.register(new IncidentTriageSkill(incidentRepo));
  registry.register(new SupportTriageSkill());
  const routerCfg = (config.skills?.["alert-router"] ?? {}) as { routing?: Record<string, string>; escalateThreshold?: number };
  registry.register(new AlertRouterSkill(routerCfg.routing ?? {}, routerCfg.escalateThreshold ?? 3));

  const makeSkillContext = (event: AgentEvent): SkillContext => ({
    store, audit, rag, connectors, config,
    reply: (text) => hooks.notify(event, text),
    enrich: async (query, k = 3) => {
      const hits = rag.retrieve(query, k, permissions.aclsFor(event.actorId));
      return hits.map((h) => `- (${h.source}, ingested ${h.ingestedAt}) ${h.text.slice(0, 300)}`).join("\n");
    },
    aclsFor: (userId) => permissions.aclsFor(userId),
  });

  const runtime = new Runtime(store, audit, permissions, registry, config, hooks, makeSkillContext);
  return { config, store, audit, permissions, rag, connectors, registry, runtime };
}
