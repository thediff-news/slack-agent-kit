export type Capability = "read" | "propose" | "execute" | "approve";
export type Tier = "read" | "mutating";

export interface PermissionsConfig {
  roles: Record<string, Capability[]>;
  users: Record<string, string>;
  approvers: string[];
  channels: Record<string, { allow: string[] }>;
}

/**
 * RBAC for the bot. Rules:
 *  - a user needs "propose" to trigger a mutating skill, "read" for read-only
 *  - a channel must list the skill in `allow` (a "*" entry allows all)
 *  - mutating actions always need human approval regardless of role;
 *    "execute" is the agent-side capability, never granted to the bot itself
 *    for mutating actions without an approval record
 */
export class Permissions {
  constructor(private cfg: PermissionsConfig) {}

  private caps(userId: string): Capability[] {
    const role = this.cfg.users[userId] ?? "viewer";
    return this.cfg.roles[role] ?? [];
  }

  canTrigger(userId: string, skillName: string, tier: Tier, channelId: string): { ok: boolean; reason?: string } {
    const chan = this.cfg.channels[channelId];
    if (chan && !chan.allow.includes("*") && !chan.allow.includes(skillName)) {
      return { ok: false, reason: `skill ${skillName} is not allowed in channel ${channelId}` };
    }
    const needed: Capability = tier === "mutating" ? "propose" : "read";
    if (!this.caps(userId).includes(needed)) {
      return { ok: false, reason: `user ${userId} lacks '${needed}' (role ${this.cfg.users[userId] ?? "viewer"})` };
    }
    return { ok: true };
  }

  canApprove(userId: string): boolean {
    return this.cfg.approvers.includes(userId) || this.caps(userId).includes("approve");
  }
}
