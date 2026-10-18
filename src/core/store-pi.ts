/**
 * PiDurableStore: DurableStore on @earendil-works/pi-durable.
 *
 * Kit state (events, approvals, executions, kv) lives in typed pi-durable
 * documents on the root conversation, mutated only inside atomic commits.
 * pi-durable's rule is ours: state is committed before anything is shown,
 * so a crash mid-approval reopens the store and finds the pending approval
 * exactly where it stopped. Storage is pi-durable's own SQLite backend.
 *
 * This is the foundation Ziv asked for; the SQLite store remains the default
 * driver while pi-durable's API is experimental. Select with
 * `store.driver: pi-durable` in kit.config.yaml.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, defineDoc, Harness } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Approval, DurableStore } from "./store.js";

interface KitState {
  [key: string]: any;
  events: Record<string, { source: string; kind: string; actorId: string; payload: string }>;
  approvals: Record<string, Approval>;
  executions: Record<string, { resultSummary: string; executedAt: string }>;
  kv: Record<string, string>;
}

const KitStateDoc = defineDoc<KitState>({
  kind: "kit.state",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ events: {}, approvals: {}, executions: {}, kv: {} }),
});

export class PiDurableStore implements DurableStore {
  private constructor(
    private harness: Harness,
    private rootId: any,
    private root: any,
    private context: any,
  ) {}

  static async open(path: string): Promise<PiDurableStore> {
    const context = BACKGROUND_CONTEXT;
    const storage = await openNodeSqliteStorage(path);
    const harness = await Harness.open(storage, { models: createModels(), registry: createRegistry() }, context);
    const root = await harness.root(context, {});
    return new PiDurableStore(harness, root.id, root, context);
  }

  private async state(): Promise<KitState> {
    const snap = (await this.harness.snapshot(KitStateDoc, this.rootId, this.context)) as unknown as KitState | undefined;
    return structuredClone(snap ?? { events: {}, approvals: {}, executions: {}, kv: {} });
  }

  private async mutate(fn: (s: KitState) => void): Promise<void> {
    await this.root.commit(async (tx: any) => {
      fn(await tx.doc(KitStateDoc, this.rootId));
    }, this.context);
  }

  async recordEvent(id: string, source: string, kind: string, actorId: string, payload: string): Promise<"new" | "duplicate"> {
    const existing = (await this.state()).events[id];
    if (existing) return "duplicate";
    await this.mutate((s) => { s.events[id] = { source, kind, actorId, payload }; });
    return "new";
  }

  async createApproval(a: Approval): Promise<void> {
    await this.mutate((s) => { s.approvals[a.id] ??= a; });
  }

  async getApproval(id: string): Promise<Approval | undefined> {
    return (await this.state()).approvals[id];
  }

  async pendingApprovals(): Promise<Approval[]> {
    return Object.values((await this.state()).approvals).filter((a) => a.status === "pending");
  }

  async resolveApproval(id: string, decision: "approved" | "denied", by: string): Promise<boolean> {
    let won = false;
    await this.mutate((s) => {
      const a = s.approvals[id];
      if (a && a.status === "pending") {
        a.status = decision;
        a.resolvedBy = by;
        a.resolvedAt = new Date().toISOString();
        won = true;
      }
    });
    return won;
  }

  async hasExecuted(actionKey: string): Promise<boolean> {
    return actionKey in (await this.state()).executions;
  }

  async markExecuted(actionKey: string, resultSummary: string): Promise<void> {
    await this.mutate((s) => { s.executions[actionKey] ??= { resultSummary, executedAt: new Date().toISOString() }; });
  }

  async get(scope: string, key: string): Promise<string | undefined> {
    return (await this.state()).kv[`${scope}:${key}`];
  }

  async set(scope: string, key: string, value: string): Promise<void> {
    await this.mutate((s) => { s.kv[`${scope}:${key}`] = value; });
  }

  async close(): Promise<void> {
    await this.harness.close(this.context);
  }
}
