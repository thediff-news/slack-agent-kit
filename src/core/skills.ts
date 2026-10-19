import type { AgentEvent } from "./events.js";
import type { AuditLog } from "./audit.js";
import type { DurableStore } from "./store.js";
import type { Rag } from "../rag/rag.js";
import type { Connector } from "../connectors/types.js";
import type { Tier } from "./permissions.js";
import type { KitConfig } from "./config.js";
import type { Llm } from "../llm/openai.js";

/** A unit of work the agent wants to do. Mutating actions only run after approval. */
export interface ProposedAction {
  /** Idempotency key: stable per logical action, so retries and duplicates never re-execute. */
  key: string;
  tier: Tier;
  summary: string;
  run(): Promise<string>;
}

export interface SkillResult {
  /** Human-readable findings, posted back to the channel. */
  findings: string;
  actions: ProposedAction[];
}

export interface SkillContext {
  store: DurableStore;
  audit: AuditLog;
  rag: Rag;
  connectors: Record<string, Connector>;
  config: KitConfig;
  /** Post a message back to the originating channel/thread. */
  reply(text: string): Promise<void>;
  /** Ask the RAG for context and append source links. */
  enrich(query: string, k?: number): Promise<string>;
  /** Knowledge-base ACL tags this user may see ("public" always included). */
  aclsFor(userId: string): string[];
  /** Post a file (e.g. a screenshot) back to the channel/thread. Slack-only. */
  replyFile?(path: string, caption?: string): Promise<void>;
  /** Mid-skill approval gate (browse allowlist adds, irreversible clicks). */
  askApproval?(summary: string): Promise<boolean>;
  /** Optional hosted LLM (e.g. OpenAI, enabled via env). Undefined in the keyless kit. */
  llm?: Llm;
}

export interface Skill {
  name: string;
  description: string;
  tier: Tier;
  /** Cheap synchronous routing check. */
  matches(event: AgentEvent): boolean;
  handle(event: AgentEvent, ctx: SkillContext): Promise<SkillResult>;
}

export class SkillRegistry {
  private skills: Skill[] = [];
  register(skill: Skill): void {
    this.skills.push(skill);
  }
  match(event: AgentEvent): Skill | undefined {
    return this.skills.find((s) => s.matches(event));
  }
  list(): Skill[] {
    return [...this.skills];
  }
}
