/**
 * Browse action tools. Every action is robust to dynamic pages: element
 * targeting tries role/label/placeholder/text/css in order, re-resolves on
 * stale elements, and retries transient click failures (covered by popups,
 * animations, detached nodes).
 */
import type { Page, Locator } from "playwright";

export interface ActionResult {
  ok: boolean;
  detail: string;
  /** Set when the action produced a downloaded file. */
  downloadPath?: string;
}

/** A target as the planner expresses it: visible text, role+name, or a css/xpath selector. */
export interface Target {
  text?: string;
  role?: string;
  name?: string;
  selector?: string;
}

export function resolveTarget(page: Page, t: Target): Locator {
  if (t.selector) {
    return t.selector.startsWith("//") || t.selector.startsWith("(")
      ? page.locator(`xpath=${t.selector}`)
      : page.locator(t.selector);
  }
  if (t.role) {
    return page.getByRole(t.role as any, { name: t.name ?? t.text }).first();
  }
  if (t.text) {
    // visible text/labels/placeholders first (hidden templates and duplicate
    // nav copies are a real failure mode - live: MDN "Search"), then any match
    const visible = page
      .getByText(t.text, { exact: false })
      .or(page.getByLabel(t.text))
      .or(page.getByPlaceholder(t.text))
      .filter({ visible: true });
    return visible.first().or(
      page
        .getByText(t.text, { exact: false })
        .or(page.getByLabel(t.text))
        .or(page.getByPlaceholder(t.text))
        .first(),
    );
  }
  throw new Error("empty target");
}

async function withRetries<T>(fn: () => Promise<T>, attempts = 3, delayMs = 400): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw lastErr;
}

export async function navigate(page: Page, url: string): Promise<ActionResult> {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    // best-effort: dynamic pages keep loading; never block on network idle
    await page.waitForLoadState("load", { timeout: 8_000 }).catch(() => {});
    return { ok: true, detail: `navigated to ${page.url()} (${await page.title()})` };
  } catch (e) {
    return { ok: false, detail: `navigate failed: ${(e as Error).message.split("\n")[0]}` };
  }
}

export async function click(page: Page, t: Target): Promise<ActionResult> {
  try {
    await withRetries(async () => {
      const loc = resolveTarget(page, t);
      await loc.scrollIntoViewIfNeeded({ timeout: 5_000 });
      await loc.click({ timeout: 5_000 });
    });
    await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => {});
    return { ok: true, detail: `clicked ${describe(t)}` };
  } catch (e) {
    return { ok: false, detail: `click ${describe(t)} failed: ${(e as Error).message.split("\n")[0]}` };
  }
}

export async function typeText(page: Page, t: Target, text: string, pressEnter = false): Promise<ActionResult> {
  try {
    await withRetries(async () => {
      const loc = resolveTarget(page, t);
      await loc.scrollIntoViewIfNeeded({ timeout: 5_000 });
      await loc.click({ timeout: 5_000 });
      await loc.fill(text, { timeout: 5_000 });
    });
    if (pressEnter) await page.keyboard.press("Enter");
    return { ok: true, detail: `typed into ${describe(t)}${pressEnter ? " + Enter" : ""}` };
  } catch (e) {
    return { ok: false, detail: `type ${describe(t)} failed: ${(e as Error).message.split("\n")[0]}` };
  }
}

export async function scroll(page: Page, direction: "up" | "down", amount = 800): Promise<ActionResult> {
  await page.mouse.wheel(0, direction === "down" ? amount : -amount);
  // infinite scroll: give content a moment to load
  await page.waitForTimeout(600);
  return { ok: true, detail: `scrolled ${direction}` };
}

