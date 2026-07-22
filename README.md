# bookipi-technical-test — Flash Sale System

A high-throughput flash sale backend + SPA: one limited-stock product, thousands
of concurrent buyers, one confirmed order per user, correctness held even under
surge load and partial failure.

**This is a Phase 0 (bootstrap) README.** It covers what exists today — repo
layout, local dev, and the verification commands. The full write-up (design
choices, architecture diagram, stress-test guide, results table) is a **Phase 6**
deliverable per `PRD.md` §8 and will replace/extend this file then. For the
authoritative spec, read [`PRD.md`](./PRD.md) in full. For the build process,
agent roster, and resume protocol, read [`AGENTS.md`](./AGENTS.md). For "where is
the build right now," read [`STATE.md`](./STATE.md).

## Hard invariants

Every phase gate exists to prove these hold (see `AGENTS.md` §2 for enforcement
detail):

- **I1** — No oversell: confirmed orders ≤ initial stock.
- **I2** — One per user: at most one confirmed order per `user_id`.
- **I3** — Window enforcement: no purchase outside `[startsAt, endsAt)`.
- **I4** — No lost confirmations: every Redis-confirmed reservation eventually
  persists to Postgres or is compensated — never silently dropped.

## Stack

pnpm + Turborepo monorepo, strict TypeScript everywhere, Node 22 / pnpm 11.

| Path               | What                                                         |
| ------------------ | ------------------------------------------------------------ |
| `apps/api`         | NestJS on the Fastify adapter — sale + purchase API          |
| `apps/worker`      | Nest standalone BullMQ consumer — durable order persistence  |
| `apps/web`         | Vite + React SPA                                             |
| `packages/shared`  | DTOs, types, purchase state machine                          |
| `packages/tooling` | eslint / tsconfig / prettier presets shared by every package |
| `infra/`           | Dockerfiles + `docker-compose.yml` for the local stack       |
| `load/`            | k6 load-test scenarios (Phase 5)                             |

Redis 7 is the authoritative hot path for the purchase decision; Postgres 16 is
the durable record.

## Local dev quickstart

Prerequisites: **Node 22.14.x**, **pnpm 11.9.x** (both pinned — see `.nvmrc` and
`package.json#packageManager`), Docker Desktop with Compose v2 for the datastore
containers.

```bash
pnpm i
docker compose -f infra/docker-compose.yml up -d
pnpm dev
```

Copy `.env.example` to `.env` for local (non-compose) runs — see that file for the
canonical env var contract. Never commit `.env`.

**Ports** (host-side datastore ports are shifted off defaults so a local
Postgres/Redis install never collides):

| Service                                 | Container port | Host port (compose) |
| --------------------------------------- | -------------- | ------------------- |
| `api`                                   | 3000           | 3000                |
| `worker` (health only)                  | 3001           | 3001                |
| `web` (nginx in compose / vite locally) | 80             | 5173                |
| `postgres`                              | 5432           | 5433                |
| `redis`                                 | 6379           | 6380                |

## Verification

Canonical local verification, run from the repo root (mirrors the CI job graph in
`.github/workflows/ci.yml`):

```bash
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:integration   # passes with no integration tests present pre-Phase-2
pnpm stress              # prints the Phase-5 placeholder pre-Phase-5, exits 0
```

`docker compose -f infra/docker-compose.yml config -q` validates the compose file
without starting anything, if Docker isn't available in your environment.

## Accepted risks — client-asserted identity

**No authentication exists anywhere in this system, by explicit PRD scope
decision** (`PRD.md`: "Payments, carts, multiple products, real auth (user
identifier string only, per brief)"). `userId` on `POST /api/purchase` and
`GET /api/purchase/:userId` is a bare string the caller asserts in the request —
there is no session, token, or proof of ownership binding it to whoever is
actually making the request. This is a deliberate scope boundary for a take-home
exercise, not an oversight, but it has real, stated consequences a production
deployment MUST close before this code (or anything built on the same pattern)
handles real users or real money:

- **Entitlement theft.** Anyone holding a list of candidate userIds (an email
  list, a username scheme) can `POST /api/purchase` on a victim's behalf. I2 (one
  confirmed order per user) is then enforced _against the attacker-chosen
  string_, so the victim's own later, genuine attempt gets `409
ALREADY_PURCHASED` and can never succeed — the attacker has permanently burned
  a real person's entitlement without ever proving who they are.
- **Buyer enumeration oracle.** `409 ALREADY_PURCHASED` on `POST /api/purchase`,
  and `GET /api/purchase/:userId`'s `purchased: true/false`, both answer "did
  this specific userId buy one" for anyone who asks, unauthenticated. No route
  bulk-lists buyers (`scanReservations` is never called from `apps/api/src/**`),
  but an attacker with a candidate list can enumerate the buyer set one probe at
  a time. (`.claude/contracts/phase-2.md` §10.5 originally read "No endpoint
  enumerates buyers" without this caveat; corrected there as part of the same
  review that recorded this section.)
- **Targeted rate-limit exhaustion.** `PerUserRateLimitGuard` keys its bucket on
  `(sourceIp, saleId, userId)` (see `apps/api/src/common/per-user-rate-limit.guard.ts`
  for the fix and its rationale) specifically so a third party spamming a
  victim's `userId` from their own address cannot exhaust the _victim's_ budget —
  but this only closes the rate-limit-specific instance of the underlying gap.
  The identity itself is still unauthenticated, so the entitlement-theft and
  enumeration risks above stand regardless of the rate limiter.

**Before any real deployment:** put real authentication (session or JWT) in
front of `POST /api/purchase` and `GET /api/purchase/:userId`, and derive
`userId` from the authenticated principal — never trust a body/param field for
identity again. This is the single largest security property of the system as
built and is recorded here so it is a decision under review, not a silent gap.

## Repo conventions

See `AGENTS.md` §10 for the full list (package scope, no path aliases, CJS
backend / ESM web, commit style, branch naming). The short version: package scope
is `@flash/*`, commits are Conventional Commits, branches are `phase-N/<slice>`,
and `prototype/index.html` is a read-only approved design reference — never edit
it.

## Status

Phase 0 (bootstrap) — see `STATE.md` for exact current phase, last tag, open
issues, and next actions.
