import express from "express";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { handleUserMessage } from "./interaction-agent.js";
import { broadcast } from "./broadcast.js";

const API_BASE = "https://api.telegram.org";
const MAX_CHUNK = 4000;
const MARKDOWN_RESERVED = /[_*\[\]()~`>#+\-=|{}.!\\]/g;

export interface TelegramBotInfo {
  id: number;
  username?: string;
  firstName?: string;
}

function botToken(): string | null {
  const t = process.env.TELEGRAM_BOT_TOKEN?.trim();
  return t ? t : null;
}

function plainMode(): boolean {
  return process.env.TELEGRAM_PLAIN === "true";
}

function allowedChatIds(): Set<string> | null {
  const raw = process.env.TELEGRAM_ALLOWED_CHAT_IDS?.trim();
  if (!raw) return null;
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.length > 0 ? new Set(ids) : null;
}

function chunk(text: string, size = MAX_CHUNK): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  let buf = "";
  for (const line of text.split(/\n/)) {
    if ((buf + "\n" + line).length > size) {
      if (buf) out.push(buf);
      buf = line;
    } else {
      buf = buf ? buf + "\n" + line : line;
    }
  }
  if (buf) out.push(buf);
  return out;
}

function escapeAll(text: string): string {
  return text.replace(MARKDOWN_RESERVED, (c) => `\\${c}`);
}

// Convert CommonMark-ish output from the LLM to Telegram MarkdownV2.
// Telegram's MarkdownV2 differs from CommonMark:
//   bold:   *text*  (CommonMark: **text**)
//   italic: _text_  (CommonMark: *text* or _text_)
//   code:   `text`  (same)
//   block:  ```...``` (same)
//   link:   [text](url) (same, but () must be escaped inside url unless in parens-balanced)
// Outside structures every reserved char must be escaped.
//
// Strategy: tokenize by recognizing fenced code, inline code, bold (**), italic
// (single * or _), and links. Inside code: only escape ` and \. Outside code:
// escape every reserved char that isn't part of the structure markers.
export function toMarkdownV2(input: string): string {
  if (plainMode()) return input;
  const tokens: Array<{ type: string; content: string; href?: string }> = [];
  let i = 0;
  while (i < input.length) {
    // Fenced code block
    if (input.startsWith("```", i)) {
      const end = input.indexOf("```", i + 3);
      if (end !== -1) {
        const inner = input.slice(i + 3, end);
        // Drop optional language tag on first line
        const nl = inner.indexOf("\n");
        const code = nl >= 0 ? inner.slice(nl + 1) : inner;
        tokens.push({ type: "fence", content: code });
        i = end + 3;
        continue;
      }
    }
    // Inline code
    if (input[i] === "`") {
      const end = input.indexOf("`", i + 1);
      if (end !== -1) {
        tokens.push({ type: "code", content: input.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    // Bold (**...**)
    if (input.startsWith("**", i)) {
      const end = input.indexOf("**", i + 2);
      if (end !== -1) {
        tokens.push({ type: "bold", content: input.slice(i + 2, end) });
        i = end + 2;
        continue;
      }
    }
    // Italic (*...* but not **) — only if surrounded by non-space
    if (input[i] === "*" && input[i + 1] !== "*" && input[i + 1] !== " ") {
      const end = input.indexOf("*", i + 1);
      if (end !== -1 && input[end - 1] !== " ") {
        tokens.push({ type: "italic", content: input.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    // Italic via underscore
    if (input[i] === "_" && input[i + 1] !== "_" && input[i + 1] !== " ") {
      const end = input.indexOf("_", i + 1);
      if (end !== -1 && input[end - 1] !== " ") {
        tokens.push({ type: "italic", content: input.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    // Link [text](url)
    if (input[i] === "[") {
      const close = input.indexOf("]", i + 1);
      if (close !== -1 && input[close + 1] === "(") {
        const urlEnd = input.indexOf(")", close + 2);
        if (urlEnd !== -1) {
          tokens.push({
            type: "link",
            content: input.slice(i + 1, close),
            href: input.slice(close + 2, urlEnd),
          });
          i = urlEnd + 1;
          continue;
        }
      }
    }
    // Plain char
    const next = tokens[tokens.length - 1];
    if (next && next.type === "text") {
      next.content += input[i];
    } else {
      tokens.push({ type: "text", content: input[i] });
    }
    i++;
  }

  let out = "";
  for (const t of tokens) {
    switch (t.type) {
      case "text":
        out += escapeAll(t.content);
        break;
      case "bold":
        out += `*${escapeAll(t.content)}*`;
        break;
      case "italic":
        out += `_${escapeAll(t.content)}_`;
        break;
      case "code": {
        const inner = t.content.replace(/[`\\]/g, (c) => `\\${c}`);
        out += `\`${inner}\``;
        break;
      }
      case "fence": {
        const inner = t.content.replace(/[`\\]/g, (c) => `\\${c}`);
        out += `\`\`\`\n${inner}\n\`\`\``;
        break;
      }
      case "link": {
        const text = escapeAll(t.content);
        const href = (t.href ?? "").replace(/[)\\]/g, (c) => `\\${c}`);
        out += `[${text}](${href})`;
        break;
      }
    }
  }
  return out;
}

async function callApi<T = unknown>(method: string, body: Record<string, unknown>): Promise<T | null> {
  const token = botToken();
  if (!token) return null;
  const res = await fetch(`${API_BASE}/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as { ok?: boolean; result?: T; description?: string } | null;
  if (!res.ok || !data?.ok) {
    const desc = data?.description ?? `HTTP ${res.status}`;
    console.error(`[telegram] ${method} failed: ${desc}`);
    return null;
  }
  return (data.result ?? null) as T | null;
}

export async function sendTelegram(chatId: string, text: string): Promise<void> {
  if (!botToken()) {
    console.warn("[telegram] missing TELEGRAM_BOT_TOKEN — not sending");
    return;
  }
  const usePlain = plainMode();
  for (const part of chunk(text)) {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text: usePlain ? part : toMarkdownV2(part),
    };
    if (!usePlain) body.parse_mode = "MarkdownV2";

    const token = botToken()!;
    const res = await fetch(`${API_BASE}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      console.log(`[telegram] → sent ${part.length} chars to ${chatId}`);
      continue;
    }
    const errBody = (await res.json().catch(() => null)) as { description?: string } | null;
    const desc = errBody?.description ?? `HTTP ${res.status}`;
    // Retry as plain if MarkdownV2 parsing failed.
    if (!usePlain && /can't parse entities|Bad Request/i.test(desc)) {
      console.warn(`[telegram] MarkdownV2 parse failed (${desc}) — retrying as plain text`);
      const retry = await fetch(`${API_BASE}/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: part }),
      });
      if (!retry.ok) {
        console.error(`[telegram] plain retry also failed ${retry.status}`);
      }
    } else {
      console.error(`[telegram] send failed: ${desc}`);
    }
  }
}

export async function sendTelegramTyping(chatId: string): Promise<void> {
  await callApi("sendChatAction", { chat_id: chatId, action: "typing" });
}

export function startTypingLoop(chatId: string): () => void {
  sendTelegramTyping(chatId).catch(() => {});
  const timer = setInterval(() => {
    sendTelegramTyping(chatId).catch(() => {});
  }, 5000);
  return () => clearInterval(timer);
}

export async function getBotInfo(): Promise<TelegramBotInfo | null> {
  const result = await callApi<{ id: number; username?: string; first_name?: string }>("getMe", {});
  if (!result) return null;
  return { id: result.id, username: result.username, firstName: result.first_name };
}

export async function setWebhook(url: string): Promise<boolean> {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  const body: Record<string, unknown> = {
    url,
    allowed_updates: ["message"],
    drop_pending_updates: false,
  };
  if (secret) body.secret_token = secret;
  const res = await callApi<true>("setWebhook", body);
  return res !== null;
}

export function createTelegramRouter(): express.Router {
  const router = express.Router();
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();

  router.post("/webhook", async (req, res) => {
    if (expectedSecret) {
      const got = req.header("X-Telegram-Bot-Api-Secret-Token");
      if (got !== expectedSecret) {
        console.warn("[telegram] webhook rejected — bad secret token");
        res.status(401).json({ ok: false });
        return;
      }
    }

    const update = req.body ?? {};
    const updateId: number | undefined = update.update_id;
    const message = update.message;
    if (!message || !message.text || typeof updateId !== "number") {
      res.json({ ok: true, skipped: true });
      return;
    }

    const chatId = String(message.chat?.id ?? "");
    const text: string = String(message.text);
    if (!chatId) {
      res.json({ ok: true, skipped: true });
      return;
    }

    const whitelist = allowedChatIds();
    if (whitelist && !whitelist.has(chatId)) {
      console.warn(`[telegram] ignoring message from unwhitelisted chat ${chatId}`);
      res.json({ ok: true, ignored: true });
      return;
    }

    const { claimed } = await convex.mutation(api.telegramDedup.claim, {
      updateId,
    });
    if (!claimed) {
      res.json({ ok: true, deduped: true });
      return;
    }

    const conversationId = `tg:${chatId}`;
    const turnTag = Math.random().toString(36).slice(2, 8);
    const preview = text.length > 100 ? text.slice(0, 100) + "…" : text;
    console.log(`[turn ${turnTag}] ← tg:${chatId}: ${JSON.stringify(preview)}`);
    const start = Date.now();

    broadcast("message_in", { conversationId, content: text, from_number: chatId, handle: String(updateId) });
    res.json({ ok: true });

    const stopTyping = startTypingLoop(chatId);
    try {
      const reply = await handleUserMessage({
        conversationId,
        content: text,
        turnTag,
        onThinking: (t) => broadcast("thinking", { conversationId, t }),
      });
      if (reply) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        const replyPreview = reply.length > 100 ? reply.slice(0, 100) + "…" : reply;
        console.log(
          `[turn ${turnTag}] → reply (${elapsed}s, ${reply.length} chars): ${JSON.stringify(replyPreview)}`,
        );
        await sendTelegram(chatId, reply);
        await convex.mutation(api.messages.send, {
          conversationId,
          role: "assistant",
          content: reply,
        });
      } else {
        console.log(`[turn ${turnTag}] → (no reply)`);
      }
    } catch (err) {
      console.error(`[turn ${turnTag}] handler error`, err);
    } finally {
      stopTyping();
    }
  });

  return router;
}

export function telegramConfigured(): boolean {
  return Boolean(botToken());
}
