# syntax=docker/dockerfile:1.7
#
# infra/web.Dockerfile — @flash/web (Vite + React SPA)
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

# ---- build: full source, build @flash/web (bakes VITE_API_BASE_URL at build time) ----
FROM deps AS build
ARG VITE_API_BASE_URL=http://localhost:3000/api
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
COPY . .
RUN pnpm --filter @flash/web... build

# ---- runtime: static assets served by nginx, SPA fallback ----
FROM nginx:1.27-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10 AS runtime
COPY infra/web.nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=6 \
  CMD wget -q --spider http://127.0.0.1/ || exit 1
CMD ["nginx", "-g", "daemon off;"]
