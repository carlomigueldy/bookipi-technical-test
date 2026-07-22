# syntax=docker/dockerfile:1.7
#
# infra/worker.Dockerfile — @flash/worker (Nest standalone BullMQ consumer)
# Build context is the repo ROOT (see infra/docker-compose.yml: build.context = "..")
# so the pnpm workspace (root manifests + all workspace package.json files) is visible.

FROM node:22.11-alpine AS base
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
WORKDIR /app

# ---- deps: resolve the whole workspace graph; cached while manifests are unchanged ----
FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY packages/tooling/package.json packages/tooling/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile

# ---- build: full source, build @flash/worker and its workspace dependencies ----
FROM deps AS build
COPY . .
RUN pnpm --filter @flash/worker... build
# Self-contained production deploy: resolves workspace deps (@flash/shared) by copying
# their built output rather than symlinking, so the runtime stage needs nothing else.
RUN pnpm --filter=@flash/worker --prod deploy /prod/worker

# ---- runtime: minimal image, only the deployed output, non-root ----
FROM node:22.11-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /prod/worker .
USER node
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:3001/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "dist/main.js"]
