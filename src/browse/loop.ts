/**
 * AgentLoop: observe -> plan -> guard -> act, with step/time caps, loop
 * detection, domain allowlist, irreversible-click gate, and per-action audit.
 */
import type { Page } from "playwright";
import type { BrowserSession } from "./browser.js";
import * as act from "./actions.js";
import type { ModelProvider, Step, Observation } from "./planner.js";
import { hostAllowed, hostOf, isIrreversibleLabel, wrapUntrusted, flagSuspicious, describe } from "./guardrails-index.js";

export interface LoopOptions {
  maxSteps?: number;
  maxDurationMs?: number;
  screenshotDir?: string;
  /** Per-workspace allowlist (exact host or parent domain). */
  allowlist: string[];
  /** Gate for out-of-allowlist domains and irreversible clicks. Return true to allow. */
  gate(reason: string): Promise<boolean>;
  audit?(event: string, detail: string): void;
  onStep?(entry: StepLogEntry): void;
}

export interface StepLogEntry {
  step: number;
  action: string;
  result: string;
  url: string;
  screenshotPath?: string;
}

export interface LoopResult {
  ok: boolean;
  summary: string;
  steps: StepLogEntry[];
  screenshots: string[];
  blockedReason?: string;
}

export async function runLoop(
  session: BrowserSession,
  planner: ModelProvider,
  goal: string,
  opts: LoopOptions,
): Promise<LoopResult> {
  const maxSteps = opts.maxSteps ?? 20;
  const deadline = Date.now() + (opts.maxDurationMs ?? 180_000);
  const shotDir = opts.screenshotDir ?? "/tmp/browse-shots";
  const steps: StepLogEntry[] = [];
  const screenshots: string[] = [];
  const history: string[] = [];
  const recentFingerprints: string[] = [];
  let page: Page | undefined;

  const log = (n: number, action: string, result: string, shot?: string) => {
    const entry = { step: n, action, result, url: page?.url() ?? "", screenshotPath: shot };
    steps.push(entry);
    history.push(`step ${n}: ${action} -> ${result}`);
    opts.onStep?.(entry);
    opts.audit?.("browse_step", `${action} | ${result} | ${entry.url}`);
  };

  for (let n = 1; n <= maxSteps; n++) {
    if (Date.now() > deadline) {
      return { ok: false, summary: "time cap reached", steps, screenshots, blockedReason: "timeout" };
    }
    page = page ?? (await session.newTab());

    // OBSERVE
    const [tree, text] = await Promise.all([
      act.ariaTree(page).catch(() => ({ ok: false, detail: "" })),
      act.extractText(page, undefined, 3_000).catch(() => ({ ok: false, detail: "" })),
    ]);
    const obs: Observation = {
      url: page.url(),
      title: await page.title().catch(() => ""),
      ariaTree: wrapUntrusted(tree.detail),
      text: wrapUntrusted(text.detail),
      suspiciousLines: flagSuspicious(tree.detail + "\n" + text.detail),
      stepCount: n - 1,
    };
    if (planner.usesVision) {
      obs.screenshotBase64 = await page
        .screenshot({ type: "jpeg", quality: 60 })
        .then((b) => b.toString("base64"))
        .catch(() => undefined);
    }

    // PLAN
    let step: Step;
    try {
      step = await planner.plan(goal, obs, history);
    } catch (e) {
      return { ok: false, summary: `planner error: ${(e as Error).message}`, steps, screenshots };
    }

    // LOOP DETECTION: same action+target 3 times in a row -> abort honestly
    const fp = JSON.stringify(step);
    recentFingerprints.push(fp);
    if (recentFingerprints.length >= 3 && recentFingerprints.slice(-3).every((f) => f === fp)) {
      return { ok: false, summary: `stuck repeating ${fp.slice(0, 120)} - aborted`, steps, screenshots, blockedReason: "loop" };
    }

    // GUARD: terminal steps
    if (step.kind === "done") {
      log(n, "done", step.summary);
      return { ok: true, summary: step.summary, steps, screenshots };
    }
    if (step.kind === "fail") {
      log(n, "fail", step.reason);
      return { ok: false, summary: step.reason, steps, screenshots };
    }

    // GUARD: domain allowlist
    if (step.kind === "navigate") {
      const host = hostOf(step.url);
      if (!hostAllowed(host, opts.allowlist)) {
        const allowed = await opts.gate(`add ${host} to this workspace's browse allowlist (goal: ${goal.slice(0, 80)})`);
        if (!allowed) {
          log(n, "navigate", `BLOCKED: ${host} not in allowlist, gate denied`);
          return { ok: false, summary: `${host} not in the browse allowlist and the addition was not approved`, steps, screenshots, blockedReason: "allowlist" };
        }
        opts.allowlist.push(host);
        opts.audit?.("browse_allowlist_add", host);
        log(n, "allowlist", `added ${host} (approved)`);
      }
    }

    // GUARD: irreversible clicks
    if (step.kind === "click" || step.kind === "download") {
      const label = step.target.text ?? step.target.name ?? step.target.selector ?? "";
      if (isIrreversibleLabel(label)) {
        const allowed = await opts.gate(`click potentially irreversible control "${label}" on ${obs.url}`);
        if (!allowed) {
          log(n, step.kind, `BLOCKED: "${label}" looks irreversible, gate denied`);
          return { ok: false, summary: `refused to click "${label}" without approval`, steps, screenshots, blockedReason: "irreversible" };
        }
        log(n, step.kind, `irreversible click "${label}" approved`);
      }
    }

    // ACT
    const name = step.kind + " " + ("target" in step ? act.describe(step.target as act.Target) : "url" in step ? step.url : "");
    let r: act.ActionResult;
    switch (step.kind) {
      case "navigate": r = await act.navigate(page, step.url); break;
      case "click": r = await act.click(page, step.target); break;
      case "type": r = await act.typeText(page, step.target, step.text, step.pressEnter ?? false); break;
      case "scroll": r = await act.scroll(page, step.direction, step.amount); break;
      case "wait": r = await act.waitFor(page, { ms: step.ms }); break;
      case "waitFor": r = await act.waitFor(page, step.target); break;
      case "extract": r = await act.extractText(page, step.selector); break;
      case "screenshot": {
        const p = `${shotDir}/step-${n}.png`;
        r = await act.screenshot(page, p);
        if (r.ok) screenshots.push(p);
        log(n, name, r.detail, r.ok ? p : undefined);
        continue;
      }
      case "download": r = await act.downloadFile(page, step.target, shotDir); break;
      case "fillForm": r = await act.fillForm(page, step.fields); break;
      case "dismissPopups": r = await act.dismissPopups(page); break;
      default:
        r = { ok: false, detail: `unknown step kind ${(step as any).kind}` };
    }
    log(n, name, r.detail);
    if (!r.ok && n === maxSteps) {
      return { ok: false, summary: `last action failed: ${r.detail}`, steps, screenshots };
    }
  }
  return { ok: false, summary: `step cap (${maxSteps}) reached`, steps, screenshots, blockedReason: "step-cap" };
}
