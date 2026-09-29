# Throttle API + worker.
#
# One image, two roles. `ROLE=api` serves HTTP, `ROLE=worker` consumes queues —
# see src/index.ts. Building once and selecting at runtime keeps the two guaranteed
# to run identical code, which matters because they share the scheduling logic.

# ── Stage 1: dependencies ────────────────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app

# Copy only manifests first. This layer is cached and only invalidated when a
# dependency actually changes, so an ordinary source edit skips `npm ci` entirely.
COPY package.json package-lock.json ./
COPY packages/core/package.json ./packages/core/
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/

RUN npm ci --ignore-scripts

# ── Stage 2: build ───────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/core/node_modules ./packages/core/node_modules
COPY . .

# Prisma's engines are platform-specific and are skipped by --ignore-scripts above,
# so the client is generated explicitly here.
RUN npx prisma generate --schema apps/api/prisma/schema.prisma

# core first — the API imports its compiled output.
RUN npm run build -w @throttle/core \
 && npx tsc -p apps/api/tsconfig.json

# ── Stage 3: runtime ─────────────────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

# dumb-init as PID 1. Node does not reap zombies or forward signals correctly as
# PID 1, which would break the graceful shutdown that lets in-flight sends finish.
RUN apk add --no-cache dumb-init

# Run unprivileged. Node's base image ships a `node` user; using it means a container
# escape does not start from root.
USER node

COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/packages/core/dist ./packages/core/dist
COPY --from=builder --chown=node:node /app/packages/core/package.json ./packages/core/
COPY --from=builder --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=builder --chown=node:node /app/apps/api/package.json ./apps/api/
COPY --from=builder --chown=node:node /app/apps/api/prisma ./apps/api/prisma
COPY --from=builder --chown=node:node /app/package.json ./

EXPOSE 4000

# Uses /healthz (liveness), not /readyz — a temporarily unreachable Elasticsearch
# should not cause the orchestrator to kill and restart a perfectly healthy process.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:4000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/api/dist/index.js"]
