/** Strict case-thread admission (eval mode): exactly ONE Slack thread - the
 * case thread - may ever reach the model. Anything else is dropped before
 * any paid processing, so an unread message in an old thread can never
 * trigger a paid turn (the "wrong-thread spend" failure class).
 *
 * Binding: at startup the bound thread is restored from disk; otherwise the
 * first top-level message in the case channel containing the case marker
 * binds the thread permanently (persisted). Operator messages (nudges,
 * approvals) must live in the case thread; outside messages are audited
 * drops with zero model forwarding. */

export interface AdmissionState { boundThread?: string }

export type AdmissionDecision = "admit" | "bind-and-admit" | "drop";

export interface AdmissionConfig { caseChannel: string; caseMarker: string }

export function admitEvent(
  event: { channel?: string; ts?: string; thread_ts?: string; text?: string },
  cfg: AdmissionConfig,
  state: AdmissionState,
): AdmissionDecision {
  if (!cfg.caseChannel) return "admit"; // non-eval: open surface (unchanged behavior)
  if (!event.channel || event.channel !== cfg.caseChannel) return "drop";
  const thread = event.thread_ts ?? event.ts ?? "";
  if (state.boundThread) return thread === state.boundThread ? "admit" : "drop";
  // Unbound: only a top-level message carrying the marker may bind. Replies
  // in other threads never bind, even if they quote the marker.
  if (!event.thread_ts && event.ts && (event.text ?? "").includes(cfg.caseMarker)) {
    state.boundThread = event.ts;
    return "bind-and-admit";
  }
  return "drop";
}
