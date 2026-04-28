# Channels and Integrations

Boop has two layers of external connectivity:

- **Channels** — how the user talks to Boop. Sendblue (iMessage) and Telegram are supported. Pick one or both.
- **Integrations** — what Boop can do for the user (Gmail, Slack, GitHub, …). All powered by Composio.

---

## Channels

Both channels are optional. `npm run setup` lets you pick which to enable. They run in parallel and stay separate:

- Sendblue conversations: `conversationId = "sms:+E164"`.
- Telegram conversations: `conversationId = "tg:<chat_id>"`.

The interaction agent and automations route replies via the conversation's prefix — no cross-posting.

### Sendblue (iMessage bridge)

1. Sign up at [sendblue.co](https://sendblue.co).
2. `npm run setup` pulls the keys via the Sendblue CLI (or paste manually).
3. `npm run dev` auto-registers the inbound webhook with Sendblue each restart on free ngrok.

### Telegram bot

1. Open [@BotFather](https://t.me/BotFather) in Telegram, send `/newbot`, follow the prompts.
2. Paste the bot token into `npm run setup` (Telegram branch). The setup script auto-generates `TELEGRAM_WEBHOOK_SECRET`.
3. (Recommended) set `TELEGRAM_ALLOWED_CHAT_IDS` to your own chat_id (find via [@userinfobot](https://t.me/userinfobot)) so randoms can't talk to your bot.
4. `npm run dev` calls `setWebhook` with the current public URL and secret token on every start. Disable with `TELEGRAM_AUTO_WEBHOOK=false` and run `npm run telegram:setup` manually.
5. Open the bot in Telegram and send a message — the agent replies in MarkdownV2 (set `TELEGRAM_PLAIN=true` to disable rich formatting).

Telegram's message limit is 4096 chars; Boop chunks at 4000. The `escapeMarkdownV2` helper in `server/telegram.ts` handles MarkdownV2's reserved characters and converts CommonMark `**bold**` → Telegram `*bold*`. If parsing fails, Boop transparently retries the message as plain text.

---

## Integrations (via Composio)

Boop's integrations are provided by [Composio](https://composio.dev/?utm_source=chris&utm_medium=youtube&utm_campaign=collab), a tool-aggregator that exposes 1000+ third-party services (Gmail, GitHub, Slack, Notion, Linear, Google Drive, HubSpot, Salesforce, …) behind one API.

You don't write integration code. You:

1. Put `COMPOSIO_API_KEY` in `.env.local`.
2. Open the debug dashboard → **Connections** tab.
3. Click **Connect** on a toolkit.
4. Authenticate on Composio's hosted page. Composio stores the tokens and keeps them fresh.
5. The toolkit becomes available to `spawn_agent(integrations: [...])` by its slug.

That's it.

---

## How it hooks into Boop

Each connected Composio toolkit is registered in Boop's integration registry (`server/integrations/registry.ts`) keyed by its slug. When the dispatcher calls:

```ts
spawn_agent({ task: "…", integrations: ["gmail"] })
```

`buildMcpServersForIntegrations(["gmail"])` looks up the registered `gmail` module, opens a Composio session **scoped to only the Gmail toolkit**:

```ts
const session = await composio.create(boopUserId(), {
  toolkits: ["gmail"],
  manageConnections: false,
});
const tools = await session.tools();
```

and wraps those tools as an MCP server for the sub-agent. The sub-agent sees only Gmail's tools (`mcp__gmail__GMAIL_SEND_EMAIL`, etc.) — no Slack, no GitHub, no 1000-tool context bloat.

Every tool call is logged to Convex as usual, so the Agents tab in the debug dashboard shows them with the right toolkit logo and a humanized name.

---

## Curated toolkit list

The Connections tab shows a hand-picked set in `server/composio.ts:CURATED_TOOLKITS`. Edit that array to add or remove cards — the slugs must match Composio's toolkit slugs (see `docs.composio.dev/toolkits` for the full catalog).

Current defaults: Gmail, Google Calendar, Google Drive, Google Sheets, Google Docs, Slack, GitHub, Linear, Notion, HubSpot, Salesforce, Discord, Twitter, LinkedIn, Trello, Asana, Jira, Airtable, Figma, Dropbox.

---

## Disconnecting

Click **Disconnect** on a connected card. That revokes the Composio connection and re-loads the integration registry — the toolkit drops out of `availableIntegrations()` immediately. Next time the dispatcher tries to spawn with that slug, it'll log `[integrations] unknown integration: …`.

---

## Toolkits that need a one-time auth config

Composio hosts managed OAuth apps for most popular toolkits (Gmail, Slack, GitHub, Linear, Notion, Google Calendar/Drive/Sheets/Docs, etc.) — click Connect and it just works. A handful of toolkits don't have a managed app on Composio's side (Twitter/X is the common one; Salesforce sometimes) because their developer policies make hosting a shared OAuth app impractical.

When you click Connect on one of those, Boop surfaces an amber banner explaining that you need to:

1. Create an OAuth app on the toolkit's developer portal (e.g., `developer.twitter.com` for Twitter).
2. Open [platform.composio.dev/auth-configs](https://platform.composio.dev/auth-configs), pick the toolkit, and register your app's client ID + secret.
3. Come back to the Connections tab and click Connect again.

This is a one-time setup per toolkit (not per user) — all users of your Boop instance reuse the same auth config after that.

## Notes

- **Single-tenant by default.** All connections are keyed under `COMPOSIO_USER_ID` (defaults to `boop-default`). Override if you manage Composio sessions elsewhere and want Boop to share that user.
- **External actions still use the draft flow.** Execution agents are prompted to call `save_draft` first for anything that writes to the outside world. The dispatcher's `send_draft` is the only path that actually commits.
- **No tokens live in Boop.** Composio stores OAuth credentials on their side. Boop never sees them.
- **Tool names are Composio's canonical slugs** (e.g., `GMAIL_LIST_MESSAGES`). The debug dashboard humanizes them for display.
