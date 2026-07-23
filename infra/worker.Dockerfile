# syntax=docker/dockerfile:1.7
#
# infra/worker.Dockerfile — @flash/worker (Nest standalone BullMQ consumer)
# Build context is the repo ROOT (see infra/docker-compose.yml: build.context = "..")
# so the pnpm workspace (root manifests + all workspace package.json files) is visible.

# Pin the reviewed Node OCI index and checksum-verify the pnpm bootstrap archive.
FROM node:22.14-alpine@sha256:9bef0ef1e268f60627da9ba7d7605e8831d5b56ad07487d24d1aa386336d1944 AS base
ADD --checksum=sha256:2b567aa66026238078ac2e0a33bec3febd60e962987aac697456f3180819b287 https://registry.npmjs.org/pnpm/-/pnpm-11.9.0.tgz /tmp/pnpm.tgz
RUN set -eux; \
  test ! -e /usr/local/bin/pnpm; \
  mkdir -p /opt/pnpm; \
  tar -xzf /tmp/pnpm.tgz -C /opt/pnpm --strip-components=1; \
  ln -s /opt/pnpm/bin/pnpm.mjs /usr/local/bin/pnpm; \
  test "$(pnpm --version)" = "11.9.0"; \
  rm /tmp/pnpm.tgz
WORKDIR /app

# ---- deps: resolve the whole workspace graph; cached while manifests are unchanged ----
FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY packages/tooling/package.json packages/tooling/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/redis/package.json packages/redis/package.json
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
# --legacy: pnpm v10+ deploy defaults to injected-workspace-package mode, which requires
# repo-wide `inject-workspace-packages=true`; --legacy keeps the copy-based deploy this
# Dockerfile relies on without touching the root .npmrc (owned by another slice).
RUN pnpm --filter=@flash/worker --prod deploy --legacy /prod/worker

# ---- runtime: minimal image, only the deployed output, non-root ----
FROM node:22.14-alpine@sha256:9bef0ef1e268f60627da9ba7d7605e8831d5b56ad07487d24d1aa386336d1944 AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /prod/worker/package.json ./package.json
COPY --from=build --chown=node:node /prod/worker/node_modules ./node_modules
COPY --from=build --chown=node:node /prod/worker/dist ./dist
USER node
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:3001/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "dist/main.js"]
