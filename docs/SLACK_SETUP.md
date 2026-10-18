# Slack setup

We do not create the Slack app for you (that accepts Slack's terms). Two
minutes of clicking, then the kit runs.

## 1. Create the app

Slack API -> Your Apps -> Create New App -> **From a manifest**, paste:

```json
{
  "display_information": { "name": "agent-kit" },
  "features": {
    "bot_user": { "display_name": "agent-kit", "always_online": true }
  },
  "oauth_config": {
    "scopes": {
      "bot": ["app_mentions:read", "channels:history", "groups:history", "chat:write", "im:history"]
    }
  },
  "settings": {
    "event_subscriptions": {
      "bot_events": ["app_mention", "message.channels", "message.groups"]
    },
    "interactivity": { "is_enabled": true },
    "org_deploy_enabled": false,
    "socket_mode_enabled": true,
    "token_rotation_enabled": false
  }
}
```

## 2. Tokens

- Install the app to your workspace -> **Bot User OAuth Token** (`xoxb-...`).
- Basic Information -> App-Level Tokens -> generate with `connections:write`
  -> (`xapp-...`).

## 3. Run

```bash
export SLACK_BOT_TOKEN=xoxb-...
export SLACK_APP_TOKEN=xapp-...
# edit kit.config.yaml: permissions.users (Slack user IDs), channels, approvers
npm run slack
```

Invite the bot to a channel, mention it or post a top-level alert with a
`key_hint:` line. Approvals arrive as buttons in the thread.

## Note on channel watch

`app.message` in the adapter receives every top-level message in channels the
bot joins. In busy channels, prefer mention-triggering, or restrict the bot
to a dedicated alerts channel.
