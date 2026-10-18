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
