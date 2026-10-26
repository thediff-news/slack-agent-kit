/** Bounded stall detection and escalation.
 *
 * The agent normally recovers from a gate refusal by doing the missing work
 * (a corrected factory_write_file refusal is NORMAL operation, never a stall).
 * Escalation fires only on bounded, reasoned stall signals:
 *   1. gate-refusal loop: the SAME refusal signature (same tool, same
 *      normalized reason) hit REFUSAL_THRESHOLD times in one turn - the model
 *      is retrying identical refused work instead of correcting course;
 *   2. turn exhaustion: the SDK ended the turn at the max-turns limit;
 *   3. error loop: ERROR_THRESHOLD consecutive turn errors on one thread.
 *
 * On a signal the turn is stopped (in-turn signals abort the query loop to
 * stop spend), an "escalation" event lands in the hash-chained audit log, and
 * the surface gets onEscalated with a compact brief: what stalled, the exact
 * refusal/error, and what a human can do. Escalation NEVER auto-retries:
 * a retry is a new human-approved instruction (fresh session, fresh clone,
 * fresh case), never a replay of the stalled run's writes, and the shared
 * cost ledger is untouched by it. */
export type StallSignal =
  | { kind: "gate-refusal-loop"; tool: string; refusal: string; count: number }
  | { kind: "turn-exhausted"; numTurns?: number }
  | { kind: "error-loop"; consecutive: number; last: string };

export const REFUSAL_THRESHOLD = 3;
export const ERROR_THRESHOLD = 3;

/** Normalize a tool-result/permission text to a stable refusal signature, or
 * null when the text is not a refusal. Volatile bits (approval ids, diff
 * hashes, numbers) are stripped so the same recurring reason counts up. */
export function refusalSignature(text: string): string | null {
  const t = text.trim();
  const patterns: [RegExp, string][] = [
    [/^REFUSED: the branch changed after approval/i, "diff-changed-after-approval"],
    [/^REFUSED:/i, `refused:${t.slice(0, 120).replace(/[0-9a-f]{8,}/gi, "#")}`],
    [/no BEFORE-FIX UI evidence recorded/i, "no-before-ui-evidence"],
    [/no AFTER-FIX UI evidence|after-fix .* stale|evidence is stale/i, "stale-or-missing-after-evidence"],
    [/no failing regression test|regression test .* (missing|required)/i, "no-failing-regression-test"],
    [/full (test|check) run .* (missing|required|stale)/i, "no-full-check-run"],
    [/Denied by human \(approval [0-9a-f-]+\)/i, "human-denied-approval"],
    [/Human refused to allowlist/i, "host-allowlist-denied"],
    [/Human denied the irreversible click/i, "irreversible-click-denied"],
    [/identity is not enrolled/i, "identity-not-enrolled"],
    [/lacks the 'propose' capability/i, "capability-denied"],
    [/is not allowed in this channel/i, "channel-denied"],
    [/workflow-incomplete/i, "workflow-incomplete"],
  ];
  for (const [re, sig] of patterns) if (re.test(t)) return sig.replace(/\s+/g, " ").slice(0, 160);
  return null;
}

export function describeStall(s: StallSignal): string {
  switch (s.kind) {
    case "gate-refusal-loop":
      return `stalled: hit the same gate refusal ${s.count}x on ${s.tool} (${s.refusal}) without correcting course`;
    case "turn-exhausted":
      return `stalled: ran out of turns${s.numTurns ? ` (${s.numTurns})` : ""} without reaching a verdict`;
    case "error-loop":
      return `stalled: ${s.consecutive} consecutive errors, last: ${s.last.slice(0, 160)}`;
  }
}

export class StallDetector {
  private refusals = new Map<string, number>();
  private consecutiveErrors = 0;

  /** Feed one tool-result text (per turn). Returns the signal on the call
   * that reaches the threshold, else null. Non-refusal results do not reset
   * a signature's count: interleaved reads between identical refused retries
   * are still a loop. */
  observeToolResult(tool: string, text: string): StallSignal | null {
    const refusal = refusalSignature(text);
    if (!refusal) return null;
    const key = `${tool}::${refusal}`;
    const count = (this.refusals.get(key) ?? 0) + 1;
    this.refusals.set(key, count);
    return count >= REFUSAL_THRESHOLD ? { kind: "gate-refusal-loop", tool, refusal, count } : null;
  }

  /** Feed the SDK turn-result subtype. */
  observeResultSubtype(subtype: string, numTurns?: number): StallSignal | null {
    return subtype === "error_max_turns" ? { kind: "turn-exhausted", numTurns } : null;
  }

  /** Feed a thrown turn error (consecutive across turns on one thread). */
  observeError(message: string): StallSignal | null {
    this.consecutiveErrors += 1;
    return this.consecutiveErrors >= ERROR_THRESHOLD
      ? { kind: "error-loop", consecutive: this.consecutiveErrors, last: message }
      : null;
  }

  /** Per-turn reset: refusal loops are judged within one turn; the error
   * streak lives on the thread-level detector across turns. */
  resetRefusals(): void {
    this.refusals.clear();
  }

  /** A completed turn clears the consecutive-error streak (refusal counts
   * are per-turn by construction: the surface makes a new detector per turn
   * but keeps the error streak on a thread-level detector). */
  resetErrors(): void {
    this.consecutiveErrors = 0;
  }
}
