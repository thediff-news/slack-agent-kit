import { test } from "node:test";
import assert from "node:assert/strict";
import { buildConnectors } from "../src/connectors.js";

const names = (cs: any[]) => cs.map((c) => c.constructor.name);
const FB = { docsRoot: "docs", githubRepos: ["o/r"] };

test("empty settings -> legacy default (fs + github from env-style config)", () => {
  assert.deepEqual(names(buildConnectors([], {}, FB, () => {})), ["FilesystemConnector", "GitHubConnector"]);
});

test("web + slack-history build with creds; slack-history disabled without token (warn, no throw)", () => {
  const warns: string[] = [];
  const cs = buildConnectors(
    [{ type: "web", acl: "public" }, { type: "slack-history", channels: "C1,C2", acl: "engineering" }],
    {}, names.length ? {} : {}, (m) => warns.push(m),
  );
  assert.deepEqual(names(cs), ["WebConnector"]);
  assert.match(warns[0], /SLACK_BOT_TOKEN missing/);
  const withTok = buildConnectors([{ type: "slack-history", channels: "C1", acl: "engineering" }], { SLACK_BOT_TOKEN: "x" } as any, FB, () => {});
  assert.deepEqual(names(withTok), ["SlackHistoryConnector"]);
});

test("jira/confluence need all three Atlassian env vars; notion needs its key", () => {
  const warns: string[] = [];
  const none = buildConnectors([{ type: "jira" }, { type: "confluence" }, { type: "notion" }], {} as any, FB, (m) => warns.push(m));
  assert.deepEqual(names(none), []);
  assert.equal(warns.length, 3);
  const env = { ATLASSIAN_SITE: "https://t.atlassian.net", ATLASSIAN_EMAIL: "e@x", ATLASSIAN_API_TOKEN: "t", NOTION_API_KEY: "n" } as any;
  const all = buildConnectors([{ type: "jira" }, { type: "confluence", acl: "conf" }, { type: "notion" }], env, FB, () => {});
  assert.deepEqual(names(all), ["JiraConnector", "ConfluenceConnector", "NotionConnector"]);
});

test("unknown type skipped with warning; filesystem root honored", () => {
  const warns: string[] = [];
  const cs = buildConnectors([{ type: "bogus" as any }, { type: "filesystem", root: "/tmp/x" }], {} as any, FB, (m) => warns.push(m));
  assert.deepEqual(names(cs), ["FilesystemConnector"]);
  assert.match(warns[0], /unknown type/);
});

test("explicit settings REPLACE the legacy default (no implicit fs)", () => {
  const cs = buildConnectors([{ type: "web" }], {} as any, FB, () => {});
  assert.deepEqual(names(cs), ["WebConnector"]);
});
