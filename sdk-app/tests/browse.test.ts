import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowsePolicy, BrowseTools, browseGateDecision } from "../src/browse-tools.js";
import { AuditLog } from "../src/audit.js";

let server: http.Server;
let base: string;

before(async () => {
  server = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(`<html><title>Fixture</title><body>
      <h1>Hello fixture</h1>
      <a href="/next">Next page</a>
      <button>Buy now</button>
      <input aria-label="Search box" />
    </body></html>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => server.close());

test("policy: unknown hosts blocked, approved hosts persist", () => {
  const dir = mkdtempSync(join(tmpdir(), "pol-"));
  const file = join(dir, "allow.json");
  const p = new BrowsePolicy(file, ["example.com"]);
  assert.equal(p.allowed("example.com"), true);
  assert.equal(p.allowed("sub.example.com"), true, "parent domain covers subdomains");
  assert.equal(p.allowed("evil.com"), false);
  p.addHost("127.0.0.1");
  const p2 = new BrowsePolicy(file);
  assert.equal(p2.allowed("127.0.0.1"), true, "persisted across instances");
});

test("gate decisions: host gate, irreversible click gate, plain allow", () => {
  const p = new BrowsePolicy(join(mkdtempSync(join(tmpdir(), "pol-")), "a.json"), ["ok.com"]);
  assert.deepEqual(browseGateDecision(p, "mcp__kit__browse_open", { url: "https://ok.com/x" }), { kind: "allow" });
  assert.deepEqual(browseGateDecision(p, "mcp__kit__browse_open", { url: "https://nope.com/" }), { kind: "gate-host", host: "nope.com" });
  assert.deepEqual(browseGateDecision(p, "mcp__kit__browse_click", { target: { text: "Buy now" } }), { kind: "gate-irreversible", label: "Buy now" });
  assert.deepEqual(browseGateDecision(p, "mcp__kit__browse_click", { target: { text: "Next page" } }), { kind: "allow" });
});

test("real browser: open, read, screenshot against a local page", async () => {
  const dir = mkdtempSync(join(tmpdir(), "browse-"));
  const policy = new BrowsePolicy(join(dir, "allow.json"), ["127.0.0.1"]);
  const audit = new AuditLog(join(dir, "audit.jsonl"));
  const b = new BrowseTools({ audit, policy, downloadsDir: dir });
  assert.equal(browseGateDecision(policy, "mcp__kit__browse_open", { url: base }).kind, "allow");
  const opened = await b.open(base);
  assert.match(opened, /Hello fixture/);
  assert.match(opened, /UNTRUSTED/);
  const read = await b.read();
  assert.match(read, /Buy now/);
  const shot = await b.screenshotBase64();
  assert.ok(shot.length > 500, "screenshot bytes");
  assert.equal(Buffer.from(shot, "base64").subarray(1, 4).toString(), "PNG");
  await b.close();
});

test("real browser: DEAD session (browser process killed) auto-recovers on next call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "browse-crash-"));
  const policy = new BrowsePolicy(join(dir, "allow.json"), ["127.0.0.1"]);
  const audit = new AuditLog(join(dir, "audit.jsonl"));
  const b = new BrowseTools({ audit, policy, downloadsDir: dir });
  const opened = await b.open(base);
  assert.match(opened, /Hello fixture/);
  // simulate the crash: kill the underlying browser behind BrowseTools' back
  const session = (b as any).session;
  assert.ok(session?.browser, "session has a browser");
  await session.browser.close(); // abrupt teardown; BrowseTools is not notified
  assert.equal(session.browser.isConnected(), false, "browser is really dead");
  // next call must relaunch instead of failing forever
  const reopened = await b.open(base);
  assert.match(reopened, /Hello fixture/, "browsing works again after relaunch");
  const shot = await b.screenshotBase64();
  assert.ok(shot.length > 500, "screenshot works after relaunch");
  const log = (await import("node:fs")).readFileSync(join(dir, "audit.jsonl"), "utf8");
  assert.match(log, /browse_relaunch/, "relaunch is audited");
  await (b as any).session?.close?.();
});
