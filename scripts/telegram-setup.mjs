#!/usr/bin/env node
// Registers the Telegram webhook for the bot via the Telegram Bot API
// (setWebhook). Mirrors scripts/sendblue-webhook.mjs for the Telegram side.
//
// Usage:
//   node scripts/telegram-setup.mjs                       # uses PUBLIC_URL from .env.local
//   node scripts/telegram-setup.mjs <public-webhook-url>  # explicit override

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const envPath = resolve(root, ".env.local");

function readEnv() {
  if (!existsSync(envPath)) return {};
  const env = {};
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*?)(?:\s+#.*)?$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

async function tgApi(token, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok && data?.ok, data };
}

async function main() {
  const env = readEnv();
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.log("[telegram] skipping — TELEGRAM_BOT_TOKEN not set in .env.local");
    return;
  }

  const arg = process.argv[2];
  let webhookBase = arg ?? env.PUBLIC_URL;
  if (!webhookBase || /localhost|127\.0\.0\.1/.test(webhookBase)) {
    console.error(
      "[telegram] no public URL configured. Pass one as an argument or set PUBLIC_URL/NGROK_DOMAIN in .env.local.",
    );
    process.exit(1);
  }
  webhookBase = webhookBase.replace(/\/$/, "");
  const webhookUrl = `${webhookBase}/telegram/webhook`;

  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) {
    console.warn(
      "[telegram] TELEGRAM_WEBHOOK_SECRET is empty — webhook will accept ALL requests. Set it in .env.local for security.",
    );
  }

  const body = {
    url: webhookUrl,
    allowed_updates: ["message"],
    drop_pending_updates: false,
  };
  if (secret) body.secret_token = secret;

  const { ok, data } = await tgApi(token, "setWebhook", body);
  if (!ok) {
    console.error(`[telegram] setWebhook failed: ${data?.description ?? "unknown error"}`);
    process.exit(1);
  }
  console.log(`[telegram] registered webhook ${webhookUrl}`);

  const me = await tgApi(token, "getMe", {});
  if (me.ok && me.data?.result?.username) {
    console.log(`[telegram] bot username: @${me.data.result.username}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
