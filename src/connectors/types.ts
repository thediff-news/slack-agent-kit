/** A connector plugs an internal source into the bot: skills query it for
 * documents and live state. Implementations must be read-only; writes go
 * through approval-gated actions, never through a connector. */
export interface Connector {
  name: string;
  /** Free-text search over the source; returns document bodies with stable IDs. */
  search(query: string, limit?: number): Promise<ConnectorDoc[]>;
  /** Fetch one document by the ID returned from search. */
  get(id: string): Promise<ConnectorDoc | undefined>;
}

export interface ConnectorDoc {
  id: string;
  title: string;
  body: string;
  url?: string;
  /** Default RAG ACL tag for this doc, from the connector's config. An
   * explicit `acl:` first line in the body still wins on ingest. */
  acl?: string;
}

/** A doc returned by a sync listing, with its source-side modification time
 * (ISO string) when the source exposes one. */
export interface SyncedDoc extends ConnectorDoc {
  lastModified?: string;
}

export interface SyncListing {
  docs: SyncedDoc[];
  /** true when the listing covers every doc the connector can see, so the
   * sync engine may delete index entries that are missing from it. false
   * for incremental (since-cursor) or capped listings. */
  complete: boolean;
}

/** A connector that can be crawled automatically by the sync engine. */
export interface SyncableConnector extends Connector {
  /** List docs visible to this connector, optionally only those modified
   * after `since` (ISO string from the previous sync run). */
  list(since?: string): Promise<SyncListing>;
}

export function isSyncable(c: Connector): c is SyncableConnector {
  return typeof (c as SyncableConnector).list === "function";
}
