import { createHash } from "node:crypto";

export type EventSource = "slack" | "cli" | "webhook";
export type EventKind = "mention" | "channel_message" | "alert" | "approval_response";

/** Normalized inbound event. Every adapter (Slack, CLI, webhook) produces these. */
export interface AgentEvent {
  /** Idempotency key, derived from source + sourceEventId. */
  id: string;
  source: EventSource;
  kind: EventKind;
  /** Slack user ID, CLI username, webhook caller. */
  actorId: string;
  channelId: string;
  text: string;
  threadId?: string;
  receivedAt: string;
  raw?: unknown;
}

export function makeEventId(source: EventSource, sourceEventId: string): string {
  return createHash("sha256").update(`${source}:${sourceEventId}`).digest("hex").slice(0, 32);
}
