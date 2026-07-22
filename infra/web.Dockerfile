# syntax=docker/dockerfile:1.7
#
# infra/web.Dockerfile — @flash/web (Vite + React SPA)
# Build context is the repo ROOT (see infra/docker-compose.yml: build.context = "..")
# so the pnpm workspace (root manifests + all workspace package.json files) is visible.

# node:22.11-alpine's Node.js (v22.11.0) is below pnpm@11.9.0's minimum supported Node
# (>=22.13), and separately its bundled corepack has npm-registry signing keys that go
# stale over time ("Cannot find matching keyid") independent of network/registry
# reachability. 22.14-alpine clears the engine floor; installing pnpm directly via npm
# (below) sidesteps corepack's signature-verification path entirely, which is more robust
# for a cold build months from now than re-upgrading corepack in place.
FROM node:22.14-alpine AS base
RUN npm install -g pnpm@11.9.0
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

# ---- build: full source, build @flash/web (bakes VITE_API_BASE_URL at build time) ----
FROM deps AS build
ARG VITE_API_BASE_URL=http://localhost:3000/api
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
COPY . .
RUN pnpm --filter @flash/web... build

# ---- runtime: static assets served by nginx, SPA fallback ----
FROM nginx:1.27-alpine AS runtime
COPY infra/web.nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=6 \
  CMD wget -q --spider http://127.0.0.1/ || exit 1
CMD ["nginx", "-g", "daemon off;"]