export async function waitFor(page: Page, t: Target | { ms: number }): Promise<ActionResult> {
  if ("ms" in t) {
    await page.waitForTimeout(t.ms);
    return { ok: true, detail: `waited ${t.ms}ms` };
  }
  try {
    await resolveTarget(page, t).waitFor({ state: "visible", timeout: 10_000 });
    return { ok: true, detail: `${describe(t)} visible` };
  } catch (e) {
    return { ok: false, detail: `waitFor ${describe(t)}: ${(e as Error).message.split("\n")[0]}` };
  }
}

export async function extractText(page: Page, selector?: string, maxChars = 4_000): Promise<ActionResult> {
  try {
    const raw = selector
      ? await page.locator(selector).first().innerText({ timeout: 5_000 })
      : await page.locator("body").innerText({ timeout: 5_000 });
    const text = raw.replace(/\s+\n/g, "\n").trim();
    return {
      ok: true,
      detail: text.length > maxChars ? text.slice(0, maxChars) + `\n... [truncated ${text.length - maxChars} chars]` : text,
    };
  } catch (e) {
    return { ok: false, detail: `extract failed: ${(e as Error).message.split("\n")[0]}` };
  }
}

export async function screenshot(page: Page, path: string, fullPage = false): Promise<ActionResult> {
  try {
    await page.screenshot({ path, fullPage });
    return { ok: true, detail: `screenshot saved: ${path}` };
  } catch (e) {
    return { ok: false, detail: `screenshot failed: ${(e as Error).message.split("\n")[0]}` };
  }
}

/** Compact accessibility tree (YAML-ish) capped for prompt size. */
export async function ariaTree(page: Page, maxChars = 6_000): Promise<ActionResult> {
  try {
    const tree = await page.locator("body").ariaSnapshot();
    return {
      ok: true,
      detail: tree.length > maxChars ? tree.slice(0, maxChars) + `\n... [tree truncated]` : tree,
    };
  } catch (e) {
    return { ok: false, detail: `aria tree failed: ${(e as Error).message.split("\n")[0]}` };
  }
}

export async function downloadFile(page: Page, t: Target, dir: string): Promise<ActionResult> {
  try {
    const [dl] = await Promise.all([
      page.waitForEvent("download", { timeout: 15_000 }),
      withRetries(() => resolveTarget(page, t).click({ timeout: 5_000 })),
    ]);
    const path = `${dir}/${dl.suggestedFilename()}`;
    await dl.saveAs(path);
    return { ok: true, detail: `downloaded ${dl.suggestedFilename()}`, downloadPath: path };
  } catch (e) {
    return { ok: false, detail: `download failed: ${(e as Error).message.split("\n")[0]}` };
  }
}

/** Fill several form fields at once. Targets use label/placeholder/text resolution. */
export async function fillForm(page: Page, fields: { target: Target; value: string }[]): Promise<ActionResult> {
  const filled: string[] = [];
  for (const f of fields) {
    const r = await typeText(page, f.target, f.value);
    if (!r.ok) return { ok: false, detail: `form fill stopped at ${describe(f.target)}: ${r.detail}` };
    filled.push(describe(f.target));
  }
  return { ok: true, detail: `filled ${filled.join(", ")}` };
}

/** Dismiss common cookie/consent banners. Safe: only clicks dismiss-style buttons. */
export async function dismissPopups(page: Page): Promise<ActionResult> {
  const patterns = [/^accept( all)?$/i, /^agree$/i, /^got it$/i, /^ok$/i, /^dismiss$/i, /^no thanks$/i, /^reject all$/i, /^close$/i];
  for (const p of patterns) {
    try {
      const btn = page.getByRole("button", { name: p }).first();
      if (await btn.isVisible({ timeout: 800 })) {
        await btn.click({ timeout: 2_000 });
        return { ok: true, detail: `dismissed popup (${p})` };
      }
    } catch { /* keep trying patterns */ }
  }
  return { ok: true, detail: "no popup found" };
}

export function describe(t: Target): string {
  if (t.selector) return `selector(${t.selector})`;
  if (t.role) return `${t.role}[${t.name ?? t.text ?? ""}]`;
  return `text("${t.text ?? ""}")`;
}
