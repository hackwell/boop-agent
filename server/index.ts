import "./env-setup.js";
import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { WebSocketServer } from "ws";
import { addClient } from "./broadcast.js";
import { createSendblueRouter } from "./sendblue.js";
import { createTelegramRouter, telegramConfigured } from "./telegram.js";
import { handleUserMessage } from "./interaction-agent.js";
import { loadIntegrations } from "./integrations/registry.js";
import { startCleanupLoop } from "./memory/clean.js";
import { startAutomationLoop } from "./automations.js";
import { startHeartbeatLoop } from "./heartbeat.js";
import { startConsolidationLoop } from "./consolidation.js";
import { cancelAgent, retryAgent } from "./execution-agent.js";
import { createComposioRouter } from "./composio-routes.js";

function sendblueConfigured(): boolean {
  return Boolean(process.env.SENDBLUE_API_KEY && process.env.SENDBLUE_API_SECRET);
}

async function main() {
  await loadIntegrations();
  startCleanupLoop();
  startAutomationLoop();
  startHeartbeatLoop();
  startConsolidationLoop();

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "2mb" }));

  // Strip the /api prefix used by the Vite dev proxy so the same UI build
  // works against the prod server (which mounts routes at the root).
  app.use((req, _res, next) => {
    if (req.url.startsWith("/api/")) req.url = req.url.slice(4);
    else if (req.url === "/api") req.url = "/";
    next();
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "boop-agent" });
  });

  const hasSendblue = sendblueConfigured();
  const hasTelegram = telegramConfigured();
  if (hasSendblue) {
    app.use("/sendblue", createSendblueRouter());
  }
  if (hasTelegram) {
    app.use("/telegram", createTelegramRouter());
  }
  if (!hasSendblue && !hasTelegram) {
    console.warn(
      "[boop] No messaging channel configured. Set SENDBLUE_API_KEY+SENDBLUE_API_SECRET or TELEGRAM_BOT_TOKEN in .env.local. Local /chat endpoint still works.",
    );
  }
  app.use("/composio", createComposioRouter());

  app.post("/agents/:id/cancel", (req, res) => {
    const ok = cancelAgent(req.params.id);
    res.json({ ok });
  });

  app.post("/consolidate", async (_req, res) => {
    try {
      const { runConsolidation } = await import("./consolidation.js");
      // Fire-and-forget so the HTTP request returns immediately.
      runConsolidation("manual").catch((err) =>
        console.error("[consolidation] manual run failed", err),
      );
      res.json({ ok: true, triggered: "manual" });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post("/agents/:id/retry", async (req, res) => {
    const result = await retryAgent(req.params.id);
    if (!result) {
      res.status(404).json({ error: "agent not found" });
      return;
    }
    res.json(result);
  });

  // Chat endpoint for local testing and the debug dashboard
  app.post("/chat", async (req, res) => {
    const { conversationId, content } = req.body ?? {};
    if (!conversationId || !content) {
      res.status(400).json({ error: "conversationId and content required" });
      return;
    }
    try {
      const reply = await handleUserMessage({ conversationId, content });
      res.json({ reply });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: String(err) });
    }
  });

  // Serve the built debug UI from /, if it exists. The Vite build outputs to
  // debug/dist (see debug/vite.config.ts). In production the Dockerfile builds
  // it; locally `npm run dev:debug` is preferred over the static build.
  const here = dirname(fileURLToPath(import.meta.url));
  const debugDist = resolve(here, "..", "debug", "dist");
  const debugIndex = resolve(debugDist, "index.html");
  if (existsSync(debugIndex)) {
    app.use(express.static(debugDist));
    app.get(/^\/(?!api|health|sendblue|telegram|composio|agents|consolidate|chat|ws).*/, (_req, res) => {
      res.sendFile(debugIndex);
    });
    console.log(`[boop] serving debug UI from ${debugDist}`);
  }

  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (ws) => {
    addClient(ws);
    ws.send(JSON.stringify({ event: "hello", data: { ok: true }, at: Date.now() }));
  });

  const port = Number(process.env.PORT ?? 3456);
  server.listen(port, () => {
    console.log(`boop-agent server listening on :${port}`);
    console.log(`  health      GET  http://localhost:${port}/health`);
    console.log(`  chat        POST http://localhost:${port}/chat`);
    if (hasSendblue) {
      console.log(`  sendblue    POST http://localhost:${port}/sendblue/webhook`);
    }
    if (hasTelegram) {
      console.log(`  telegram    POST http://localhost:${port}/telegram/webhook`);
    }
    console.log(`  websocket   WS   ws://localhost:${port}/ws`);
  });
}

main().catch((err) => {
  console.error("fatal", err);
  process.exit(1);
});
