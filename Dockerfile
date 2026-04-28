# syntax=docker/dockerfile:1.7

# Multi-stage build: deps → runtime. The server runs TypeScript via tsx, so
# there's no separate compile step — the runtime stage just keeps the source
# tree and the production-shaped node_modules. The debug UI (Vite) is
# intentionally not built — it's a local-only dev tool.

FROM node:20-bookworm-slim AS deps
WORKDIR /app
ENV NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false
COPY package.json package-lock.json* ./
RUN npm ci

# Build the debug dashboard (Vite + React) so the prod container can serve it
# at the site root. Done in a separate stage so the runtime image doesn't carry
# Vite or its plugins.
FROM node:20-bookworm-slim AS debug-build
WORKDIR /app
ENV NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json* ./
COPY tsconfig.json ./
COPY debug ./debug
COPY convex ./convex
RUN npm run build:debug

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    PORT=3456

RUN apt-get update && \
    apt-get install -y --no-install-recommends curl ca-certificates tini && \
    rm -rf /var/lib/apt/lists/* && \
    groupadd --system --gid 1001 boop && \
    useradd  --system --uid 1001 --gid boop --home /app --shell /bin/bash boop

COPY --from=deps --chown=boop:boop /app/node_modules ./node_modules
COPY --chown=boop:boop . .
COPY --from=debug-build --chown=boop:boop /app/debug/dist ./debug/dist

# If `convex/_generated/` is missing (e.g. .gitignore strips it), fall back to
# minimal stubs so the runtime imports don't crash. The real generated files
# should come from `npx convex deploy` / `convex dev` before the build.
RUN if [ ! -f convex/_generated/api.js ]; then \
      echo "[boop] convex/_generated missing — writing fallback stubs"; \
      mkdir -p convex/_generated && \
      printf 'export const api = new Proxy({}, { get: () => new Proxy({}, { get: () => () => undefined }) });\nexport const internal = api;\n' > convex/_generated/api.js && \
      printf 'export const mutation = (def) => def;\nexport const query = (def) => def;\nexport const action = (def) => def;\nexport const internalMutation = (def) => def;\nexport const internalQuery = (def) => def;\nexport const internalAction = (def) => def;\n' > convex/_generated/server.js; \
    fi && chown -R boop:boop convex/_generated && chown boop:boop /app

USER boop
EXPOSE 3456

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=4 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/health" || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["npx", "tsx", "server/index.ts"]
