/** Exact preselected case anchor (eval mode): exactly ONE Slack thread - the
 * operator-configured case thread (exact channel + thread_ts) - may ever
 * reach the model. Everything else is dropped before any paid processing, so
 * an unread message in an old thread, or a forged message carrying the case
 * marker text in another thread, can never trigger a paid turn (the
 * "wrong-thread spend" failure class).
 *
 * There is NO runtime binding: the anchor is pure configuration, so it is
 * restart-safe by construction and cannot be captured by a first poster or a
 * forged marker. Fail closed: partial anchor config (channel without thread
 * or vice versa) drops everything. */

export type AdmissionDecision = "admit" | "drop";

export interface AdmissionConfig { caseChannel: string; caseThread: string }

export function admitEvent(
  event: { channel?: string; ts?: string; thread_ts?: string; text?: string },
  cfg: AdmissionConfig,
): AdmissionDecision {
  if (!cfg.caseChannel && !cfg.caseThread) return "admit"; // non-eval: open surface (unchanged behavior)
  if (!cfg.caseChannel || !cfg.caseThread) return "drop"; // fail closed on partial anchor config
  if (!event.channel || event.channel !== cfg.caseChannel) return "drop";
  const thread = event.thread_ts ?? event.ts ?? "";
  return thread === cfg.caseThread ? "admit" : "drop";
}
