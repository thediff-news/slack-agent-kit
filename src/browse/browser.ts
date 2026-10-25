/**
 * BrowserSession: one Playwright Chromium instance for the browse skill.
 * Local headless by default; pluggable to a hosted browser via CDP endpoint
 * (BROWSE_CDP_URL). Per-user persistent profiles via profileDir.
 */
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { mkdirSync } from "node:fs";

export interface BrowserSessionOptions {
  headless?: boolean;
  /** CDP websocket/http endpoint of a hosted browser. When set, we connect instead of launching. */
  cdpEndpoint?: string;
  /** Persistent profile directory (logins/cookies survive across runs). Local launch only. */
  profileDir?: string;
  downloadsDir?: string;
  viewport?: { width: number; height: number };
}

export class BrowserSession {
  browser?: Browser;
  private context?: BrowserContext;
  private pages: Page[] = [];
  private active = 0;
  readonly downloadsDir: string;

  private constructor(private opts: BrowserSessionOptions) {
    this.downloadsDir = opts.downloadsDir ?? "/tmp/browse-downloads";
    mkdirSync(this.downloadsDir, { recursive: true });
  }

  static async launch(opts: BrowserSessionOptions = {}): Promise<BrowserSession> {
    const s = new BrowserSession(opts);
    const headless = opts.headless ?? true;
    if (opts.cdpEndpoint) {
      s.browser = await chromium.connectOverCDP(opts.cdpEndpoint);
      s.context = s.browser.contexts()[0] ?? (await s.browser.newContext({ acceptDownloads: true }));
    } else if (opts.profileDir) {
      mkdirSync(opts.profileDir, { recursive: true });
      s.context = await chromium.launchPersistentContext(opts.profileDir, {
        headless,
        acceptDownloads: true,
        viewport: opts.viewport ?? { width: 1280, height: 900 },
      });
      s.browser = s.context.browser() ?? undefined;
    } else {
      s.browser = await chromium.launch({ headless });
      s.context = await s.browser.newContext({
        acceptDownloads: true,
        viewport: opts.viewport ?? { width: 1280, height: 900 },
      });
    }
    return s;
  }

  async newTab(): Promise<Page> {
    const p = await this.context!.newPage();
    p.setDefaultTimeout(10_000);
    p.setDefaultNavigationTimeout(30_000);
    this.pages.push(p);
    this.active = this.pages.length - 1;
    return p;
  }

  page(): Page {
    return this.pages[this.active];
  }

  listTabs(): { index: number; url: string; title: Promise<string> }[] {
    return this.pages.map((p, i) => ({ index: i, url: p.url(), title: p.title() }));
  }

  switchTab(index: number): Page {
    if (!this.pages[index]) throw new Error(`no tab ${index}`);
    this.active = index;
    return this.pages[index];
  }

  async closeTab(index: number): Promise<void> {
    if (!this.pages[index]) throw new Error(`no tab ${index}`);
    await this.pages[index].close();
    this.pages.splice(index, 1);
    this.active = Math.max(0, Math.min(this.active, this.pages.length - 1));
  }

  async close(): Promise<void> {
    try { await this.context?.close(); } catch { /* already closed */ }
    try { await this.browser?.close(); } catch { /* already closed */ }
  }
}
