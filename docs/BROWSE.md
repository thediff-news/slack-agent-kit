# Browse skill

`browse <goal>` in Slack drives a real headless Chromium through an
observe -> plan -> guard -> act loop, then posts a step log and screenshots
in-thread.

## Usage

```
browse go to https://githubstatus.com and read the page
browse go to https://developer.mozilla.org and scroll down
```

## Architecture

- `src/browse/browser.ts` - BrowserSession: local headless Chromium
  (Playwright), pluggable to a hosted browser via `BROWSE_CDP_URL` (CDP).
  Per-user persistent profiles via `profileDir` (logins only ever come from
  the vault; the agent never accepts credentials in chat).
- `src/browse/actions.ts` - navigate, click, type, scroll, waitFor, extract
  text, screenshot, aria tree, tabs, file download, form fill, cookie-banner
  dismissal. Element targeting tries role/label/placeholder/text/css with
  retries and re-resolves stale elements.
- `src/browse/planner.ts` - ModelProvider interface. `HttpPlanner` talks to
  any OpenAI-compatible endpoint (`BROWSE_MODEL_URL/KEY/NAME`, free tiers
  work) and gets a pixel path: when it declares `usesVision` (default with a
  key; `BROWSE_MODEL_VISION=0` opts out) the loop attaches a JPEG screenshot
  to every observation as image content alongside the text/tree. Without a
  model, `HeuristicPlanner` handles command-style goals keylessly.
  `ScriptedPlanner` for tests.
- `src/browse/loop.ts` - the agent loop: step cap (default 20), time cap
  (default 3 min), screenshot cap via posting (6), loop detection (3 identical
  actions aborts), per-action audit.

## Guardrails

- **Domain allowlist** per workspace (`skills.browse.allowlist` in config,
  persisted additions in the store). Navigating anywhere else requires an
  approval; the approval adds the domain durably.
- **Irreversible clicks gated**: controls labelled buy/pay/submit/send/
  delete/confirm/book/... require approval before the click happens.
- **Untrusted page content**: aria tree + page text are wrapped in
  UNTRUSTED markers (forged markers inside the page are defanged), lines
  that look like injected instructions are flagged to the planner, and the
  planner contract says only the user's goal directs actions. Tests cover
  all three.
- **No CAPTCHA solving.** A CAPTCHA simply fails the step honestly.
- Every action is written to the audit log with URL, target, and result.

## Honest limits (vs. a full computer-use agent)

- The keyless heuristic planner only handles command-style goals (go to,
  click X, scroll, read). Multi-step reasoning needs `HttpPlanner` + a model.
- Without a vision-capable model key, observations are text/aria-tree only:
  vision-only cues (canvas, icon-only buttons without labels) are weak
  spots. With `HttpPlanner` + a vision model the loop sends a screenshot
  every step.
- Heavy JS apps that block headless Chromium (bot detection) will resist;
  no stealth patches are applied.
- File downloads land in `screenshotDir`/`downloadsDir`, not delivered to
  Slack automatically.
