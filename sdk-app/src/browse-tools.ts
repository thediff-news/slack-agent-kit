/** Browsing, SDK-native: the SDK agent loop IS the planner (this replaces the
 * old app's HttpPlanner/loop orchestration entirely). These tools expose the
 * kit's browser primitives; the kit's guardrail SEMANTICS are kept and moved
 * into the permission gate (agent.ts):
 *   - domain allowlist: out-of-allowlist hosts need human approval; approving
 *     adds the host and proceeds (persisted, like the kit);
 *   - irreversible-label clicks (buy/pay/delete/...): per-click approval.
 * Page content is wrapped as untrusted data. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BrowserSession } from "../../src/browse/browser.js";
import * as act from "../../src/browse/actions.js";
import { hostAllowed, hostOf, isIrreversibleLabel, wrapUntrusted } from "../../src/browse/guardrails.js";
import type { AuditLog } from "./audit.js";

/** Domain allowlist with persistence - shared between the tools and the gate. */
export class BrowsePolicy {
  private hosts: string[];
  constructor(private file: string, seed: string[] = []) {
    mkdirSync(dirname(file), { recursive: true });
    this.hosts = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : seed;
  }
  allowed(urlOrHost: string): boolean {
    return hostAllowed(hostOf(urlOrHost) || urlOrHost, this.hosts);
  }
  addHost(host: string): void {
    if (!this.hosts.includes(host)) {
      this.hosts.push(host);
      writeFileSync(this.file, JSON.stringify(this.hosts));
    }
  }
  list(): string[] {
    return [...this.hosts];
  }
}

export type BrowseDeps = { audit: AuditLog; policy: BrowsePolicy; downloadsDir?: string };

export class BrowseTools {
  private session?: BrowserSession;
  constructor(private deps: BrowseDeps) {}

  private async page() {
    if (!this.session) {
      this.session = await BrowserSession.launch({ headless: true, downloadsDir: this.deps.downloadsDir ?? "/tmp/sdk-app-downloads" });
      await this.session.newTab(); // launch() opens no tab on its own
    }
    return this.session.page();
  }

  async open(url: string) {
    const p = await this.page();
    const r = await act.navigate(p, url);
    this.deps.audit.write("tool_call", { tool: "browse_open", url, ok: r.ok });
    const tree = await act.ariaTree(p);
    return `URL: ${p.url()}\nTITLE: ${await p.title()}\n${wrapUntrusted(tree.detail)}\n${r.ok ? "" : `NAV ISSUE: ${r.detail}`}`;
  }

  async click(target: { text?: string }) {
    const p = await this.page();
    const r = await act.click(p, target as any);
    this.deps.audit.write("tool_call", { tool: "browse_click", target, ok: r.ok, reason: r.detail });
    return r.ok ? `clicked ${act.describe(target as any)}; now at ${p.url()}` : `click failed: ${r.detail}`;
  }

  async type(target: { text?: string }, text: string, pressEnter = false) {
    const p = await this.page();
    const r = await act.fillForm(p, [{ target: target as any, value: text }]);
    if (pressEnter && r.ok) await p.keyboard.press("Enter");
    this.deps.audit.write("tool_call", { tool: "browse_type", target, pressEnter, ok: r.ok });
    return r.ok ? `typed into ${act.describe(target as any)}` : `type failed: ${r.detail}`;
  }

  async scroll(direction: "up" | "down") {
    const p = await this.page();
    await act.scroll(p, direction);
    return `scrolled ${direction}`;
  }

  async read() {
    const p = await this.page();
    const tree = await act.ariaTree(p);
    const text = await act.extractText(p);
    this.deps.audit.write("tool_call", { tool: "browse_read", url: p.url() });
    return `URL: ${p.url()}\nTITLE: ${await p.title()}\nARIA:\n${wrapUntrusted(tree.detail)}\nTEXT:\n${wrapUntrusted(text.detail)}`;
  }

  async screenshotBase64(): Promise<string> {
    const p = await this.page();
    const f = join(this.deps.downloadsDir ?? "/tmp/sdk-app-downloads", `shot-${Date.now()}.png`);
    await act.screenshot(p, f);
    this.deps.audit.write("tool_call", { tool: "browse_screenshot", url: p.url(), file: f });
    return readFileSync(f).toString("base64");
  }

  async close() {
    await this.session?.close().catch(() => {});
    this.session = undefined;
  }
}

/** Gate decisions for browse tools, called from canUseTool. */
export function browseGateDecision(policy: BrowsePolicy, toolName: string, input: any):
  | { kind: "allow" }
  | { kind: "gate-host"; host: string }
  | { kind: "gate-irreversible"; label: string } {
  if (toolName.endsWith("__browse_open")) {
    const host = hostOf(String(input?.url ?? ""));
    if (!policy.allowed(host)) return { kind: "gate-host", host };
    return { kind: "allow" };
  }
  if (toolName.endsWith("__browse_click") || toolName.endsWith("__browse_type")) {
    const label = String(input?.target?.text ?? "");
    if (label && isIrreversibleLabel(label)) return { kind: "gate-irreversible", label };
  }
  return { kind: "allow" };
}
