import type { AgentEvent } from "../core/events.js";
import type { Skill, SkillContext, SkillResult } from "../core/skills.js";
import { actionKey } from "../core/runtime.js";

/**
 * Reference skill: company brain / knowledge.
 *
 *  - "what do we know about X" (or any "?") -> answers from the ingested
 *    document store, with citations and source freshness. Retrieval is
 *    permissions-aware: chunks tagged with an ACL the asker lacks are
    invisible to them, so the bot can honestly say "I don't know".
 *  - "ingest <path>" -> proposes a GATED action to add a document to the
 *    knowledge base. Ingestion is mutating: it changes what the bot will
 *    tell everyone, so a human approves it.
 *
 * Honesty rule: no retrieval hits -> say so. Never invent an answer.
 */
export class KnowledgeSkill implements Skill {
  name = "company-brain";
  description = "Answer questions from ingested docs with citations; ingest new docs on command.";
  // Asking questions is read-only; the ingest ACTION is mutating and is
  // gated on its own, so the skill itself stays tier "read".
  tier = "read" as const;

  matches(event: AgentEvent): boolean {
    const t = event.text.trim().toLowerCase();
    return t.endsWith("?") || t.startsWith("what do we know") || t.startsWith("ingest ");
  }

  async handle(event: AgentEvent, ctx: SkillContext): Promise<SkillResult> {
    const text = event.text.trim();

    const ingestMatch = /^ingest\s+(\S+)/i.exec(text);
    if (ingestMatch) {
      const docPath = ingestMatch[1];
      const connector = ctx.connectors["docs"];
      if (!connector) return { findings: "No `docs` connector configured - cannot ingest.", actions: [] };
      const doc = await connector.get(docPath);
      if (!doc) return { findings: `Cannot read \`${docPath}\` via the docs connector.`, actions: [] };
      // ACL convention: a first line of the form `acl: <tag>` tags the document.
      const acl = /^acl:\s*(\S+)/m.exec(doc.body)?.[1] ?? "public";
      return {
        findings: `Ready to ingest \`${docPath}\` (${doc.body.length} chars, ACL \`${acl}\`) into the knowledge base. This changes what I will tell everyone - needs approval.`,
        actions: [{
          key: actionKey("ingest", docPath, String(doc.body.length)),
          tier: "mutating",
          summary: `Ingest ${docPath} into the knowledge base (ACL: ${acl})`,
          run: async () => {
            const n = ctx.rag.ingest(docPath, doc.body, acl);
            await ctx.store.set("kb", `ingested:${docPath}`, new Date().toISOString());
            return `ingested ${n} new chunk(s) from ${docPath} (ACL: ${acl})`;
          },
        }],
      };
    }

    const question = text.replace(/^(what do we know( about)?|kb:)\s*/i, "").replace(/\?+$/, "");
    const acls = ctx.aclsFor(event.actorId);
    const hits = ctx.rag.retrieve(question, 4, acls);
    if (hits.length === 0) {
      return {
        findings: `I don't have anything on that in my knowledge base (searched ${acls.map((a) => `\`${a}\``).join(", ")} documents). Teach me with \`ingest <path>\`.`,
        actions: [],
      };
    }
    const oldest = hits.map((h) => h.ingestedAt).sort()[0];
    const findings = [
      `*What I know about "${question}":*`,
      "",
      ...hits.map((h, i) => `${i + 1}. ${h.text.slice(0, 400)}`),
      "",
      "*Sources:*",
      ...hits.map((h) => `- \`${h.source}\` (acl: ${h.acl}, ingested ${h.ingestedAt})`),
      `_Freshness: oldest cited source ingested ${oldest}. Retrieval scoped to your ACLs: ${acls.join(", ")}._`,
    ].join("\n");
    return { findings, actions: [] };
  }
}
