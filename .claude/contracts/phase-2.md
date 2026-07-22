# Phase 2 — FROZEN CONTRACT (API)

**Authority:** ARCHITECT (Opus) · **Date:** 2026-07-22 · **Status:** FROZEN
**Above this doc:** `PRD.md`. Where this doc pins a detail the PRD left open, or deliberately
refines the PRD, **this doc wins** — every such refinement is called out explicitly in §0.3.
**Also binding:** `.claude/contracts/phase-0.md` and `.claude/contracts/phase-1.md` (both still
frozen; this doc makes only the *additive* amendments listed in §0.2, the erratum in §13, and the
versioned Amendments A1–A4 in §§15–18).
**Consumers:** SLICE A, B, C, D, E implementation agents — who never talk to each other.

> **Every name, number, path, token, route, and status code in this document is FINAL.** If an
> implementer finds something unspecified, they MUST stop and escalate to the orchestrator →
> architect. They must NEVER invent a name another slice could also need.

> **Process rules inherited from Phases 0 and 1 (non-negotiable).**
> 1. Verification is command-evidence based, never self-attestation. Turbo cache replays are not
>    evidence — always `--force` and confirm `Cached: 0 cached`.
> 2. **Never fix a finding by weakening, skipping, or deleting the check that caught it.** Phase 1's
>    named form of this rule carries forward verbatim: *a Redis- or Postgres-dependent spec must
>    never `describe.skip` / `it.skip` / early-return when the datastore is unavailable.* It must
>    fail.
> 3. **New in Phase 2, and absolute:** there must be **no `NODE_ENV`/`process.env`-conditional
>    branch anywhere under `apps/api/src/**` that disables, bypasses, or loosens a guard, a
>    validator, a rate limiter, or an exception filter.** Limits are *configured* by env; control
>    flow is not. A reviewer finding `if (env.NODE_ENV === 'test')` around a security control in
>    `src/**` fails the slice outright. (Phase 0's deleted security gate is the precedent.)
> 4. Every atomicity/concurrency claim ships with a **negative control** proving the harness can
>    detect the violation (Phase 1's T2 precedent). See §11.4.

---

## 0. Scope boundary (READ FIRST)

### 0.1 In / out

Phase 2 gate evidence (PRD §8): **"Integration suite green; concurrency spec passes."**

**IN SCOPE:**
- `apps/api/**` — `SaleModule`, `PurchaseModule`, `HealthModule`, and the shared infrastructure
  module they depend on (config, Redis providers, clock, logging, filters, pipes, guards).
- Global rate limiting (per-IP **and** per-user), structured pino logging with request IDs,
  helmet-equivalent headers, CORS.
- The **producer side only** of the BullMQ `orders` queue.
- A `pg` Pool used **only** by `GET /api/purchase/:userId` and the readiness probe — never on the
  purchase hot path.
- Integration tests with Testcontainers (real Redis 7.4 + Postgres 16), including PRD §6.1's
  concurrency spec **through HTTP**, its negative control, and window-edge specs.
- The minimal root wiring those require: new `.env.example` rows, new `turbo.json`
  `globalPassThroughEnv` entries, new `apps/api/package.json` dependencies.

**OUT OF SCOPE — an agent that builds these has failed its slice:**

| Thing | Owning phase |
|---|---|
| BullMQ **worker/consumer**, `Worker`, `QueueEvents`, job processors, DLQ handler, compensation call | 3 |
| Order persistence writes (`INSERT INTO orders`), boot reconciliation, the I4 startup sweep | 3 |
| Anything under `apps/worker/**` or `apps/web/**` | 3 / 4 |
| Any edit to `packages/shared/**` or `packages/redis/**` — **both are frozen** | — (escalate) |
| k6, `load/audit.ts` | 5 |
| README prose | 6 |

**Phase 2 writes zero code outside `apps/api/**`,** except the three root-file amendments in §2.2.

### 0.2 Additive amendments to the Phase 0 / Phase 1 frozen contracts

These are the *only* changes to previously frozen decisions. Everything else stands.

| Contract § | Amendment | Why |
|---|---|---|
| P0 §2 slice map | **SUPERSEDED for Phase 2 only** by §1 of this doc. Phase 0's A–E slices are historical. | new fan-out |
| P0 §11 env table | **ADD** 11 rows (§3.1): `TRUST_PROXY`, `REQUEST_BODY_LIMIT_BYTES`, `RATE_LIMIT_USER_MAX`, `RATE_LIMIT_USER_WINDOW_MS`, `CLOCK_SYNC_INTERVAL_MS`, `CLOCK_MAX_STALENESS_MS`, `CLOCK_GUARD_SKEW_MS`, `ENQUEUE_TIMEOUT_MS`, `PG_POOL_MAX`, `PG_STATEMENT_TIMEOUT_MS`, `POSTGRES_TEST_URL` | §5, §7, §8 |
| P0 §13 health surface | **ADD** route `GET /api/health/ready` and the `checks` object. The frozen four keys (`status`, `service`, `version`, `uptimeSeconds`) are preserved unrenamed on both routes. | §9 |
| P0 §16 metrics hash | No change. Phase 2 is the first writer (`bumpMetric`). | — |
| P1 §3.3 boundary table | **ERRATUM applied** — see §13. | STATE.md open issue 1 |
| P1 §5.2 `SaleRedisStore` | No change. Phase 2 consumes the frozen surface as-is and adds **no** primitive to `@flash/redis`. | §8.2 |

### 0.3 Deliberate refinements of the PRD (called out, not smuggled)

1. **PRD §4 lists one `/health` endpoint.** Phase 2 splits it into **liveness** (`GET /api/health`,
   never 503 on dependency failure) and **readiness** (`GET /api/health/ready`, 503-capable). A
   single endpoint that 503s on a Redis blip and is also the container healthcheck restarts every
   pod during a dependency wobble — the classic cascading-restart bug. §9 gives the full rule.
2. **PRD §4 lists `403 SALE_NOT_ACTIVE`.** The frozen §7 taxonomy in `@flash/shared` splits this
   into `SALE_NOT_STARTED` and `SALE_ENDED`, both 403. The API emits the split values; `403` is
   unchanged. The SPA needs the discriminator to choose "starts in…" vs "ended".
3. **PRD §6.1 mentions `ioredis-mock`.** Already superseded by Phase 1 decision 3. Phase 2's
   integration suite uses real containers only. Restated here so it cannot be re-litigated.
4. **PRD §3 says "the API never touches Postgres on the purchase hot path."** Honoured exactly:
   `POST /api/purchase` never opens a PG connection. `GET /api/purchase/:userId` and
   `GET /api/health/ready` do — different routes, not the hot path. §8.2 pins the reasoning.

---

## 1. Slice ownership map — FROZEN, file-level exclusive

Exclusive path ownership. A slice **must not create, edit, or delete** a path owned by another
slice. If slice X needs a change inside slice Y's path, it escalates to the orchestrator →
architect; it never edits and never messages another agent.

| Slice | Owns (exclusive) | Agent role |
|---|---|---|
| **A — Infrastructure & cross-cutting** | `apps/api/src/config/**`, `apps/api/src/common/**`, `apps/api/src/infra/**`, `apps/api/src/app.module.ts`, `apps/api/src/main.ts`, `apps/api/package.json`, `apps/api/vitest.config.ts`, root `.env.example`, root `turbo.json` | implementer |
| **B — Sale slice** | `apps/api/src/sale/**` | implementer |
| **C — Purchase slice** | `apps/api/src/purchase/**`, `apps/api/src/queue/**` | implementer |
| **D — Health slice** | `apps/api/src/health/**` | implementer |
| **E — Integration & concurrency suite** | `apps/api/test/**`, `apps/api/vitest.integration.config.ts` | implementer |
| **ARCH — TypeScript resolution config** | `packages/tooling/tsconfig/**`, `apps/*/tsconfig.json`, `apps/*/tsconfig.build.json` | **architect only** |

**ARCH row (added by Amendment A1, §14).** No implementer slice may create, edit, or delete a
path in the ARCH row — not even to unblock itself. Compiler-resolution settings are a whole-repo
concern: a per-app override fixes one slice and leaves a landmine for the next phase. An
implementer blocked by a module-resolution error escalates to the architect, who changes the
preset once for every package.

**Ordering.** A, B, C, D, E may all be *written* in parallel — the trees are disjoint. A's
`app.module.ts` imports `SaleModule`, `PurchaseModule`, `HealthModule` by the exact frozen class
names and paths in §2.1, which A writes **before** B/C/D exist; A never reads B/C/D's work. B, C,
D, E consume A's tokens by the exact frozen names in §4. **Merge order is A → B → C → D → E**,
then the orchestrator runs the §12 gate.

**Deletion rights.** SLICE D deletes `apps/api/src/health/health.controller.spec.ts` only if it
replaces it; SLICE A deletes nothing. No slice touches `apps/api/dist/**` (build output).

---

## 2. Directory tree — FROZEN, file by file

### 2.1 `apps/api/src/**`

```
apps/api/src/
├── main.ts                                   [A]  bootstrap: adapter opts, plugins, prefix, shutdown
├── app.module.ts                             [A]  imports InfraModule, SaleModule, PurchaseModule, HealthModule
│
├── config/                                   [A]
│   ├── env.ts                                     ApiEnv — EXTENDED with §3.1's 11 new rows
│   ├── env.schema.ts                              zod schema; parsed once at bootstrap, fail-fast
│   └── env.spec.ts
│
├── common/                                   [A]
│   ├── tokens.ts                                  every DI token symbol/string (§4.1)
│   ├── dto/api-error.ts                           ApiErrorResponse shape + builder (§6.5)
│   ├── messages.ts                                frozen outcome -> user-facing message table (§16.1)
│   ├── request-id.ts                              REQUEST_ID_PATTERN, extract-or-generate
│   ├── zod-validation.pipe.ts                     ZodValidationPipe -> 422 (§6.6)
│   ├── zod-validation.pipe.spec.ts
│   ├── http-exception.filter.ts                   global filter; renders every error into an envelope
│   ├── http-exception.filter.spec.ts
│   ├── per-user-rate-limit.guard.ts               per-user limiter (§7.3)
│   └── per-user-rate-limit.guard.spec.ts
│
├── infra/                                    [A]
│   ├── infra.module.ts                            @Global(); provides + exports every token in §4.1
│   ├── redis.providers.ts                         3 singleton ioredis clients + graceful shutdown
│   ├── postgres.providers.ts                      pg Pool singleton + graceful shutdown
│   ├── clock.service.ts                           RedisAnchoredClock (§5)
│   ├── clock.service.spec.ts
│   ├── sale-snapshot.cache.ts                     SaleSnapshotCache — refreshed by the clock timer (§5.4)
│   └── sale-snapshot.cache.spec.ts
│
├── sale/                                     [B]
│   ├── sale.module.ts                             SaleModule
│   ├── sale.controller.ts                         GET /api/sale/status, GET /api/sale/metrics
│   ├── sale.controller.spec.ts
│   ├── sale.service.ts                            snapshot -> SaleStatusResponse; sentinel handling (§6.2)
│   └── sale.service.spec.ts
│
├── purchase/                                 [C]
│   ├── purchase.module.ts                         PurchaseModule
│   ├── purchase.controller.ts                     POST /api/purchase, GET /api/purchase/:userId
│   ├── purchase.controller.spec.ts
│   ├── purchase.service.ts                        the flow in §8.1
│   ├── purchase.service.spec.ts
│   ├── purchase-status.service.ts                 the read in §8.2
│   └── purchase-status.service.spec.ts
│
├── queue/                                    [C]
│   ├── orders-queue.module.ts                     OrdersQueueModule (producer only)
│   ├── orders-queue.service.ts                    enqueue(), depth(), job shape (§8.3)
│   └── orders-queue.service.spec.ts
│
└── health/                                   [D]
    ├── health.module.ts                           HealthModule
    ├── health.controller.ts                       GET /api/health, GET /api/health/ready
    ├── health.controller.spec.ts
    ├── health.service.ts                          the checks in §9.3
    └── health.service.spec.ts
```

### 2.2 `apps/api/test/**` and root

```
apps/api/
├── vitest.config.ts                          [A]  UNIT only: include ['src/**/*.spec.ts']
├── vitest.integration.config.ts              [E]  INTEGRATION only (§11.1)
└── test/                                     [E]
    ├── global-setup.ts                            starts redis:7.4-alpine + postgres:16-alpine once
    ├── support/
    │   ├── app-harness.ts                         boot a real listening Nest app; returns baseUrl + teardown
    │   ├── http.ts                                undici Agent + typed request helpers
    │   ├── seed.ts                                seed a sale relative to REDIS's clock (§11.3)
    │   └── unsafe-purchase.service.ts              the negative control's non-atomic impl (§11.4)
    └── integration/
        ├── sale-status.integration.spec.ts        [E]
        ├── purchase-flow.integration.spec.ts      [E]
        ├── purchase-status.integration.spec.ts    [E]
        ├── window-edge.integration.spec.ts        [E]
        ├── rate-limit.integration.spec.ts         [E]
        ├── clock-skew.integration.spec.ts         [E]
        ├── health.integration.spec.ts             [E]
        ├── security.integration.spec.ts           [E]
        ├── concurrency.integration.spec.ts        [E]  THE MONEY TEST
        └── concurrency-negative-control.integration.spec.ts [E]

root (SLICE A only):
├── .env.example                                   ADD the §3.1 rows in their existing comment groups
└── turbo.json                                     ADD the §3.1 names to globalPassThroughEnv
```

`apps/api/src/health/health.controller.spec.ts` already exists (Phase 0) and is **replaced** by
SLICE D. Nothing else in the tree above exists yet.

### 2.3 Dependencies — SLICE A adds ALL of them, up front

`apps/api/package.json` `dependencies`:

| Package | Range | Used by |
|---|---|---|
| `@flash/redis` | `workspace:*` | A, B, C, D |
| `@fastify/rate-limit` | `^10.3.0` | A |
| `@fastify/helmet` | `^13.0.2` | A |
| `@fastify/cors` | `^11.1.0` | A |
| `nestjs-pino` | `^4.4.0` | A |
| `pino` | `^9.14.0` | A |
| `pino-http` | `^10.5.0` | A |
| `bullmq` | `^5.63.0` | C |
| `ioredis` | `^5.11.1` | A (explicit — do not rely on `@flash/redis`'s transitive copy) |
| `pg` | `^8.16.3` | A, C, D |
| `zod` | `^4.4.3` | A, B, C |

`devDependencies`: `@testcontainers/redis@^12.0.4`, `@testcontainers/postgresql@^12.0.4`,
`testcontainers@^12.0.4`, `undici@^7.16.0`, `@types/pg@^8.15.5`, `pino-pretty@^13.1.2`.

Ranges are minimums; the implementer resolves to the latest satisfying version and runs
`pnpm audit --audit-level high` (Phase 0's restored gate). **Never add an entry to
`pnpm-workspace.yaml`'s `auditConfig.ignoreGhsas` to make the audit pass** — escalate instead.

`apps/api/package.json` scripts change exactly once:
`"test:integration": "vitest run --config vitest.integration.config.ts"` (the Phase 0
`--passWithNoTests` placeholder is removed — an empty integration suite must now fail).

---

## 3. Environment contract

### 3.1 New rows (additive to Phase 0 §11)

| Name | Type | Default (host dev) | Read by | Notes |
|---|---|---|---|---|
| `TRUST_PROXY` | `true \| false` | **`false`** | api | §10.2 — untrusted `X-Forwarded-For` is a rate-limit bypass |
| `REQUEST_BODY_LIMIT_BYTES` | int | `16384` | api | §10.1 |
| `RATE_LIMIT_USER_MAX` | int | `5` | api | §7.2 |
| `RATE_LIMIT_USER_WINDOW_MS` | int | `1000` | api | §7.2 |
| `CLOCK_SYNC_INTERVAL_MS` | int | `5000` | api | §5.2 |
| `CLOCK_MAX_STALENESS_MS` | int | `15000` | api | §5.3 |
| `CLOCK_GUARD_SKEW_MS` | int | `250` | api | §5.5 |
| `ENQUEUE_TIMEOUT_MS` | int | `500` | api | §8.3 |
| `PG_POOL_MAX` | int | `10` | api | §8.2 |
| `PG_STATEMENT_TIMEOUT_MS` | int | `2000` | api | §8.2 |
| `POSTGRES_TEST_URL` | string | *(empty)* | api tests only | mirror of Phase 1's `REDIS_TEST_URL` |

All eleven go into `.env.example` (existing comment groups: `# rate limiting` gets the two
`RATE_LIMIT_USER_*` rows; a new `# api hardening` group gets `TRUST_PROXY`,
`REQUEST_BODY_LIMIT_BYTES`, `CLOCK_*`, `ENQUEUE_TIMEOUT_MS`, `PG_POOL_MAX`,
`PG_STATEMENT_TIMEOUT_MS`; `# test` gets `POSTGRES_TEST_URL`) **and** into `turbo.json`'s
`globalPassThroughEnv`.

### 3.2 Parsing — the Phase 0 rule is now lifted for `apps/api`

Phase 0 §11 mandated plain `process.env` reads with no zod. Phase 2 **replaces** that for
`apps/api` only: `config/env.schema.ts` defines a zod schema over the full table, and
`config/env.ts` calls `.parse(process.env)` **once, at module load, before `NestFactory.create`**.
An invalid or missing required value is a **fatal boot error with a printed field list** — never a
silent default in production. Rationale: a mistyped `RATE_LIMIT_MAX=twenty` silently becoming
`NaN` disables the limiter, and Phase 2 is the phase where env values became security controls.
`@nestjs/config` is **not** used — it adds a DI-scoped indirection over a value we need at
bootstrap, before the DI container exists.

`SALE_ID` is validated against `@flash/shared`'s `assertSaleId` at boot. `SALE_STARTS_AT` /
`SALE_ENDS_AT` must be parseable ISO-8601 with `endsAt > startsAt`.

---

## 4. Module structure & dependency injection — FROZEN

### 4.1 DI tokens — `apps/api/src/common/tokens.ts` [SLICE A]

Exact literal string values. No slice invents another.

```ts
export const API_ENV            = 'API_ENV';             // ApiEnv (parsed, frozen object)
export const REDIS_STORE_CLIENT = 'REDIS_STORE_CLIENT';  // ioredis — hot path ONLY
export const REDIS_LIMIT_CLIENT = 'REDIS_LIMIT_CLIENT';  // ioredis — rate limiter ONLY
export const REDIS_QUEUE_CLIENT = 'REDIS_QUEUE_CLIENT';  // ioredis — BullMQ ONLY
export const SALE_REDIS_STORE   = 'SALE_REDIS_STORE';    // SaleRedisStore
export const PG_POOL            = 'PG_POOL';             // pg.Pool
export const CLOCK              = 'CLOCK';               // Clock (interface, §5.1)
export const SALE_SNAPSHOT_CACHE= 'SALE_SNAPSHOT_CACHE'; // SaleSnapshotCache
export const ORDERS_QUEUE       = 'ORDERS_QUEUE';        // bullmq.Queue
```

### 4.2 `InfraModule` [SLICE A] — `@Global()`

Provides and **exports** every token in §4.1 except `ORDERS_QUEUE` (which `OrdersQueueModule`
owns). `@Global()` is used deliberately and is the only global module in the app: these are
process-wide singletons with no feature-module semantics, and threading them through four
`imports:` arrays buys nothing but ceremony.

**Redis client lifecycle — binding.**

- **Exactly three ioredis instances per process**, all created at module init via
  `@flash/redis`'s `createRedisClient(...)`. **Never** a connection per request — Phase 1 §5.1 and
  the `redis-connections` skill both forbid it, and at 2k rps it is an instant file-descriptor
  exhaustion.
- Three, not one, because their required options are mutually incompatible and their failure
  domains must not be shared:

  | Token | `connectionName` | Options | Why separate |
  |---|---|---|---|
  | `REDIS_STORE_CLIENT` | `flash-api-store` | `createRedisClient` defaults (`commandTimeout: 1000`, `maxRetriesPerRequest: 2`) | the hot path; must never queue behind limiter or queue traffic (head-of-line blocking) |
  | `REDIS_LIMIT_CLIENT` | `flash-api-ratelimit` | `overrides: { commandTimeout: 250, maxRetriesPerRequest: 1 }` | a slow limiter must fail fast and fail open (§7.4), not stall the request |
  | `REDIS_QUEUE_CLIENT` | `flash-api-queue` | `overrides: { maxRetriesPerRequest: null, commandTimeout: undefined }` | BullMQ **requires** `maxRetriesPerRequest: null`; Phase 1 `client.ts`'s header comment forbids reusing or mutating the store client for this |

- `SALE_REDIS_STORE` = `new SaleRedisStore(REDIS_STORE_CLIENT)` — one instance, injected, never
  constructed inside a service.
- **Graceful shutdown.** `main.ts` calls `app.enableShutdownHooks()`. `InfraModule` implements
  `OnApplicationShutdown` and awaits, in order: BullMQ `Queue.close()`, then
  `closeRedisClient()` on all three clients, then `pool.end()`. Bounded by a 5s timeout after
  which the process exits anyway — a shutdown that hangs forever is worse than one that drops a
  connection. `main.ts` additionally sets `app.getHttpAdapter().getInstance()`'s
  `forceCloseConnections` behaviour via Nest's own `app.close()`.

**Postgres.** One `pg.Pool` (`max: PG_POOL_MAX`, `idleTimeoutMillis: 30000`,
`connectionTimeoutMillis: 2000`, `statement_timeout: PG_STATEMENT_TIMEOUT_MS`,
`application_name: 'flash-api'`). Created lazily-connecting; a Postgres outage at boot must **not**
prevent the API from starting (PRD §3.5: reservations keep succeeding while PG is down).

**Scope.** Every provider in the app is the default **singleton** scope. `Scope.REQUEST` is
**forbidden** anywhere in `apps/api/src/**` — it forces Nest to rebuild the injector subtree per
request and would destroy the p95 budget. Request-scoped data (request id) travels via the
pino/AsyncLocalStorage context and explicit function arguments, never via DI.

### 4.3 Feature modules

| Module | File | Imports | Controllers | Providers |
|---|---|---|---|---|
| `AppModule` | `app.module.ts` [A] | `InfraModule`, `LoggerModule.forRoot(...)` (nestjs-pino), `SaleModule`, `PurchaseModule`, `HealthModule` | — | global `APP_FILTER` = `HttpExceptionFilter` |
| `InfraModule` | `infra/infra.module.ts` [A] | — | — | §4.1 minus `ORDERS_QUEUE` |
| `SaleModule` | `sale/sale.module.ts` [B] | — | `SaleController` | `SaleService` |
| `PurchaseModule` | `purchase/purchase.module.ts` [C] | `OrdersQueueModule` | `PurchaseController` | `PurchaseService`, `PurchaseStatusService`, `PerUserRateLimitGuard` |
| `OrdersQueueModule` | `queue/orders-queue.module.ts` [C] | — | — | `ORDERS_QUEUE`, `OrdersQueueService` (both exported) |
| `HealthModule` | `health/health.module.ts` [D] | `OrdersQueueModule` | `HealthController` | `HealthService` |

`PerUserRateLimitGuard` is declared in `common/` (SLICE A) and **registered per-route** by SLICE C
with `@UseGuards(PerUserRateLimitGuard)` on `POST /api/purchase` only. It is **not** an
`APP_GUARD` — a global guard would run on `GET` routes that have no body and no user.

---

## 5. THE CLOCK — resolution of Phase 1 open issue 2 — FROZEN

> **Problem restated.** `deriveSaleState` is pure with an injected `nowMs`. The API's fast-path
> window guard needs a `nowMs`, and `@flash/redis` exposes no primitive for learning Redis's clock
> offset. A pod whose clock runs 5s fast would reject, with 403 `SALE_ENDED`, purchases that
> `purchase.lua` would have confirmed. Enforcement is safe (Lua owns I3), so this is a
> **false-negative / UX defect, not an invariant defect** — but it is user-visible twice: as a
> wrongly-rejected purchase, and as a countdown that flips at the wrong moment (PRD §5.2 computes
> the countdown from `serverTime`).

### 5.1 The decision

**Two different `now`s, pinned separately.**

**(a) `serverTime` in a response is never synthesized when Redis already told us the time.**

| Response | `serverTimeMs` source | Drift |
|---|---|---|
| `GET /api/sale/status` 200 | `SaleSnapshot.serverTimeMs` — the `redis.call('TIME')` inside `status.lua` for *this* request | **zero** |
| `POST /api/purchase` — any outcome that reached Lua (201/409/410/403) | `PurchaseResult.serverTimeMs` — the `TIME` inside `purchase.lua` that judged *this* decision | **zero** |
| `POST /api/purchase` 422/429/503, `GET /api/purchase/:userId`, health, all `ApiErrorResponse`s | `Clock.nowMs()` (§5.2) | bounded by §5.3 |

This is the single most important line in this section: the SPA's countdown and the purchase
verdict are judged by *the same clock reading*, because both Lua scripts already return the `TIME`
they used. There is nothing to reconcile. `serverTime` (ISO) is always
`new Date(serverTimeMs).toISOString()`.

**(b) The fast-path guard and all other `now` reads use a Redis-anchored, periodically-refreshed
in-memory offset.**

```ts
// apps/api/src/infra/clock.service.ts  [SLICE A]
export interface Clock {
  nowMs(): number;                 // Date.now() + offsetMs
  offsetMs(): number;
  rttMs(): number;                 // RTT of the sample the current offset came from
  ageMs(): number;                 // ms since the last successful sync
  isFresh(): boolean;              // ageMs() <= CLOCK_MAX_STALENESS_MS
}
```

### 5.2 How the offset is learned (Cristian's algorithm / SNTP best-sample)

On each sync tick the `RedisAnchoredClock` performs **one** `SaleRedisStore.status(SALE_ID)` call
— which returns Redis's own `TIME` as `serverTimeMs` — and measures it:

```
t0    = Date.now()
snap  = await store.status(SALE_ID)      // status.lua: redis.call('TIME')
t1    = Date.now()
rtt   = t1 - t0
offset = snap.serverTimeMs - (t0 + rtt / 2)
```

- **Sample selection: keep the sample with the LOWEST `rtt` of the last 5**, not an average. A
  single slow sample (GC pause, a noisy neighbour) skews a mean badly; the minimum-RTT sample is
  the one whose midpoint estimate is tightest. This is exactly why NTP does it.
- **Interval:** `CLOCK_SYNC_INTERVAL_MS` (5000). Timer is `.unref()`'d so it never holds the
  process open.
- **Bootstrap:** `main.ts` awaits **one successful sync before `app.listen(...)`**. If the first
  sync fails, retry with backoff (100/200/400/800ms, then every 1s) for up to 10s; after that the
  process **starts anyway** with `offsetMs = 0` and `isFresh() === false`. Refusing to boot when
  Redis is briefly unavailable would turn a Redis blip into a fleet-wide deploy failure; the
  readiness probe (§9) keeps the pod out of the load balancer until the sync lands.
- **Zero extra cost:** this call is the same one that populates `SaleSnapshotCache` (§5.4). The
  clock and the guard's window come from one round trip every 5 seconds, per pod.

### 5.3 Staleness and failure behavior

`isFresh()` is `ageMs() <= CLOCK_MAX_STALENESS_MS` (15000 = 3 missed ticks).

| Condition | `nowMs()` | Fast-path guard | Readiness |
|---|---|---|---|
| Fresh | `Date.now() + offset` | **enabled** (subject to §5.5) | ok |
| Stale (`ageMs > 15000`) | `Date.now() + lastKnownOffset` — best available, still better than raw local | **DISABLED — every purchase goes straight to Lua** | **503 degraded** |
| Never synced | `Date.now()` (offset 0) | **DISABLED** | **503 degraded** |

**Disabling the guard when the clock is untrustworthy is the whole point.** The guard exists only
to save a Redis round trip; the cost of losing it is one round trip we were about to make anyway.
The cost of keeping a stale guard is rejecting purchases Redis would confirm. A guard that cannot
be trusted is deleted from the path, never trusted anyway.

### 5.4 `SaleSnapshotCache` [SLICE A]

Holds the last successful `SaleSnapshot` and its `receivedAtMs`, written by the same sync tick.
Exposes `get(): { snapshot: SaleSnapshot; ageMs: number } | null`. Consumers:

- `PurchaseService`'s fast-path guard reads `startsAtMs` / `endsAtMs` from it. **Never**
  `stockRemaining` — a cached stock value is exactly how you oversell, and stock is Lua's business.
- `HealthService` reads `initialized`.
- **`SaleController` does NOT read it** — `GET /api/sale/status` performs a live `store.status()`
  call per request (§6.2).

The guard's window comes from Redis config, **not** from `SALE_STARTS_AT`/`SALE_ENDS_AT` env: env
is the *seed* input, Redis is the running truth, and a pod restarted with a changed env must not
guard against a window the sale is not actually running on.

### 5.5 The guard's asymmetric skew margin — why a false negative is structurally impossible

`PurchaseService`'s guard rejects **only** when the request is outside the window by more than the
margin:

```
skew = max(CLOCK_GUARD_SKEW_MS, 4 * clock.rttMs())        // default floor 250ms
now  = clock.nowMs()
if (guardEnabled && now < startsAtMs - skew) -> 403 SALE_NOT_STARTED   (no Redis call)
if (guardEnabled && now >= endsAtMs + skew)  -> 403 SALE_ENDED         (no Redis call)
otherwise                                    -> call purchase.lua
```

`guardEnabled` = `clock.isFresh() && cache.get() !== null && cache.get().snapshot.initialized &&
cache.get().ageMs <= CLOCK_MAX_STALENESS_MS`.

Two properties, both required:

1. **Inside the margin the guard never speaks.** The entire boundary neighbourhood — the only place
   a clock error could produce a wrong answer — is unconditionally delegated to `purchase.lua`. A
   false negative therefore requires >250ms of unexplained drift accumulated *within a 5s refresh
   window*, i.e. a clock stepping at >5%. That is a broken machine, and the readiness probe's
   `clock.offsetMs` field is where an operator sees it.
2. **The guard can only ever be a false *positive* about being closed in the far field**, where
   being closed is not in dispute. It never lets a request through that Lua would reject — it
   cannot, because it only ever *rejects*; it never confirms anything.

The guard is a **pure optimization with a proof of harmlessness**, which is the only kind of
optimization allowed near an invariant.

### 5.6 Alternatives weighed and rejected

| Alternative | Rejected because |
|---|---|
| **Local process clock (`Date.now()`)** | This is Phase 1 open issue 2 verbatim. N pods, N clocks, no bound on skew; a 30s-fast VM silently 403s every purchase in the last 30s of the sale, and the SPA's countdown ends early for every user on that pod. |
| **`redis.call('TIME')` per request, before the purchase** | Doubles hot-path round trips (2 RTT instead of 1) to save… a round trip. Self-defeating: the guard's only purpose is to avoid a Redis call, and this makes one. At 2k rps it also doubles Redis command load on the single-threaded server that all four invariants depend on. |
| **Read `serverTimeMs` from `purchase.lua`'s reply and use it as the clock** | Correct for `serverTime` (and that *is* what §5.1(a) does), but useless for the guard: you only have it *after* the call the guard was meant to avoid. |
| **`chrony`/NTP on the host, trust the local clock** | Not verifiable from inside the app, not present in the Docker Compose deliverable, and it makes correctness depend on undocumented host configuration. The whole point of anchoring on Redis is that Redis is the process that actually judges I3 — matching *its* clock is what matters, not matching UTC. |
| **Refresh every 500ms instead of 5s** | 10× the Redis load per pod for a margin improvement of ~0, since the margin is dominated by the 250ms floor, not the refresh interval. |

---

## 6. Endpoint contracts — FROZEN

Base prefix `api` (Phase 0 `API_GLOBAL_PREFIX`). **No route anywhere accepts a `saleId`** — the
sale is always `env.SALE_ID`. This is deliberate: a client-supplied `saleId` is a Redis
key-namespace injection surface and there is exactly one sale (PRD §1.2).

All DTOs come from `@flash/shared/schemas`. **No slice redefines a DTO.** No slice adds a Zod
schema for a shape that already exists there.

### 6.1 `GET /api/sale/status` [SLICE B]

- Request: no body, no params, no query.
- **200** → `saleStatusResponseSchema` (frozen). `serverTimeMs` = `snapshot.serverTimeMs`.
- **503** → `ApiErrorResponse` with `error: 'NOT_INITIALIZED'` (see §6.2).
- **429** → `ApiErrorResponse` with `error: 'RATE_LIMITED'` (per-IP limiter only).
- Implementation: `await store.status(env.SALE_ID)` **per request** — live, not cached.
  - *Alternative rejected:* a 250ms micro-cache. At 2k rps it would cut Redis reads 500×, but a
    stale `stockRemaining` shows the SPA units that no longer exist, and "sold out" is the one
    number users act on. Freshness wins. **Pinned remediation if Phase 5 shows `/sale/status` is
    the bottleneck:** add a ≤250ms cache *for the config fields only*, keeping `stockRemaining`
    and `serverTimeMs` live. That is additive, not a redesign.

### 6.2 RESOLUTION of Phase 1 open issue 3 — the `stockRemaining = -1` sentinel — FROZEN

`status.lua` returns `stock = tonumber(GET stock or '-1')`. So when the **config hash exists but
the stock key does not** — precisely the partial-AOF-replay case that Phase 1's finding 2
identified — `SaleRedisStore.status()` returns `initialized: true, stockRemaining: -1`, and
`deriveSaleState` (which clamps negatives to 0) reads it as `sold_out`. That contradicts
`saleStatusResponseSchema`'s `.nonnegative()` constraint.

**Pinned handling in `SaleService`:**

```
snapshot = await store.status(env.SALE_ID)

if (!snapshot.initialized || snapshot.stockRemaining < 0) -> 503 ApiErrorResponse
                                                             { error: 'NOT_INITIALIZED', ... }
else                                                      -> 200 saleStatusResponseSchema
```

The two branches must be written as the single condition above, not as two separate `if`s, so it
is impossible to fix one and forget the other.

**Why 503 `NOT_INITIALIZED` and not the alternatives:**

| Option | Rejected because |
|---|---|
| Clamp to `0` and return 200 `sold_out` | It **lies**. The SPA renders "SOLD OUT", every buyer leaves, and the ops panel shows a healthy sale — while the truth is that Redis lost the stock key and the sale is unserviceable. A data-loss incident rendered as a business outcome is the worst possible failure mode here. |
| Pass `-1` through | Violates the frozen response schema (`.nonnegative()`); the SPA's stock meter would render a negative bar; Phase 4's `schema.parse(body)` would throw at the client. |
| Return 500 | 500 says "the API is broken". The API is fine — its *dependency* is in an unservable state, and this is transient and recoverable by Phase 3's reconciliation. 503 with `Retry-After: 1` is the honest code, and it matches `purchase.lua`'s own fail-closed answer for the same physical condition (`NOT_INITIALIZED`, `stockRemaining -1`, HTTP 503 in the frozen taxonomy). |

**Additionally required, all three:**
1. Log at **`error`**, event `sale.stock_key_missing`, fields `{ saleId, configPresent: true }`.
   `initialized: false` logs at **`warn`**, event `sale.not_initialized`. Two distinct events —
   the first is data loss, the second is "nobody seeded yet".
2. `GET /api/health/ready` returns **503** while this condition holds (§9.3).
3. `POST /api/purchase` needs no special handling: `purchase.lua` independently returns
   `NOT_INITIALIZED` → 503 via the frozen taxonomy, with no code in `apps/api` deciding anything.

### 6.3 `GET /api/sale/metrics` [SLICE B]

PRD §5.1's ops panel and §10's "attempt-outcome counters exposed on ops endpoint".

- **200** → `{ saleId: string, metrics: Record<string, number>, serverTime, serverTimeMs }`, where
  `metrics` has one key per `SALE_METRIC_FIELDS` entry, **defaulting absent fields to `0`** (the
  hash starts empty; the SPA must not have to handle `undefined`). `serverTimeMs` = `clock.nowMs()`.
- Read-only, `store.readMetrics()` (HGETALL over ≤7 fields). Per-IP rate limited like everything else.
- **`SaleRedisStore.reset()` MUST NOT be reachable from any route in any phase.** Restated from
  Phase 1 §5.2. A reviewer greps for `reset(` under `apps/api/src/**`; the only legal hits are zero.

### 6.4 `POST /api/purchase` [SLICE C]

- Request: `Content-Type: application/json` **only**, body `purchaseRequestSchema` (`.strict()` —
  unknown keys are a 422, not silently dropped).
- **Every** outcome — success and failure alike — responds with the frozen
  `purchaseResponseSchema` envelope. The SPA branches on `status`, never on the HTTP class.

| Outcome | HTTP | `stockRemaining` | `serverTimeMs` |
|---|---|---|---|
| `CONFIRMED` | 201 | Lua's post-decision value (≥ 0) | Lua's `TIME` |
| `ALREADY_PURCHASED` | 409 | Lua's value | Lua's `TIME` |
| `SOLD_OUT` | 410 | `0` | Lua's `TIME` |
| `SALE_NOT_STARTED` | 403 | Lua's value, or `null` if the fast-path guard answered | Lua's `TIME`, or `clock.nowMs()` if guarded |
| `SALE_ENDED` | 403 | Lua's value, or `null` if the fast-path guard answered | Lua's `TIME`, or `clock.nowMs()` if guarded |
| `NOT_INITIALIZED` | 503 | `null` (Lua returns `-1`; the API maps it to `null`, never `-1`) | Lua's `TIME` |
| `INVALID_USER_ID` | 422 | `null` | `clock.nowMs()` |
| `RATE_LIMITED` | 429 | `null` | `clock.nowMs()` |
| `UPSTREAM_UNAVAILABLE` | 503 | `null` | `clock.nowMs()` |

HTTP codes are read from `PURCHASE_OUTCOME_HTTP_STATUS` (`@flash/shared`) — **never** hard-coded as
integer literals in a controller. `userId` in the response echoes the **trimmed, validated** value
(the same string that reached `SADD`), or the raw-but-truncated input on 422 (§10.3). `saleId` is
always `env.SALE_ID`. `message` comes from `messageFor(...)` and the frozen table in §16.1.

`503` responses set `Retry-After: 1`. `429` responses set the headers in §7.5.

### 6.5 `GET /api/purchase/:userId` [SLICE C]

- Param validated by `purchaseStatusParamsSchema` via `ZodValidationPipe` → 422 on failure.
- **200** → `purchaseStatusResponseSchema`. Semantics in §8.2.
- **422 / 429 / 503** → `ApiErrorResponse`.

### 6.6 `ApiErrorResponse` — the non-purchase envelope [SLICE A]

`apps/api/src/common/dto/api-error.ts`:

```ts
export interface ApiErrorResponse {
  error: AttemptOutcome | 'NOT_FOUND' | 'INTERNAL';   // AttemptOutcome from @flash/shared
  message: string;                                     // from common/messages.ts — never raw
  requestId: string;
  serverTime: string;                                  // ISO
  serverTimeMs: number;
}
```

It lives in `apps/api`, **not** in `@flash/shared`, because `@flash/shared` is frozen (§0.1) and
this is an HTTP-layer concern. Phase 4 may lift it into `@flash/shared` via its own amendment.

### 6.7 Zod ↔ Nest integration, and 422-not-400 — FROZEN

Three mechanisms, no others:

1. **`ZodValidationPipe`** [SLICE A] — `implements PipeTransform`, constructed with a schema:
   `@Body(new ZodValidationPipe(purchaseRequestSchema))`. On `safeParse` failure it throws
   `new UnprocessableEntityException({ outcome: 'INVALID_USER_ID', issues })` — **422**, because
   the body was syntactically valid JSON that failed semantic validation, which is exactly RFC 4918
   §11.2 / the PRD §4 contract (`422 invalid id`). Nest's built-in `ValidationPipe` is **not used
   at all** (it is class-validator-based and defaults to 400; we already have Zod schemas as the
   single source of truth).
2. **`HttpExceptionFilter`** [SLICE A], registered as the single global `APP_FILTER`. It catches
   **everything** and is the only place a response body is shaped for an error. Mapping:

   | Caught | Rendered |
   |---|---|
   | `UnprocessableEntityException` with `outcome: 'INVALID_USER_ID'`, on `POST /api/purchase` | 422, `purchaseResponseSchema` envelope, `status: 'INVALID_USER_ID'` |
   | same, on any other route | 422, `ApiErrorResponse`, `error: 'INVALID_USER_ID'` |
   | Fastify `FST_ERR_CTP_INVALID_MEDIA_TYPE`, `FST_ERR_CTP_EMPTY_JSON_BODY`, `FST_ERR_CTP_BODY_TOO_LARGE`, or a JSON `SyntaxError` from the body parser | **422** `INVALID_USER_ID` (see below) |
   | `NotFoundException` (unmatched route) | 404, `ApiErrorResponse`, `error: 'NOT_FOUND'` |
   | anything else (including a thrown ioredis/pg error) | **500**, `ApiErrorResponse`, `error: 'INTERNAL'`, message `'Internal error'` — **the original error is logged at `error` with its stack and NEVER placed in the response** (§10.3) |

   Nest's default error body (`{ statusCode, message, error }`) must never reach a client. A spec
   asserts this by hitting an unknown route and asserting the exact key set.
3. **`@fastify/platform` body limit** — the adapter is constructed with
   `bodyLimit: env.REQUEST_BODY_LIMIT_BYTES` (16384). A larger body is rejected by Fastify before
   Nest sees it, and the resulting `FST_ERR_CTP_BODY_TOO_LARGE` is caught by the filter above.

**Why body-too-large is 422 and not 413.** The frozen `PURCHASE_OUTCOME_HTTP_STATUS` map is total
over `AttemptOutcome`, and the SPA branches on the envelope's `status`. Introducing a 413 the SPA
has no case for buys nothing; a 16KB body for a `{ userId }` payload is *malformed input*, not a
legitimate large upload. One envelope, one vocabulary. (This is the only place Phase 2 declines to
use the "obvious" HTTP code, and it is a conscious choice, recorded here for the reviewer.)

---

## 7. Rate limiting — FROZEN

PRD §10 requires **per-IP and per-user** limits. These are two different controls with two
different purposes and they are implemented by two different mechanisms.

### 7.1 Store: Redis, not in-memory — and why

`@fastify/rate-limit`'s default store is an in-process LRU. PRD §10 states the API is stateless and
horizontally scalable; an in-memory limiter is therefore **per-pod**, so with N pods the real
global limit is N × the configured limit and an attacker spraying across a load balancer sees
N× the budget. It is also unstable: the effective limit changes on every scale event.

**Pinned:** `@fastify/rate-limit` is configured with `redis: <REDIS_LIMIT_CLIENT>`, giving one
shared, cluster-wide counter. The per-user limiter uses the same client.

*Alternative rejected:* in-memory, on the argument that "one pod is all we run locally." Rejected
because the README must defend a horizontally-scalable design to an interviewer, and a limiter
whose semantics change with replica count is not one.

### 7.2 The two limits

| Limiter | Scope | Key | Max | Window | Mechanism |
|---|---|---|---|---|---|
| **Per-IP** | **every** `/api/*` route, including unmatched routes and unparseable bodies | `rl:ip:{ip}` | `RATE_LIMIT_MAX` = **20** | `RATE_LIMIT_WINDOW_MS` = **1000** | `@fastify/rate-limit`, global, `onRequest` hook |
| **Per-user** | `POST /api/purchase` **only** | `rl:u:{saleId}:{ip}:{userId}` | `RATE_LIMIT_USER_MAX` = **5** | `RATE_LIMIT_USER_WINDOW_MS` = **1000** | `PerUserRateLimitGuard` (§7.3) |

Rationale for the numbers: a legitimate SPA polls `/sale/status` every 2s (1s near start) and
posts at most a handful of purchase attempts — 20 req/s/IP is ~10× headroom while still stopping a
single-host flood. 5 purchases/s/user tolerates a double-click and a retry while directly
defeating PRD §6.2's `duplicate-storm` scenario (5k users × 10 concurrent retries).

> **ERRATUM — corrected 2026-07-22 (Phase 2 review, major/security).** The per-user key
> originally read `rl:u:{saleId}:{userId}`, keyed on `userId` ALONE. Because `userId` is
> client-asserted with no authentication anywhere in this system (PRD scope — see `README.md`'s
> "Accepted risks"), that key format let any third party spend a *victim's* budget: spam a
> victim's `userId` from a different IP for one second and the victim's own genuine attempts
> 429 for the rest of that window, at zero cost beyond the attacker's own per-IP allowance. The
> key now folds in the caller's own source IP (`request.ip`, the same `TRUST_PROXY`-aware value
> §7.7's per-IP limiter uses), so an attacker impersonating a victim's `userId` burns down a
> bucket unique to *(attacker IP, victim userId)* — a different key from the one the victim's own
> traffic increments. PRD §6.2's duplicate-storm scenario is unaffected: those retries still
> originate from one real user's one client, i.e. one `(ip, userId)` pair, and are bounded exactly
> as before. See `apps/api/src/common/per-user-rate-limit.guard.ts`'s `buildUserRateLimitKey` doc
> comment and its regression test in `per-user-rate-limit.guard.spec.ts` for the full writeup and
> proof. The frozen prefix (`rl:u:`, §7.4.4) is unchanged.

**Why two mechanisms and not two plugin registrations.** The per-IP limit must run **before the
body exists** (it must protect unparseable and oversized bodies too), so it cannot be keyed on
`userId`. The per-user limit is meaningless before a `userId` exists. They run at different points
in the request lifecycle; forcing both into one plugin would mean keying one of them wrong.

### 7.3 `PerUserRateLimitGuard` — key derivation before validation completes [SLICE A]

Nest guards run **after** Fastify has parsed the body into `req.body` and **before** pipes. The
guard therefore sees an unvalidated `req.body`. Exact algorithm:

```
raw = (req.body && typeof req.body === 'object') ? req.body.userId : undefined

// 1. No usable identity -> DO NOT rate limit per-user. Return true.
//    Per-IP already covered this request; the ZodValidationPipe will 422 it a microsecond later.
if (typeof raw !== 'string') return true

// 2. Cheap pre-filter, using @flash/shared's EXPORTED constants — never a re-declared regex.
candidate = raw.trim()
if (candidate.length < USER_ID_MIN_LENGTH ||
    candidate.length > USER_ID_MAX_LENGTH ||
    !USER_ID_PATTERN.test(candidate)) return true      // pipe will 422 it

// 3. Fixed-window counter on REDIS_LIMIT_CLIENT, one pipelined round trip:
//      INCR   rl:u:{saleId}:{req.ip}:{candidate}       (ERRATUM — see §7.2's box)
//      PEXPIRE rl:u:{saleId}:{req.ip}:{candidate} <window> NX
//    (PEXPIRE ... NX so a burst cannot keep extending the window — that turns a
//     fixed window into an unbounded ban, which is a different, wrong behaviour.
//     If the PEXPIRE reply itself errors independently of the INCR reply — a real
//     possibility under REDIS_LIMIT_CLIENT's tight commandTimeout — a best-effort,
//     non-fatal compensating PEXPIRE...NX is issued on its own round trip so the
//     key never survives with no TTL at all; see §7.4 bound 2's erratum box.)
if (count > RATE_LIMIT_USER_MAX) throw RateLimitedException   // -> 429, §7.5
return true
```

Steps 1 and 2 use the **identical** constants the schema uses (`USER_ID_MIN_LENGTH`,
`USER_ID_MAX_LENGTH`, `USER_ID_PATTERN` from `@flash/shared`), so the guard's notion of "plausible
userId" can never drift from the validator's. Re-declaring the regex here is a slice failure.

**Unparseable body.** Fastify rejects it before the guard ever runs; the request is per-IP limited
and answered 422 by the filter (§6.7). The per-user limiter is never consulted and never mints a
key. This is correct: there is no user to limit.

### 7.4 Key cardinality — the limiter must not be its own DoS amplifier

An attacker-controlled key space in a limiter is a memory-exhaustion vector. Four independent
bounds, all required:

1. **Keys only exist for schema-plausible userIds** (§7.3 step 2). A 10MB junk string never becomes
   a Redis key; it is rejected at length 65 by a string comparison, before any I/O.
2. **Every key carries a TTL equal to its window** (1000ms), set with `PEXPIRE ... NX`. The
   steady-state working set is *distinct actors per second*, not *distinct actors ever*.
   `@fastify/rate-limit`'s Redis store does the same for the IP keys.

   > **ERRATUM — corrected 2026-07-22 (Phase 2 review, major/security).** The original
   > `incrementAndBound` implementation read only the pipelined `INCR` reply and never inspected
   > the `PEXPIRE` reply — `pipeline.exec()` resolving does not mean every command inside it
   > succeeded independently; a per-command error surfaces only in that command's own reply tuple.
   > Under `REDIS_LIMIT_CLIENT`'s deliberately tight `commandTimeout: 250` / `maxRetriesPerRequest:
   > 1` (§4.2), `INCR` landing while `PEXPIRE` independently times out is a realistic split
   > outcome, and it silently left the key with **no TTL at all** — this bound did not actually
   > hold. Fixed: the guard now inspects the `PEXPIRE` reply and, on error or a missing entry,
   > issues one best-effort compensating `PEXPIRE ... NX` on its own round trip (never fatal — a
   > failure there still returns the correct count and never turns a limiter hiccup into a 500).
   > Proven with a real-Redis integration assertion (`rate-limit.integration.spec.ts`, "every
   > rl:u:* key created by a valid purchase has a positive PTTL") and a unit regression reproducing
   > the split-reply failure directly.
3. **The per-IP limiter runs first and bounds per-user key creation.** A single source IP can mint
   at most `RATE_LIMIT_MAX` = 20 new per-user keys per second, because request 21 is 429'd in the
   `onRequest` hook before the body is parsed and before the guard runs. Distributed attackers can
   exceed this, but then the bound is their botnet size, and (2) caps the resident set at one
   second's worth regardless.
4. **Namespaced prefixes** `rl:ip:` and `rl:u:` so an operator can measure and, if ever needed,
   evict the limiter keyspace without touching `sale:{...}:*`. Rate-limit keys deliberately carry
   **no** `{hash tag}` — they must spread across cluster slots, unlike sale keys which must
   co-locate.

Worst realistic case at PRD §6.2's `surge.js` (50k unique users, 2k rps): ≤2k live per-user keys of
~64 bytes ⇒ well under 1MB resident. Bounded, measurable, and stated.

### 7.5 The 429 response — exact shape

Headers on every 429 (both limiters):

```
retry-after: <ceil(msRemaining / 1000)>          # seconds, integer, minimum 1
x-ratelimit-limit: <max>
x-ratelimit-remaining: 0
x-ratelimit-reset: <ceil(msRemaining / 1000)>
```

Body:

- On `POST /api/purchase`: the frozen `purchaseResponseSchema` envelope with
  `status: 'RATE_LIMITED'`, `stockRemaining: null`, `serverTimeMs: clock.nowMs()`,
  `message` from `messageFor('RATE_LIMITED')` and the frozen table in §16.1.
- On any other route: `ApiErrorResponse` with `error: 'RATE_LIMITED'`.

`@fastify/rate-limit` is configured with a custom `errorResponseBuilder` producing the
`ApiErrorResponse` shape, and `addHeadersOnExceeding: { 'x-ratelimit-remaining': true }` so a
client can see it approaching the limit. Non-429 responses also carry `x-ratelimit-remaining` —
§11.3 uses this to *prove* the limiter was in the request path during the concurrency spec.

### 7.6 Failure behavior — fail open, deliberately

`skipOnError: true` on the plugin, and the guard swallows Redis errors and returns `true`, logging
`warn` with event `ratelimit.store_unavailable`.

**Justification, for the security reviewer:** the rate limiter is a *stability* control, not a
*correctness* control. I1–I4 are enforced by `purchase.lua` and the Postgres unique index, neither
of which the limiter participates in. If the limiter's Redis store is unreachable, then the hot
path's Redis is almost certainly also unreachable and every purchase is already 503'ing on its own
merits. Failing *closed* would convert a limiter-store hiccup into a total outage of a system whose
invariants are still perfectly safe. This is a decision, not an oversight; it is stated here so it
is reviewed rather than discovered.

### 7.7 Client IP derivation — `TRUST_PROXY` defaults to **false**

`X-Forwarded-For` is attacker-controlled. If Fastify's `trustProxy` were on by default, any client
could rotate the header and bypass the per-IP limiter entirely with a one-line change. The adapter
is constructed with `trustProxy: env.TRUST_PROXY` (default `false`), so `req.ip` is the real socket
address unless an operator has explicitly declared there is a trusted proxy in front. A spec asserts
that a forged `X-Forwarded-For` does **not** create a new bucket under the default config (§11.6).

---

## 8. The purchase flow — FROZEN

### 8.1 `POST /api/purchase`, step by step

Guard order is normative. Cheapest and most protective first; nothing expensive runs for a request
that a cheap check would have rejected.

| # | Step | Layer | Failure |
|---|---|---|---|
| 1 | Per-IP rate limit | Fastify `onRequest` (plugin) | 429 |
| 2 | Content-type + body parse + `bodyLimit` | Fastify content-type parser | 422 (§6.7) |
| 3 | Per-user rate limit | Nest guard (§7.3) | 429 |
| 4 | `ZodValidationPipe(purchaseRequestSchema)` | Nest pipe | 422 |
| 5 | **Fast-path window guard** (§5.5) | `PurchaseService` | 403 `SALE_NOT_STARTED` / `SALE_ENDED`, **no Redis call** |
| 6 | `store.purchase(env.SALE_ID, userId)` | `@flash/redis` → `purchase.lua` | throw → 503 `UPSTREAM_UNAVAILABLE` |
| 7 | **if `CONFIRMED`: `await ordersQueue.enqueue(...)`** | `OrdersQueueService` | §8.3 — response is still 201 |
| 8 | `void store.bumpMetric(saleId, outcome)` — fire-and-forget, never awaited, never throws | `@flash/redis` | ignored |
| 9 | Respond with `PURCHASE_OUTCOME_HTTP_STATUS[outcome]` and the §6.4 envelope | controller | — |

**Step 6 is the invariant.** `PurchaseService` **must never catch a Redis error and synthesize a
business outcome.** Phase 1 `sale-store.ts` states this at the store level; it is restated here at
the service level because this is where the temptation lives. A `catch` that returns `SOLD_OUT` on
an ioredis timeout would be an oversell waiting to happen (the request may well have executed
server-side) *and* would hide an outage as a business answer. The only legal mapping is
`ioredis error → UPSTREAM_UNAVAILABLE → 503`.

**Step 7 happens BEFORE the response is written, and is awaited.** Rejected alternative: respond
201 first, enqueue after. That inverts the failure into the worst shape — the user has been told
"confirmed", and a pod crash in the gap leaves a reservation nobody knows about, with the client
already gone. Awaiting first means the *only* window is the one Lua itself creates, which §8.4
handles.

### 8.2 `GET /api/purchase/:userId` — Postgres **and** Redis [SLICE C]

**Source: both, with a pinned precedence.** Postgres is the durable record and is the only place
that knows `createdAt`; Redis covers the window in which a reservation exists but the async write
has not landed.

```
row = SELECT status, created_at FROM orders WHERE user_id = $1        -- uses orders_user_id_uniq
if (row exists):
    purchased = (row.status === 'persisted')                          -- 'compensated' => false
    order     = { status: row.status, createdAt: row.created_at.toISOString() }
else:
    inRedis = await store.hasPurchased(env.SALE_ID, userId)           -- SISMEMBER, O(1)
    purchased = inRedis
    order     = inRedis ? { status: 'reserved', createdAt: null } : null
```

**Semantics of `reserved` vs `persisted` vs `compensated`:**

- **`reserved`** — Redis has committed the reservation (the buyer is in the set and the
  reservations ledger); the BullMQ job has not been drained into Postgres yet. The user *holds the
  item*. `createdAt` is `null` — the frozen DTO allows exactly this, which is why it is nullable.
- **`persisted`** — the durable row exists. This is the terminal happy state.
- **`compensated`** — Phase 3's DLQ returned the stock and removed the buyer. `purchased` is
  **`false`**: the user does not hold an item, and saying otherwise would be the single most
  misleading thing this endpoint could do. The `order` object is still returned so the SPA can
  explain *why*.

**Why Postgres is allowed here.** PRD §3's rule is "the API never touches Postgres **on the
purchase hot path**." This is a different route, called at human frequency (the SPA's "check my
purchase" action), served by a single unique-index lookup with a 2s `statement_timeout`, on a pool
of 10. `POST /api/purchase` opens no PG connection at any point — a reviewer greps `PG_POOL` under
`apps/api/src/purchase/purchase.service.ts` and finds zero hits.

**Degradation:**
- **Postgres unreachable** → do **not** 503. Fall through to the Redis branch and answer
  `reserved` / `false`. Log `warn`, event `purchase_status.pg_unavailable`. Redis is authoritative
  for "did I get one"; refusing to answer when we *can* answer is a worse outcome.
- **Redis unreachable** (and no PG row) → **503 `UPSTREAM_UNAVAILABLE`**. We genuinely do not know.
- Both unreachable → 503.

*Alternative rejected — Redis-only:* it cannot produce `createdAt`, cannot distinguish
`persisted` from `reserved` (which is the entire point of the endpoint per PRD §4), and cannot
report `compensated` at all, since compensation removes the user from the buyers set.
*Alternative rejected — Postgres-only:* it returns `purchased: false` for every user in the
reserved-but-not-yet-drained window, i.e. it tells a user who just got a 201 that they have
nothing. Under surge that window is exactly when everyone checks.

### 8.3 `OrdersQueueService` — producer only [SLICE C]

```ts
// Amendment A3 (§17) corrects Phase 0 §16's unexecutable `:` delimiter.
jobId = buildOrdersJobId(saleId, userId) // exactly `${saleId}-${userId}`
jobName = 'persist-order'
payload = { saleId, userId, reservationId, reservedAtMs, requestId }
opts = {
  jobId,
  attempts: 5,                                    // WORKER_MAX_ATTEMPTS; Phase 3 consumes
  backoff: { type: 'exponential', delay: 200 },
  removeOnComplete: { count: 1000 },
  removeOnFail: false,                            // the DLQ IS the failed set — never auto-remove
}
```

`Queue` is constructed with `{ connection: REDIS_QUEUE_CLIENT, prefix: 'bull' }` (Phase 0 §16
freezes the prefix as the literal `bull`) and queue name `env.ORDERS_QUEUE_NAME`.
`reservationId` and `reservedAtMs` come from `PurchaseResult` — Phase 3's compensation is keyed on
`reservationId` (Phase 1 finding 1), so **dropping it from the payload would silently reintroduce
that critical**. `OrdersQueueService.depth()` returns
`await queue.getJobCounts('waiting', 'active', 'delayed', 'failed')` for the readiness probe.

Phase 2 defines **no** `Worker`, no `QueueEvents`, no processor. Constructing a `Worker` in
`apps/api` is a slice failure.

### 8.4 Enqueue failure AFTER Lua returned CONFIRMED — the I4 hazard — FROZEN

This is the sharpest edge in Phase 2. Lua has already committed: stock is decremented, the user is
in the buyers set, and the reservations ledger has
`userId -> "{reservationId}:{reservedAtMs}"`. That write is **not** undoable by the API.

**Pinned behavior, in order:**

1. `enqueue` is awaited with a **`ENQUEUE_TIMEOUT_MS` (500ms)** race. On rejection or timeout,
   **retry exactly once, immediately**, with the identical `jobId`. BullMQ's `jobId` makes the
   retry idempotent — if the first attempt actually landed and only the acknowledgement was lost,
   the second is a no-op. One retry, not a loop: an unbounded retry here converts a queue outage
   into a request-handler pile-up, which is how you lose the whole API instead of one job.
2. If both attempts fail, the API **returns 201 `CONFIRMED` anyway.**
   - **Not 503.** The reservation is real. Telling the user "failed" would be a lie that I2 then
     enforces against them: their retry returns 409 `ALREADY_PURCHASED` and they can never buy the
     item they actually hold. That is the worst user-visible outcome available.
   - **The API does not compensate.** Compensation is `compensate.lua`'s job, keyed on reservation
     identity, driven by Phase 3's DLQ after the worker has genuinely, permanently failed to
     persist. An API-side compensation on an enqueue timeout would fire on the *likely* case that
     the job actually landed, tearing down a live reservation and inflating stock — precisely the
     I1/I2 violation Phase 1's finding 1 was about.
3. Log at **`error`**, event `purchase.enqueue_failed`, fields
   `{ saleId, userId, reservationId, reservedAtMs, requestId, attempts: 2, err: err.message }`.
   This log line is the operator's paper trail and must contain `reservationId` — it is what a
   manual reconciliation would be keyed on.
4. **The recovery mechanism is the reservations ledger, and it already exists.** `purchase.lua`
   wrote it *inside the same atomic step* as the `DECR`/`SADD`, so a confirmed reservation is
   durably recorded in Redis **independently of whether the queue ever heard about it**. Phase 3's
   boot sweep (PRD §3.5's "API pod dies post-Lua, pre-enqueue" row) enumerates it with
   `scanReservations()` (HSCAN, cursor-paged), diffs against Postgres `orders` and the BullMQ
   queue, and re-enqueues anything present in the ledger but absent from both. That single
   mechanism covers this case, the pod-crash case, and the lost-ack case identically — which is
   why Phase 2 must **not** invent a second, parallel recovery path.

**Phase 2's obligations, therefore, are exactly three:** (a) never lose the `reservationId`,
(b) never compensate, (c) log the gap with reconcilable identity. Building the sweep is Phase 3.

**Required spec** (§11.7): with the queue client pointed at a dead Redis (or `queue.add` stubbed to
reject), a purchase in an open window returns **201**, the buyers set contains the user, the
reservations hash contains a matching entry, and stock decremented by exactly 1. That is the I4
precondition made testable in Phase 2 rather than assumed in Phase 3.

---

## 9. Health — FROZEN

### 9.1 Two routes, two questions

| Route | Question | Never | Consumers |
|---|---|---|---|
| `GET /api/health` | **Liveness** — "is this process alive and its event loop responsive?" | never 503 because a *dependency* is down | compose `healthcheck`, orchestrator liveness probe |
| `GET /api/health/ready` | **Readiness** — "should this pod receive traffic right now?" | never 200 while it cannot serve correct purchases | load balancer / readiness probe, ops panel |

Conflating them (PRD §4's single endpoint) means a Redis blip restarts every pod, each restart
reconnects to the same struggling Redis, and the outage is amplified by the thing meant to detect
it. This is the deliberate refinement declared in §0.3.1.

### 9.2 `GET /api/health` — liveness [SLICE D]

- Always **200**. Body is the frozen Phase 0 shape, unchanged and unrenamed:
  `{ status: 'ok', service: 'api', version, uptimeSeconds }`.
- Performs **no** network I/O. No Redis, no Postgres, no queue.
- Excluded from the per-IP rate limiter (`@fastify/rate-limit` `allowList` is not used; instead the
  route sets `config: { rateLimit: false }`) — a probe must not be able to rate-limit itself out of
  existence during a surge.

### 9.3 `GET /api/health/ready` — readiness [SLICE D]

Body (additive; the four frozen keys are preserved):

```jsonc
{
  "status": "ok" | "degraded",
  "service": "api", "version": "0.0.0", "uptimeSeconds": 123.4,
  "checks": {
    "redis":    { "ok": true,  "latencyMs": 1 },
    "postgres": { "ok": true,  "latencyMs": 3 },
    "clock":    { "ok": true,  "offsetMs": -12, "rttMs": 2, "ageMs": 1840 },
    "sale":     { "ok": true,  "initialized": true, "stockKeyPresent": true },
    "queue":    { "ok": true,  "waiting": 0, "active": 0, "delayed": 0, "failed": 0 }
  },
  "requestId": "…", "serverTime": "…", "serverTimeMs": 1234567890123
}
```

**What makes it 503 (`status: 'degraded'`) — exhaustive:**

| Condition | 503? | Why |
|---|---|---|
| `store.ping()` false / throws | **YES** | no Redis ⇒ no purchase can be decided at all |
| `clock.isFresh()` false | **YES** | §5.3 — the pod cannot trust its own `now`; §5 disables the guard, but a pod that has lost contact with Redis's clock has almost certainly lost Redis |
| `snapshot.initialized === false` | **YES** | nothing to sell; serving traffic returns 503s anyway |
| `snapshot.stockRemaining < 0` (the §6.2 sentinel) | **YES** | data loss; this pod must not take traffic until Phase 3 reconciliation runs |
| Postgres ping fails | **no** — reported `ok: false`, status stays `ok` | PRD §3.5 explicitly tolerates a Postgres outage: reservations keep succeeding, the queue buffers. Draining every pod from the LB during an outage the design is built to survive would turn a degraded system into a dead one. |
| `queue.failed > 0` or high depth | **no** — reported | DLQ depth is Phase 3's alerting concern, not a reason to stop accepting purchases |
| Queue Redis unreachable | **no** — `queue.ok: false` | same reasoning as Postgres; see §8.4 — the ledger makes this recoverable |

- Checks run **in parallel** (`Promise.allSettled`) with a **1s** overall budget; a check that has
  not answered by then is reported `ok: false, latencyMs: null` and treated per the table above.
- Rate limited normally (it is a public route).
- `503` sets `Retry-After: 1`.

---

## 10. Security requirements — the spec the security reviewer reviews against

PRD §10: *"schema validation on all inputs, per-IP + per-user rate limits, no secrets in repo,
helmet-equivalent headers, dependency audit in CI."*

### 10.1 Input validation boundaries

1. **Every** untrusted value entering the process is validated by a `@flash/shared` Zod schema
   before use: request body (`purchaseRequestSchema`), route param
   (`purchaseStatusParamsSchema`), and env (§3.2). There are no other untrusted inputs — there are
   no query parameters, no headers that affect behaviour except the request id (§10.4), and no
   client-supplied `saleId` anywhere (§6).
2. `saleId` is **always** `env.SALE_ID`, validated once at boot by `assertSaleId`. This closes the
   Redis key-injection surface completely: no request can influence which keys are touched.
3. `userId` reaching Redis is the **trimmed, schema-parsed output** — never the raw input.
   (Phase 1's `dto/user-id.ts` explains why: `'  bob  '` and `'bob'` must not be distinct set
   members, or I2 falls to whitespace.)
4. `bodyLimit` 16KB; `application/json` only — Fastify's `formbody`/urlencoded parsers are **not**
   registered. `.strict()` on the request schema rejects unknown keys rather than ignoring them.
5. No route accepts a query string; unknown query parameters are ignored, never echoed.

### 10.2 Headers and transport

- `@fastify/helmet` registered globally. `contentSecurityPolicy: false` (this API serves only JSON;
  a CSP on a JSON response is noise) — but `hsts`, `noSniff` (`X-Content-Type-Options: nosniff`),
  `frameguard` (`DENY`), `referrerPolicy: 'no-referrer'`, and
  `crossOriginResourcePolicy: 'same-site'` are **on**.
- `x-powered-by` removed.
- `@fastify/cors` with `origin: env.CORS_ORIGIN` (exact string match, **never** `true`, **never**
  reflect-the-request-origin), `methods: ['GET','POST']`, `credentials: false`,
  `allowedHeaders: ['content-type','x-request-id']`, `exposedHeaders: ['x-request-id','retry-after','x-ratelimit-limit','x-ratelimit-remaining','x-ratelimit-reset']`.
- `trustProxy: env.TRUST_PROXY`, default **false** (§7.7).

### 10.3 Error-message hygiene — no internal detail leakage

- The global `HttpExceptionFilter` is the **only** producer of error bodies. Its `message` values
  come from `messageFor(...)` in `common/messages.ts`, backed by the frozen table in §16.1. A
  raw `Error.message` **never** appears in a response body.
- Specifically never in a response: stack traces, ioredis error text, `pg` error text (which leaks
  table/column names), Lua source or script SHAs, file paths, env values, the Node/Nest/Fastify
  version, or the `issues` array from a Zod `safeParse` (Zod issue paths would echo attacker input
  and enumerate the schema). Zod issues **are** logged at `debug` and dropped from the response.
- On 422 the response's `userId` field echoes the input **truncated to `USER_ID_MAX_LENGTH` and
  with all characters outside `USER_ID_PATTERN` stripped**, so a rejected value can never become a
  reflection vector.
- The 500 branch responds `{ error: 'INTERNAL', message: 'Internal error', requestId, … }` and
  nothing else. The `requestId` is how an operator correlates it to the full logged stack.
- Structured logs **may** contain `userId` — it is the identity I4 reconciliation is keyed on — but
  the raw request body is **never** logged. pino `redact` covers
  `req.headers.authorization`, `req.headers.cookie`, `req.body`.

### 10.4 Request-ID propagation

- `common/request-id.ts` exports `REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/`.
- An inbound `x-request-id` is **accepted only if it matches**; otherwise a fresh `randomUUID()` is
  generated. An unvalidated inbound id is a log-injection and log-cardinality vector.
- `nestjs-pino` is configured with `genReqId` implementing exactly that rule, so **every** log line
  in the request's lifetime carries `reqId`.
- The id is echoed on **every** response as the `x-request-id` header, and appears in the
  `requestId` field of every `ApiErrorResponse`.
- It is carried onto the BullMQ job payload (§8.3), so a Phase 3 worker log can be traced back to
  the HTTP request that created the reservation. This is what makes an I4 gap investigable.

### 10.5 Ops surface

- `SaleRedisStore.reset()` is not reachable from any route (§6.3). Zero occurrences under
  `apps/api/src/**`.
- `GET /api/sale/metrics` exposes only aggregate counters — no userIds, no per-user data.
- **No endpoint BULK-enumerates buyers** — `scanReservations` is not called from `apps/api/src/**`,
  so there is no route that returns "the list of buyers."
- Logging at `LOG_LEVEL` from env; `pino-pretty` only when `NODE_ENV === 'development'` (this is a
  *transport* choice, not a control-flow branch around a guard — it does not violate the §0
  process rule).

> **ERRATUM — corrected 2026-07-22 (Phase 2 review).** The previous wording of the second bullet
> ("No endpoint enumerates buyers") was misleading. There is no *bulk* enumeration route, but the
> system IS a per-candidate buyer-enumeration oracle: `POST /api/purchase` answers `409
> ALREADY_PURCHASED` for a userId that already holds a confirmed order, and `GET
> /api/purchase/:userId` answers `purchased: true/false` directly — both unauthenticated (§10 has
> no auth layer; PRD scopes real auth out entirely). An attacker holding a candidate userId list
> can therefore learn the full buyer set one probe at a time, at the cost of one request per
> candidate (bounded by the per-IP/per-user limiters in §7, which slow but do not prevent this).
> This is the same client-asserted-identity root cause as the entitlement-theft risk recorded in
> `README.md`'s "Accepted risks" section — read that section for the full consequence list and the
> production remediation (real authentication in front of both routes).

---

## 11. Test requirements — FROZEN

### 11.1 Harness

- **Unit** (`apps/api/vitest.config.ts` [A]): `include: ['src/**/*.spec.ts']`. No containers,
  no network. Run by `pnpm test`.
- **Integration** (`apps/api/vitest.integration.config.ts` [E]):
  `include: ['test/integration/**/*.integration.spec.ts']`, `globalSetup: './test/global-setup.ts'`,
  `testTimeout: 120_000`, `hookTimeout: 180_000`, `fileParallelism: false`,
  `pool: 'forks'`, `poolOptions: { forks: { singleFork: true } }`. Run during focused development
  by `pnpm test:integration`; at the phase gate it runs in §12's explicit forced Turbo graph. The
  Turbo task already exists with `cache: false`.
- `global-setup.ts` starts **`redis:7.4-alpine`** and **`postgres:16-alpine`** via Testcontainers
  once for the whole run, applies `infra/postgres/init/001_schema.sql`, and exports
  `REDIS_TEST_URL` / `POSTGRES_TEST_URL`. If `REDIS_TEST_URL` / `POSTGRES_TEST_URL` are already set
  in the environment, it uses those instead of starting containers (CI-service-container path).
- **No spec may skip when a datastore is unavailable.** Inherited Phase 1 rule; an unreachable
  container **fails** the suite.

**HTTP driving — binding.** The integration specs drive a **real listening server**
(`await app.listen(0, '127.0.0.1')`) over real sockets via `undici`
(`new Agent({ connections: 128, pipelining: 0 })`). **`app.inject()` is FORBIDDEN in
`test/integration/**`** — it bypasses the HTTP parser, the connection layer, and `req.ip`
derivation, which is precisely the layer Phase 2 exists to prove. `app.inject()` remains fine for
cheap `src/**/*.spec.ts` controller unit specs.

`test/support/app-harness.ts` boots the app with env overrides supplied per spec and returns
`{ baseUrl, app, store, pool, close() }`. Every spec `reset()`s and re-`seed()`s its sale in
`beforeEach` so specs cannot leak state into each other.

### 11.2 Coverage required per endpoint (non-exhaustive floor — a slice may add more)

| Spec file | Must assert |
|---|---|
| `sale-status.integration.spec.ts` | 200 body **parses against `saleStatusResponseSchema`** (not a hand-written shape check); `serverTimeMs` equals the snapshot's Redis `TIME` within 0ms of the value returned by a same-instant `status()`; **the §6.2 sentinel: `DEL sale:{id}:stock` with config intact ⇒ 503 `NOT_INITIALIZED`, and specifically NOT a 200 with `stockRemaining: 0`**; never-seeded ⇒ 503 |
| `purchase-flow.integration.spec.ts` | 201 `CONFIRMED` (+ `Location`-free envelope parses against `purchaseResponseSchema`); second attempt same user ⇒ 409 `ALREADY_PURCHASED`; stock exhausted ⇒ 410 `SOLD_OUT`; unseeded sale ⇒ 503 `NOT_INITIALIZED` with `stockRemaining: null` (**never `-1`**); `{}`, `{userId: ''}`, `{userId: 'ab'}`, `{userId: 'a'.repeat(65)}`, `{userId: 'bad!char'}`, `{userId: 'ok', extra: 1}` (strict) ⇒ 422; malformed JSON ⇒ 422; `text/plain` ⇒ 422; 17KB body ⇒ 422; **a CONFIRMED purchase produced a BullMQ job with `jobId === buildOrdersJobId(saleId, userId)` (exactly `${saleId}-${userId}` per Amendment A3) carrying a non-empty `reservationId`** |
| `purchase-status.integration.spec.ts` | reserved-only (Redis, no PG row) ⇒ `{purchased: true, order: {status: 'reserved', createdAt: null}}`; PG row `persisted` ⇒ `persisted` with a real `createdAt`; PG row `compensated` ⇒ **`purchased: false`**; unknown user ⇒ `{purchased: false, order: null}`; invalid param ⇒ 422; **PG pool stopped ⇒ still 200 from Redis, not 503** |
| `window-edge.integration.spec.ts` | §11.3 |
| `rate-limit.integration.spec.ts` | §11.6 |
| `clock-skew.integration.spec.ts` | §11.8 |
| `health.integration.spec.ts` | `/api/health` 200 with the frozen four keys and **no** dependency I/O; `/api/health/ready` 200 healthy; Redis container paused ⇒ **503 degraded**; PG pool stopped ⇒ **200 with `checks.postgres.ok === false`**; `DEL` the stock key ⇒ **503** |
| `security.integration.spec.ts` | §11.9 |
| `concurrency.integration.spec.ts` | §11.3 |
| `concurrency-negative-control.integration.spec.ts` | §11.4 |

### 11.3 THE MONEY TEST — PRD §6.1 through HTTP

`concurrency.integration.spec.ts`, and it is the gate.

```
seed:   stock = 10, window OPEN (startsAt = redisNow - 60_000, endsAt = redisNow + 600_000)
fire:   500 concurrent POST /api/purchase, 500 DISTINCT userIds, via Promise.all over undici
        (Agent connections: 128 — genuinely parallel sockets, not serialized)
assert: confirmed        === 10      (status 201, status field 'CONFIRMED')
        soldOut          === 490     (status 410, status field 'SOLD_OUT')
        other outcomes   === 0       (no 429, no 503, no 422, no 403)
        GET sale:{id}:stock          === 0  and never negative                     (I1)
        SCARD sale:{id}:buyers       === 10                                        (I2)
        the 10 confirmed userIds     === exactly the 10 members of the buyers set  (I2)
        distinct confirmed userIds   === 10
        the 10 CONFIRMED stockRemaining values === the distinct set {0,…,9}
        HLEN sale:{id}:reservations  === 10, all reservationIds distinct, non-empty (I4)
        BullMQ waiting+active jobs   === 10,
        jobIds === { buildOrdersJobId(saleId, u) } exactly (I4; Amendment A3)
repeat: the whole scenario 3× in one spec run, resetting between iterations
```

**Rate limiting during this test — the honest approach, pinned.** The 500 requests originate from
one process and therefore one source IP; at the production limit of 20/s the limiter would 429 the
other 480 and the test would prove nothing.

- **FORBIDDEN:** disabling the plugin, skipping the guard, `if (NODE_ENV === 'test')` anywhere in
  `src/**`, or registering the app without the limiter. Any of these is the Phase 0
  deleted-gate failure repeating.
- **PINNED:** the harness boots the app with `RATE_LIMIT_MAX=100000`,
  `RATE_LIMIT_USER_MAX=100000`, windows unchanged. **The plugin is registered, the guard is
  registered, and every one of the 500 requests traverses both** — only the numeric threshold is
  above the test's arrival rate. Configuration, not control flow.
- **PROOF the limiter was actually in the path:** the spec asserts that every response carries an
  `x-ratelimit-limit` header equal to `100000` and that `x-ratelimit-remaining` is present and
  strictly less than `100000` on at least 490 responses. A limiter that had been bypassed emits no
  such headers, so this assertion fails loudly rather than passing silently.
- The limiter's real behaviour at production limits is proven separately by §11.6, at the real
  numbers, with nothing raised. Two specs, two concerns, neither weakened.

### 11.4 THE NEGATIVE CONTROL — required (Phase 1 T2 precedent)

`concurrency-negative-control.integration.spec.ts`.

- `test/support/unsafe-purchase.service.ts` implements the **same** `PurchaseService` interface
  with a deliberately non-atomic decision: `GET stock` → `await setTimeout(0)` (yield) →
  `DECR stock` → `SADD buyers`, four round trips, no Lua, no window check in Redis.
- The spec boots the app through the **identical** harness with
  `.overrideProvider(PurchaseService).useClass(UnsafePurchaseService)` and runs the **identical**
  500-parallel scenario against stock = 10.
- **It asserts the harness DETECTS the violation:** `expect(confirmed).toBeGreaterThan(10)` and
  `expect(finalStock).toBeLessThan(0)`. If the unsafe implementation does **not** oversell, the
  spec **FAILS** — because that would mean §11.3's harness has no discriminating power and its
  green is meaningless.
- `unsafe-purchase.service.ts` lives under `test/support/**` and **must never** be importable from
  `apps/api/src/**`. A grep for `unsafe` under `src/` must return zero hits.

Without this, §11.3 is unfalsifiable, and Phase 1 established that an atomicity test that cannot
fail proves nothing.

### 11.5 Window edges through HTTP — 1ms before start, 1ms after end

Exact-millisecond timing over a real socket is not achievable with a `sleep`, and a spec that tries
is a flake generator. The **pinned, deterministic** technique exploits the fact that both Lua
scripts return *the very clock reading they judged by*:

| Case | Seed (relative to Redis's own clock, read via `status().serverTimeMs`) | Assert |
|---|---|---|
| **1ms before start** | `startsAt = redisNow + 3000`, `endsAt = redisNow + 600000` | 403, `status === 'SALE_NOT_STARTED'`, **and `body.serverTimeMs < startsAtMs`** (the response proves the clock that judged it was inside the "before" region), stock unchanged, `SCARD buyers === 0`, `HLEN reservations === 0` |
| **exactly at start** | `startsAt = redisNow - 1`, `endsAt = redisNow + 600000` | 201, `body.serverTimeMs >= startsAtMs` |
| **1ms after end** | `startsAt = redisNow - 600000`, `endsAt = redisNow + 1` — then poll `GET /api/sale/status` until `serverTimeMs >= endsAtMs`, then POST | 403, `status === 'SALE_ENDED'`, **and `body.serverTimeMs >= endsAtMs`**, stock unchanged, `SCARD buyers === 0` |
| **just before end** | `startsAt = redisNow - 600000`, `endsAt = redisNow + 5000` | 201, `body.serverTimeMs < endsAtMs` |

The assertion is always a **relation between the returned `serverTimeMs` and the window bound**,
which is exact and race-free, rather than a wall-clock hope. **Zero side effects on both 403
branches is a required assertion**, mirroring Phase 1's T6.

Additionally required: the boundary rows of Phase 1 §3.3 (as corrected in §13) are asserted through
`GET /api/sale/status` for at least the `S-1`/`S`/`E-1`/`E` cases with both non-zero and zero stock.

### 11.6 Rate limiting, at production limits

`rate-limit.integration.spec.ts`, booted with the **default** `RATE_LIMIT_MAX=20`,
`RATE_LIMIT_USER_MAX=5`, `RATE_LIMIT_WINDOW_MS=1000`, `TRUST_PROXY=false`:

- 20 sequential `GET /api/sale/status` in one window ⇒ all 200; the 21st ⇒ **429** with
  `retry-after`, `x-ratelimit-limit: 20`, `x-ratelimit-remaining: 0`, and an `ApiErrorResponse`
  body with `error: 'RATE_LIMITED'`.
- After the window elapses, the next request ⇒ 200 (the window resets; it is not a ban).
- 5 `POST /api/purchase` for **one** userId in one window ⇒ the 6th is **429** with the
  **`purchaseResponseSchema` envelope** and `status: 'RATE_LIMITED'`, `stockRemaining: null`.
- **`X-Forwarded-For` forgery does not create a new bucket** under `TRUST_PROXY=false`: exceed the
  per-IP limit, then send 20 more requests each with a distinct forged `X-Forwarded-For` — all
  still 429.
- **Cardinality:** 200 requests with 200 distinct *invalid* userIds (`'!!!'`, 200-char strings)
  create **zero** `rl:u:*` keys — asserted with `SCAN MATCH rl:u:*`. This proves §7.4(1).
- **Fail-open:** with `REDIS_LIMIT_CLIENT` pointed at a dead port, requests still succeed (not 503),
  and a `ratelimit.store_unavailable` log was emitted.
- `GET /api/health` is **never** rate limited, even past the limit.

### 11.7 Enqueue-failure (I4) spec

Per §8.4: with the BullMQ queue unable to accept jobs, a purchase in an open window returns
**201 `CONFIRMED`**; `SCARD buyers === 1`; `HGET reservations {userId}` matches
`^<uuid>:<digits>$` and its uuid equals nothing the API discarded; stock decremented by exactly 1;
and **no compensation occurred** (stock did not bounce back). Also asserts the
`purchase.enqueue_failed` log record contains `reservationId`.

### 11.8 Clock-skew spec — proving the §5 resolution

`clock-skew.integration.spec.ts`, with `.overrideProvider(CLOCK)` supplying a stub:

| Stub | Scenario | Required result |
|---|---|---|
| `nowMs = redisNow + 300_000`, `isFresh() === true` | window open, purchase | **201 CONFIRMED** — a 5-minutes-fast pod must not reject what Lua confirms |
| `nowMs = redisNow - 300_000`, `isFresh() === true` | window open, purchase | **201 CONFIRMED** |
| `nowMs = redisNow + 200` (inside the 250ms margin), window closes in 100ms | purchase | **201** — the guard must not speak inside the margin |
| `isFresh() === false` | window open, purchase | **201**, and the guard is proven disabled |
| `isFresh() === false` | `GET /api/health/ready` | **503 degraded**, `checks.clock.ok === false` |
| real clock, window closed by 10 minutes | purchase | **403 `SALE_ENDED`** with **zero Redis `purchase.lua` invocations** — assert via `INFO commandstats` delta or by pointing `REDIS_STORE_CLIENT` at a dead port and still getting 403 (the latter is the stronger, pinned form) |

The last row is the only proof that the fast path is actually a fast path. The first four are the
proof that Phase 1 open issue 2 is closed.

### 11.9 Security spec

- Unknown route ⇒ 404 with an `ApiErrorResponse` whose key set is **exactly**
  `['error','message','requestId','serverTime','serverTimeMs']` — Nest's default
  `{statusCode,message,error}` must not appear.
- A route forced to throw an internal error ⇒ 500 whose body contains **no** stack, no `'redis'`,
  no `'ECONNREFUSED'`, no file path; the corresponding log line **does** contain the stack.
- 422 body's `userId` echo is truncated/stripped (§10.3): posting a 5000-char userId with `<script>`
  in it returns a `userId` field of at most 64 chars containing none of `<`, `>`, `/`.
- Response headers include `x-content-type-options: nosniff`, `x-frame-options: DENY`,
  `referrer-policy: no-referrer`, and **no** `x-powered-by`.
- Inbound `x-request-id: "../../etc/passwd\n\ninjected"` is **rejected** and replaced with a UUID;
  the echoed `x-request-id` matches `REQUEST_ID_PATTERN`. A valid inbound id **is** echoed verbatim.
- CORS: a request with `Origin: https://evil.example` receives **no**
  `access-control-allow-origin` header.

---

## 12. Definition of done — the Phase 2 gate

Run by the **orchestrator directly**, never by an implementing agent, with caching bypassed.

```bash
pnpm install --frozen-lockfile
pnpm format:check
# Includes real-container integration tests; must end "Cached: 0 cached".
pnpm exec turbo run lint typecheck test build test:integration --force
pnpm audit --audit-level high                              # ignoreGhsas must still be []
node scripts/assert-build-output.mjs apps/api/dist/main.js # hollow-build guard (Phase 0)
```

This is the canonical repo-wide gate from `AGENTS.md` §8 with its five Turbo-backed checks
coalesced into one cache-bypassed graph invocation; no canonical check is removed. In particular,
`test:integration` **must appear in that Turbo invocation**. The task already exists in
`turbo.json` with `cache: false`; `--force` additionally prevents replay of any dependency task.
Running only `pnpm --filter @flash/api test:integration`, or running a forced Turbo graph that
omits `test:integration`, is not Phase 2 gate evidence.

Required evidence in `STATE.md`:

1. `Cached: 0 cached` on the turbo line, and the task/pass counts.
2. The concurrency spec's own output: **exactly 10 CONFIRMED / 490 SOLD_OUT / 0 other, 3
   iterations**, plus the I1/I2/I4 key assertions.
3. The negative control's output proving it **oversold** (confirmed > 10, stock < 0).
4. The window-edge spec's `serverTimeMs`-vs-bound assertions passing on all four rows.
5. The rate-limit spec passing at **production** limits, including the `X-Forwarded-For` and
   `rl:u:*` cardinality assertions.
6. The clock-skew spec passing all six rows.
7. **The §11.7 enqueue-failure spec passing**: with the queue client pointed at a dead Redis, a
   purchase in an open window returns 201; `SCARD buyers === 1`; `HGET reservations {userId}`
   matches `^<uuid>:\d+$`; stock decremented by exactly 1 with no compensation; and the
   `purchase.enqueue_failed` log record's `reservationId` matches the ledger entry. (Itemized here
   — corrected 2026-07-22, Phase 2 review — after this line was previously absent from this
   checklist and the spec itself did not exist; see `test/integration/enqueue-failure.integration.spec.ts`.)
8. A `security-reviewer` (Opus) pass — **mandatory at Phase 2 per PRD §9.3**, reviewed against §10
   of this document.

**Grep-able invariants a reviewer checks directly:**

```bash
rg -n "NODE_ENV\s*===?\s*['\"]test" apps/api/src/          # must be ZERO hits
rg -n "\.reset\(" apps/api/src/                             # must be ZERO hits
rg -n "unsafe" apps/api/src/                                # must be ZERO hits
rg -n "app\.inject" apps/api/test/integration/              # must be ZERO hits
rg -n "Scope\.REQUEST" apps/api/src/                        # must be ZERO hits
rg -n "PG_POOL" apps/api/src/purchase/purchase.service.ts   # must be ZERO hits
rg -n "\b(201|403|409|410|422|429|503)\b" apps/api/src/*/  *.controller.ts
                                                            # status codes come from
                                                            # PURCHASE_OUTCOME_HTTP_STATUS, not literals
```

---

## 13. ERRATUM applied to `.claude/contracts/phase-1.md` §3.3 (STATE.md open issue 1)

The Phase 1 §3.3 boundary table's `` `S` (exact), stock 0 `` row read `upcoming` in the
`deriveSaleState` column. That contradicted §3.2's own frozen precedence: rule 1 is **strict**
(`nowMs < startsAtMs`), so at `nowMs === startsAtMs` rule 1 does not fire, rule 2 does not fire, and
rule 3 (`stockRemaining <= 0`) yields **`sold_out`**. The shipped implementation
(`packages/shared/src/sale-state.ts`) and its unit spec were always correct; only the table cell was
wrong, and the explanatory paragraph beneath it repeated the error.

**Applied changes** (the architect owns `.claude/contracts/**`, so this one fix was made in place):

1. The cell now reads `sold_out`.
2. A new row `` `S - 1`, stock 0 `` → `upcoming` / `false` / `SALE_NOT_STARTED` was added — that is
   where `upcoming` genuinely beats `sold_out`, and it is almost certainly what the wrong cell was
   reaching for.
3. The paragraph beneath was rewritten into two numbered lessons, and an `ERRATUM` blockquote was
   inserted above it so a future agent reading the table cannot be misled by a stale memory of it.

Phase 2's `window-edge.integration.spec.ts` (§11.5) asserts the corrected table through HTTP, so the
contract text and the running system are now checked against each other by a test rather than by
reading.

---

## 14. Summary of frozen decisions (index)

| # | Decision | § |
|---|---|---|
| 1 | 5 slices, file-level exclusive ownership; merge A → B → C → D → E | §1, §2 |
| 2 | One `@Global()` `InfraModule`; **3** singleton ioredis clients (store / limiter / queue), never per-request; `Scope.REQUEST` forbidden; ordered graceful shutdown | §4 |
| 3 | `serverTime` comes from **Lua's own `TIME`** whenever the request reached Lua — zero drift on both `/sale/status` and `/purchase` | §5.1 |
| 4 | Otherwise: Redis-anchored offset (min-RTT of last 5 samples), refreshed every 5s on the same round trip that refreshes the config cache; **guard disabled when stale**; asymmetric 250ms skew margin makes a false negative structurally impossible | §5.2–§5.6 |
| 5 | `stockRemaining < 0` with config present ⇒ **503 `NOT_INITIALIZED`**, never a clamped `sold_out`, never a passed-through `-1` | §6.2 |
| 6 | Zod via a custom pipe → **422**; one global filter is the only error-body producer; malformed/oversized body ⇒ 422 | §6.7 |
| 7 | Rate limiting in **Redis** (not in-memory — the API is horizontally scalable); 20/s/IP globally + 5/s/user on purchase; 4 independent cardinality bounds; fail **open**, deliberately; `TRUST_PROXY=false` | §7 |
| 8 | Enqueue is **awaited before** the response; on failure retry once then still return **201**, never compensate, and log `reservationId` — the reservations ledger is the Phase 3 recovery path | §8.4 |
| 9 | `GET /purchase/:userId` reads **PG first, Redis fallback**; `compensated ⇒ purchased: false`; PG outage degrades, never 503s | §8.2 |
| 10 | Liveness (`/api/health`, never 503, no I/O) split from readiness (`/api/health/ready`); PG and queue failures are **reported, not 503** | §9 |
| 11 | Concurrency spec at raised **limits, never a disabled limiter**, and it proves the limiter was in the path via `x-ratelimit-*` headers; a mandatory negative control must oversell or the suite fails | §11.3, §11.4 |
| 12 | Window edges asserted as a **relation between the returned `serverTimeMs` and the window bound**, not a wall-clock sleep | §11.5 |
| 13 | Phase 1 §3.3's self-inconsistent row corrected in place, and now covered by a test | §13 |
| 14 | **Amendment A1** — shared node preset moves to `module`/`moduleResolution: NodeNext` (exports-aware, CommonJS emit preserved); `packages/tooling/tsconfig/**` and `apps/*/tsconfig*.json` are **architect-owned**, no implementer edits them; pure-ESM runtime deps are now disallowed | §15 |
| 15 | **Amendment A2** — `messageFor(ApiErrorCode)` and its total outcome-to-message map are frozen; the Phase 2 gate includes `test:integration` in the forced Turbo graph | §16 |
| 16 | **Amendment A3** — readiness queue observation is independently bounded and forcibly cancellable; shutdown attempts every resource and has a process-level hard stop; unhandled rejections are fatal; BullMQ job ids use the executable hyphen delimiter | §17 |
| 17 | **Amendment A4** — direct-exposure HTTP deadlines; explicit production boot configuration; atomic, self-healing limiter TTLs; bounded/cancellable BullMQ producer generations; accepted take-home security risks | §18 |

---

## 15. AMENDMENT A1 — module resolution (`NodeNext`)

**Authority:** ARCHITECT · **Date:** 2026-07-22 · **Status:** FROZEN · **Amends:** §1

Versioned amendment, not a silent rewrite. Raised as a cross-slice blocker by a Phase 2
implementer; slices B, C and E were blocked identically, and no slice owned the file that had
to change. §1 now carries an **ARCH** ownership row so this ambiguity cannot recur.

### 15.1 The change

`packages/tooling/tsconfig/node.json`:

```jsonc
"module": "NodeNext",          // was "CommonJS"
"moduleResolution": "NodeNext" // was "Node"
```

One preset, applied once, inherited by `apps/api`, `apps/worker`, `packages/redis` and
`packages/shared`. No per-app override — a per-app fix would leave Phase 3's worker to
rediscover the same blocker.

### 15.2 ADR — decision, alternatives rejected, why

**Decision: `module` + `moduleResolution` = `NodeNext` in the shared node preset.**

Classic `Node` (Node10) resolution predates `exports` and never consults it, so the frozen §6
mandate *"all DTOs come from `@flash/shared/schemas`"* was unsatisfiable: TS could see
`dist/schemas.d.ts` but refused to resolve it (TS2307). NodeNext is the only option that is
**both exports-aware and CommonJS-emit-preserving**. No package in this repo sets
`"type": "module"`, so NodeNext classifies every file as CJS: emit stays CommonJS, `require`
interop is unchanged, extensionless *static* relative imports remain legal, and Nest's
decorator/DI metadata is untouched.

| Alternative rejected | Why rejected |
|---|---|
| `module: "Preserve"` + `moduleResolution: "Bundler"` | **Rejected on a factual error in the proposal.** `preserve` does *not* emit CommonJS — it emits `import`/`export` verbatim. `apps/api` and `apps/worker` build via `nest build` (tsc) into packages with no `"type": "module"`, so the emitted `dist/main.js` would carry ESM syntax and die at `node dist/main.js` with `SyntaxError: Cannot use import statement outside a module`. A green typecheck over a runtime-broken build is precisely the hollow-green failure class this project has already been burned by. `moduleResolution: "Bundler"` also cannot be combined with `module: "CommonJS"` — TS rejects that pair outright. |
| `paths` mapping to `packages/shared/dist/schemas` | Papers over resolution instead of fixing it: it lies to the typechecker about a path Node resolves by a different mechanism, so typecheck and runtime can silently diverge. Would also need re-adding for every future subpath export. Explicitly recorded as the debt option **not** taken. |
| `typesVersions` shim in `packages/shared/package.json` | Would work, but `packages/shared` is frozen (§0.1), it leaves the repo on legacy Node10 resolution, and it taxes every future workspace package that adds a subpath export. |

### 15.3 ESM-only dependency inventory (constrains future dependency choices)

Under NodeNext-in-CJS-mode, importing an ESM-only package (`"type": "module"` with no `require`
condition) is a hard **TS1479** error where classic `Node` silently allowed it. Audited the full
runtime graph of `apps/api`, `apps/worker`, `packages/redis`, `packages/shared`:

| Package | `type` | Verdict |
|---|---|---|
| `@nestjs/*`, `rxjs`, `reflect-metadata`, `ioredis` | commonjs | safe |
| `zod` v4 | `module` | **safe — dual-published**, exposes a `require` condition (`index.cjs`) |
| `vitest` / `vitest/config` | `module` | **safe in practice** — the `./config` subpath carries a `require` condition, so `vitest.config.ts` (which is inside `include`) typechecks clean. This was the single largest predicted risk and it did **not** materialize. |

**Standing constraint for Phases 3–6:** before adding any runtime dependency, verify it exposes a
`require` export condition. A pure-ESM dependency (`"type": "module"`, `import`-only exports) will
now fail typecheck with TS1479 and must be rejected or dynamically imported. `nanoid` v4+, `p-*`,
and `node-fetch` v3+ are known pure-ESM and are hereby **disallowed** as direct dependencies —
use `crypto.randomUUID()`, hand-rolled helpers, and `undici` respectively. Feeds README §12.

### 15.4 Consequence for already-written code — SLICE E only

NodeNext treats dynamic `import()` as a genuine ESM import even inside a CJS-mode file, so it
requires an explicit file extension (**TS2834**). This is the only new error class the change
introduces; it affects **7 sites, all in SLICE E's `apps/api/test/**`**, and no `src/**` file:

```
test/integration/concurrency.integration.spec.ts
test/integration/health.integration.spec.ts
test/integration/purchase-flow.integration.spec.ts
test/integration/purchase-status.integration.spec.ts
test/integration/rate-limit.integration.spec.ts
test/support/app-harness.ts
```

**SLICE E's required fix, in preference order:**
1. **Preferred — hoist to a static top-level `import`.** Extensionless *static* relative imports
   remain legal under NodeNext; converting `const { X } = await import('../../src/common/tokens')`
   to `import { X } from '../../src/common/tokens'` removes the error with no extension churn.
2. Only where the import must stay lazy, append `.js`:
   `await import('../../src/common/tokens.js')`.

No other slice changes any code as a consequence of this amendment.

### 15.5 Evidence

- `pnpm exec turbo run typecheck --force` → **6 of 7 packages pass**; `@flash/shared`,
  `@flash/redis`, `@flash/worker` fully clean. `@flash/api` still fails only on **pre-existing
  mid-flight slice work** (deps not yet added to `apps/api/package.json` — `pg`, `bullmq`,
  `ioredis`, `@fastify/*`, `undici`, `@testcontainers/postgresql`; and SLICE A files not yet
  written — `src/common/tokens.ts`, `src/app.module.ts`, `src/infra/**`), plus the 7 TS2834 in
  §15.4. Before/after error-set diff confirms **no other new error class appeared**.
- `@flash/shared/schemas` TS2307 count: **13 before → 0 after**.
- **CommonJS emit preserved:** `packages/shared/dist/schemas.js` still begins `"use strict";
  Object.defineProperty(exports, "__esModule", ...)`.
- **Runtime resolution proven** (typecheck alone would prove nothing) — executed from
  `apps/api/`:
  ```
  $ node -e 'const s=require("@flash/shared/schemas"); ...'
  require path : /…/packages/shared/dist/schemas.js
  exported keys: userIdSchema, purchaseRequestSchema, purchaseResponseSchema,
                 saleStatusResponseSchema, purchaseStatusParamsSchema, purchaseStatusResponseSchema
  live parse   : OK -> {"userId":"u-runtime-proof"}
  ```
  Node's CJS `require` has honored `exports` since Node 12; this confirms it for the real
  package, through the pnpm symlink, with the schema actually executing.
- Constraints honored: `isolatedModules`, `strict`, `noUnusedLocals`, `noUnusedParameters`,
  `noUncheckedIndexedAccess` all untouched; no `"incremental": true` added anywhere.

---

## 16. AMENDMENT A2 — response messages and integration-gate wiring

**Authority:** ARCHITECT · **Version:** A2 · **Date:** 2026-07-22 · **Status:** FROZEN ·
**Amends:** §2.1, §6.4, §7.5, §10.3, §11.1, §12

Versioned amendment, not a silent rewrite. The original text cited §11.5 as the location of a
frozen response-message table, but §11.5 is and remains the window-edge HTTP test. This
amendment supplies the missing total table, pins its API, and corrects those cross-references.
It also closes the gate-documentation defect where the integration suite passed independently
but was absent from the forced Turbo graph used as gate evidence.

### 16.1 Frozen total outcome-to-message mapping

`apps/api/src/common/messages.ts` owns the mapping and **must export** this function:

```ts
export function messageFor(code: ApiErrorCode): string;
```

`ApiErrorCode` is the total vocabulary `AttemptOutcome | 'NOT_FOUND' | 'INTERNAL'` from
`common/dto/api-error.ts`. `messageFor` is the single response-facing lookup used by controllers,
filters, rate-limit builders, and services; those consumers do not hard-code parallel message
literals. Its backing table is total at compile time (`satisfies Record<ApiErrorCode, string>`) and
has these exact values:

| `ApiErrorCode` | Exact message |
|---|---|
| `CONFIRMED` | `Purchase confirmed.` |
| `ALREADY_PURCHASED` | `You have already purchased this item.` |
| `SOLD_OUT` | `This item is sold out.` |
| `SALE_NOT_STARTED` | `The sale has not started yet.` |
| `SALE_ENDED` | `The sale has ended.` |
| `NOT_INITIALIZED` | `The sale is not ready yet. Please try again shortly.` |
| `INVALID_USER_ID` | `The provided user ID is invalid.` |
| `RATE_LIMITED` | `Too many requests. Please slow down and try again shortly.` |
| `UPSTREAM_UNAVAILABLE` | `The service is temporarily unavailable. Please try again shortly.` |
| `NOT_FOUND` | `Not found.` |
| `INTERNAL` | `Internal error` |

These literals adopt the complete table already present in `common/messages.ts`; they do not
replace it with new wording. The stale source comment describing the missing-table gap must be
updated to cite this amendment when implementation reconciliation runs. Any message returned for
an `ApiErrorCode` outside this table, or any raw exception text, violates §10.3.

### 16.2 Forced Turbo integration gate

The normative Phase 2 gate is the command block in §12. `test:integration` is an existing root
Turbo task, not a new task invented by this amendment. It remains `cache: false` in `turbo.json`
and is named explicitly in the same `pnpm exec turbo run ... --force` graph as lint, typecheck,
unit tests, and build. The separate `pnpm test:integration` command remains valid for focused
development, but it is not a substitute for the forced graph invocation at the phase gate.

---

## 17. AMENDMENT A3 — bounded lifecycle, fatal unhandled errors, and executable BullMQ ids

**Authority:** ARCHITECT · **Version:** A3 · **Date:** 2026-07-22 · **Status:** FROZEN ·
**Amends:** §1, §2.1, §4.1–§4.3, §8.3, §9.3, §11.1–§11.3, §12, and Phase 0 §16

Versioned amendment, not a silent rewrite. Terra's adversarial review found that two apparent
timeouts bounded only what the caller awaited, not the underlying work: readiness could abandon
BullMQ `getJobCounts()` on the producer connection forever, and shutdown could abandon the whole
sequential close chain before later resources were attempted. The same review found a test gate
configured to ignore every unhandled rejection and a frozen BullMQ id that the installed library
rejects. All four are lifecycle/contract defects and are resolved together here.

### 17.1 Readiness: bounded observation with hard cancellation

**Decision.** The producer `Queue` and its `REDIS_QUEUE_CLIENT` retain their enqueue-durability
configuration (`maxRetriesPerRequest: null`, no command timeout). Readiness MUST NOT issue
`Queue.getJobCounts()` through that connection. A `Promise.race` cannot cancel an ioredis command;
it only stops awaiting it, so a black-holed producer connection can retain one pending command per
public probe without bound.

Add `QUEUE_DEPTH_PROBE = 'QUEUE_DEPTH_PROBE'` and a singleton `QueueDepthProbe` at
`apps/api/src/infra/queue-depth-probe.ts`. It owns a **fourth, observation-only** ioredis client and
a BullMQ `Queue` over the same queue name/prefix. This is the only amendment to §4.2's three-client
rule:

| Client | `connectionName` | Required options | Allowed work |
|---|---|---|---|
| queue observer | `flash-api-queue-observer` | `maxRetriesPerRequest: 1`, `commandTimeout: 750`, `connectTimeout: 750`, `enableOfflineQueue: false`; no reconnect retry after forced cancellation | `getJobCounts('waiting','active','delayed','failed')` only |

`QueueDepthProbe.depth()` has these binding semantics:

1. **Single flight.** At most one depth command exists process-wide. Concurrent readiness calls
   share that promise; they do not enqueue parallel BullMQ commands.
2. **Independent 750ms deadline.** A timer races the command. On deadline, the probe calls
   `observerRedis.disconnect(false)` synchronously, which closes the socket and rejects/removes
   the in-flight command rather than merely abandoning its promise. It then awaits/catches the
   command's settlement, closes/detaches the observer `Queue`, clears the generation, and only
   then permits a later call to lazily create a fresh generation. Timers are cleared and
   `.unref()`'d.
3. **Bounded live state.** There is never more than one observer client, one observer Queue, and
   one depth promise alive. A failed public probe therefore cannot accumulate sockets, commands,
   listeners, or unresolved promises under repeated calls.
4. **Result semantics unchanged.** Success returns the same four counts. Any setup, command,
   deadline, or cancellation failure reports queue `ok: false`; per §9.3 it does **not** degrade
   overall readiness. Observation never touches the purchase producer or changes I1–I4.
5. **Lifecycle.** `QueueDepthProbe.close()` is idempotent, rejects new observations once closing
   begins, force-disconnects an active generation, awaits its settlement, and participates in
   §17.2's cleanup sequence.

`HealthService` injects `QUEUE_DEPTH_PROBE` and calls its already-bounded `depth()` directly. Its
generic 1s response budget remains the endpoint budget, but is no longer the only bound on queue
work. Other asynchronous checks retain independent finite bounds: store Redis commands use their
existing 1s `commandTimeout`; readiness `SELECT 1` sets a per-query `query_timeout` of **750ms**
without changing the pool-wide 2s statement timeout. The 1s race is response shaping, never the
sole owner of cancellation.

**Required proof.** Unit tests use fake timers and a never-settling queue command to assert:
(a) 100 concurrent `depth()` calls invoke `getJobCounts` once; (b) at 750ms the observer's
`disconnect(false)` is called; (c) every caller settles; (d) generation state returns to zero;
(e) the next call creates exactly one fresh generation. The health unit spec asserts queue timeout
remains non-degrading. An integration spec makes observer Redis unreachable, repeatedly calls
public readiness beyond one budget window, and asserts bounded observer creation/in-flight counts
plus a prompt response on every call; HTTP status alone is insufficient proof.

### 17.2 Shutdown: attempt every resource, then hard-stop the process

**Decision.** Preserve Terra's existing `waitUntilReady`, terminal `end` wait, and idempotent
Redis/PG close fixes where they settle normally. Remove only the old overall
`withTimeout(shutdownSequence(), 5000)` wrapper: it returned after 5s while the underlying
sequential promise kept running, and an indefinite queue wait/close prevented all later cleanup.
A deadline must force progress between dependencies, not merely bound the outer await.

The normative shutdown order remains **producer Queue → queue observer → all Redis clients →
Postgres**, with these exact semantics:

1. `onApplicationShutdown()` is idempotent and shares one shutdown promise.
2. `Queue.waitUntilReady()` may run only inside the same **1000ms** producer-queue budget as
   `Queue.close()`; it must never add an unbounded preliminary wait. On rejection or deadline,
   log the label and immediately call `REDIS_QUEUE_CLIENT.disconnect(false)` to cancel BullMQ
   initialization/commands. Await/catch both raced promises so neither can later reject unhandled,
   then continue.
3. Call `QueueDepthProbe.close()` next under its own hard-cancellation rule.
4. Attempt store, limiter, producer-queue, and observer Redis closes concurrently. Keep Terra's
   terminal-status no-op and terminal-`end` wait. Each graceful `quit()` gets at most **1000ms**;
   on rejection/deadline call `disconnect(false)`, await/catch the original close promise, detach
   lifecycle listeners, and continue. Failure of one never blocks another.
5. Attempt `pgPool.end()` with the remaining process-shutdown budget, preserving the existing
   idempotency flags. A rejection is logged only after every earlier resource was attempted. `pg`
   has no supported force-destroy API for checked-out clients, so process termination is the
   explicit final backstop.
6. `main.ts` arms one `.unref()`'d **5000ms process watchdog** on the first `SIGTERM`/`SIGINT`,
   before Nest shutdown hooks execute. Clean shutdown clears it. If any hook remains incomplete at
   the deadline, log fatal and `process.exit(1)`. Direct `app.close()` in tests performs resource
   cleanup but never exits the test process; forced exit belongs only to the signal/watchdog path.

"Ordered" means a graceful attempt in that order, not permission for an earlier broken resource
to starve later cleanup. Forced disconnect is the defined transition between phases.

**Required proof.** Infra unit tests independently make producer queue ready/close, each Redis
quit, and `pgPool.end()` never settle. Fake timers advance deadlines and assert every later
resource was still attempted, all abandoned promises carry rejection handlers, force-disconnect
ran, and two shutdown calls share one sequence. A child-process test holds a fake hook open after
`SIGTERM` and asserts exit code 1 at 5s; the healthy case exits cleanly before the watchdog.

### 17.3 Unhandled rejections are fatal; test suppression is forbidden

Production MUST NOT install an `unhandledRejection` handler that logs and continues. An unhandled
rejection means an async ownership defect or unknown process state; continuing can silently lose
I4 work. The single production handler logs the reason/stack at fatal severity, invokes the same
deduplicated bounded shutdown path as a termination signal, and exits **1**. A rejection during
shutdown is caught by that shared path and cannot recursively start another shutdown.

`apps/api/vitest.integration.config.ts` MUST NOT set
`dangerouslyIgnoreUnhandledErrors: true`. No `onUnhandledError` filter may replace it. Once the
outage simulation and lifecycle ownership are fixed, **any** unhandled rejection fails the suite,
regardless of message or dependency stack. Tests simulate outages through owned, awaited failure
boundaries (a stubbed provider, a disposable dedicated client, or a container/network fault), not
by disconnecting a shared live client while unrelated commands are active. The Phase 2 gate must
report zero Vitest `Unhandled Rejection` / `Unhandled Error` entries.

### 17.4 BullMQ custom job-id erratum (I4)

Phase 0 §16 and this contract's original §8.3/§11 text froze
`` `${saleId}:${userId}` ``. Installed `bullmq@5.80.9` proves that form cannot execute:
`dist/cjs/classes/job.js` and `dist/esm/classes/job.js` throw
`Custom Id cannot contain :` for a two-part colon-bearing custom id. The three-part exception is
legacy repeatable-job compatibility and its source is marked for removal in the next breaking
change. Phase 0 §20 records the cross-contract erratum.

The frozen executable form is:

```ts
buildOrdersJobId(saleId, userId) === `${saleId}-${userId}`
```

Every producer, Phase 3 consumer/reconciler, and test imports this helper. Tests assert helper
output rather than spelling a delimiter. Required regression: real BullMQ accepts the generated
id, two adds for one `(saleId,userId)` produce one job, and two distinct valid userIds under the
boot-fixed sale id produce distinct jobs. This preserves deterministic retry deduplication and I4.

### 17.5 Security-review boundary — no architect sign-off

The adversarial pass also raised slow-client timeouts, public exposure of detailed readiness, and
production use of local-development env defaults. They are **not silently folded into A3**:

- Slow-header/body deadlines and public readiness exposure are security/operational-policy
  decisions. The mandatory Phase 2 `security-reviewer` must disposition them before the gate,
  including topology and compatibility consequences; A3 does not claim they are accepted.
- Localhost defaults remain the original host-development contract. Whether production mode must
  reject omitted `CORS_ORIGIN`, `DATABASE_URL`, `REDIS_URL`, and `SALE_ID` is likewise a mandatory
  security-review decision before sign-off. A3 makes no production-default waiver.

The architect resolves lifecycle mechanics; it does **not** issue Phase 2 security sign-off. The
security review remains a separate, required §12 gate item.

### 17.6 Terra implementation briefs — exclusive path ownership

These briefs are the implementation handoff. They may run in parallel only where paths are
disjoint; no agent may edit a path outside its row.

| Brief | Exclusive paths | Required work and proof |
|---|---|---|
| **A3-A — lifecycle/infra** | `apps/api/src/main.ts`; `apps/api/src/common/tokens.ts`; `apps/api/src/infra/**` | Add `QUEUE_DEPTH_PROBE`; implement the single-flight observer and §17.1 hard cancellation; replace the outer shutdown race with §17.2 per-resource progression while preserving Terra's terminal/idempotent fixes; add infra unit specs and signal-watchdog child proof. Load `nestjs-best-practices`, `redis-connections`, `redis-observability`, `bullmq-specialist`, `vitest`. |
| **A3-C — queue id** | `apps/api/src/queue/orders-queue.service.ts`; `apps/api/src/queue/orders-queue.service.spec.ts` | Keep/export the live hyphen `buildOrdersJobId`; remove stale comments claiming `:` is still frozen; prove accepted format and deterministic unit behavior. Do not implement readiness observation here. Load `bullmq-specialist`, `vitest`. |
| **A3-D — readiness consumer** | `apps/api/src/health/**` | Inject `QUEUE_DEPTH_PROBE`, remove `OrdersQueueService.depth()` use, apply the 750ms PG query bound, and prove queue timeout is reported but non-degrading. Do not create/close clients. Load `nestjs-best-practices`, `postgresql-table-design`, `vitest`. |
| **A3-E — integration gate** | `apps/api/test/**`; `apps/api/vitest.integration.config.ts` | Delete `dangerouslyIgnoreUnhandledErrors`; replace shared-live-client disconnect outage simulations with owned failure boundaries; add repeated-probe boundedness, real BullMQ idempotency, zero-unhandled, and shutdown child-process coverage. Do not change production source. Load `vitest`, `redis-connections`, `bullmq-specialist`. |

Merge order is **A3-A → A3-C → A3-D → A3-E**, followed by a Terra adversarial review. Any
repeated complex lifecycle failure escalates back to Sol. Luna may perform only the later
formatting/import sweep and must not change these semantics.

---

## 18. AMENDMENT A4 — production security and bounded producer ownership

**Authority:** ARCHITECT · **Version:** A4 · **Date:** 2026-07-22 · **Status:** FROZEN ·
**Amends:** §1–§4, §7.3–§7.6, §8.1/§8.3/§8.4, §10, §11, §12, and Amendment A3

Versioned amendment, not a silent rewrite. The final Sol security review withheld sign-off on
three production controls, and Terra's final adversarial pass escalated the producer lifecycle:
the caller's 500ms race bounded the HTTP await but retained two underlying `Queue.add()` calls per
confirmed request when the producer connection was black-holed. A4 resolves all four blockers.
It preserves the A3 shutdown order and process watchdog; where A4 changes producer ownership, A4
supersedes A3's raw producer-Queue/client mechanics only.

### 18.1 Direct-exposure HTTP deadline policy

The API is published directly on port 3000 in the shipped Compose topology. There is no reverse
proxy in front of it. Installed `fastify@5.10.0` defaults both `connectionTimeout` and
`requestTimeout` to `0`; Fastify's official server reference explicitly recommends a non-zero
`requestTimeout` when deployed without a reverse proxy. `bodyLimit` bounds bytes, not the time a
client may spend sending those bytes.

Freeze these **source constants**, not env vars:

| Constant | Value | Applied as | Meaning |
|---|---:|---|---|
| `HTTP_CONNECTION_TIMEOUT_MS` | `5000` | Fastify `connectionTimeout` | maximum socket inactivity; closes trickled/stalled connections |
| `HTTP_HEADERS_TIMEOUT_MS` | `5000` | raw Node `server.headersTimeout` before listen | maximum time to receive complete HTTP headers |
| `HTTP_REQUEST_TIMEOUT_MS` | `10000` | Fastify `requestTimeout` | maximum time to receive the complete request, including its body |
| `HTTP_KEEP_ALIVE_TIMEOUT_MS` | `5000` | Fastify `keepAliveTimeout` | finite idle keep-alive retention |
| `HTTP_MAX_REQUESTS_PER_SOCKET` | `1000` | Fastify `maxRequestsPerSocket` | finite HTTP/1.1 connection reuse |

These are constants because they are minimum direct-exposure safety properties, not sale tuning
knobs. An omitted or mistyped deployment variable must not silently restore Fastify's unbounded
defaults. The values are compatible with the 16KB body limit, local k6 traffic, and ordinary SPA
requests; they do not impose an application-handler timeout and therefore do not cancel a valid
Redis decision or create a new I4 ambiguity.

`main.ts` exports one side-effect-free `createHttpAdapter(apiEnv)` used by both production
`bootstrap()` and `test/support/app-harness.ts`. It constructs the adapter with the five options
above plus the already-frozen `trustProxy`, `bodyLimit`, and `genReqId`, and sets
`adapter.getInstance().server.headersTimeout` before Nest listens. The harness MUST NOT reproduce
these values. Application plugin setup is likewise exported as one `configureApp(app, apiEnv)`
path and shared by bootstrap and the harness, closing the security-test drift already identified
by Sol. Importing `main.ts` in a test must not start the server; guard the executable entrypoint.

**Required proof.** A real `node:net` socket test, never `app.inject()`, runs against the shared
adapter: (a) send an incomplete header block and assert the server closes the socket no later than
`HTTP_HEADERS_TIMEOUT_MS + 1500`; (b) send complete POST headers with a non-zero `Content-Length`
but only a partial JSON body and assert closure no later than
`HTTP_REQUEST_TIMEOUT_MS + 1500`; (c) assert Fastify initial config/raw server values equal the
five constants. The two sockets may run concurrently. Merely checking option objects is not the
regression.

### 18.2 Production requires explicit operational identity and endpoints

`NODE_ENV` retains the exact enum `development | test | production`, defaulting to
`development`. Parsing is raw-presence-aware: when and only when raw `NODE_ENV === 'production'`,
each of these raw inputs must be present and non-empty **before defaults are applied**:

```
CORS_ORIGIN  DATABASE_URL  REDIS_URL  SALE_ID
```

Missing fields produce one boot error listing every missing field. Present values still pass the
existing URL/string/`assertSaleId` validation. Development and test retain the current localhost
defaults. `NODE_ENV` values other than the three exact literals remain fatal.

No other value becomes production-required in A4. `TRUST_PROXY=false`, body/rate/clock bounds,
queue name, and pool limits have safe conservative defaults. The API reads the active sale window
from Redis rather than `SALE_STARTS_AT`/`SALE_ENDS_AT`/`SALE_TOTAL_STOCK`; requiring those seed
inputs at API boot would create a false security property. `.env.example` remains a host-dev
example and its values remain unchanged; its comment must state that the four rows are mandatory
explicit inputs in production. Required unit matrix: delete each required field independently in
production (four failures, named paths), delete all four (one error lists all), empty-string cases
fail, development/test omissions receive the existing defaults, and explicit production values
parse.

### 18.3 Per-user limiter: one atomic, self-healing Redis decision

The A3 two-step compensation is superseded. A second `PEXPIRE` can fail at the command level too,
and its reply was again not authoritative unless inspected. The guard now performs exactly one
Redis `EVAL` round trip with one key and `RATE_LIMIT_USER_WINDOW_MS` as the only argument:

```lua
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('SET', KEYS[1], '1', 'PX', ARGV[1])
  return {1, tonumber(ARGV[1])}
end
local count = redis.call('INCR', KEYS[1])
return {count, ttl}
```

`PTTL == -2` creates the fixed window. `PTTL == -1` identifies a legacy/permanent key from the
old implementation and resets it to count 1 with a finite TTL, so rollout heals the unsafe state
on its next access. For an existing valid key, Lua increments without extending its original
window. All arguments are already validated positive integers. Redis executes the script
atomically, so there is no client-visible state in which the increment landed but the expiry
command was never attempted; a lost acknowledgement means the complete script may have landed,
which is safe. A malformed/null/non-numeric two-element reply is an error.

The returned TTL supplies `Retry-After`; remove the separate `PTTL` request. Any EVAL transport,
command, or reply-shape failure logs `ratelimit.store_unavailable` and **fails open**, unchanged
from §7.6. It never retries or performs a compensating write. I1–I4 remain in Lua/PG, while key
cardinality is now structurally bounded under partial Redis command errors.

**Required proof.** Unit/fake tests assert one EVAL call, missing/permanent/existing-key reply
handling, malformed/rejected EVAL fail-open behavior, and zero fallback `PEXPIRE`/pipeline calls.
A real-Redis integration test pre-seeds a valid no-TTL `rl:u:*` key, sends a valid purchase, and
asserts its `PTTL` is in `(0, window]`; it also creates many valid buckets and asserts every one
has positive bounded PTTL. Repeat fake command failures and prove requests settle fail-open
without minting additional keys.

### 18.4 BullMQ producer: finite generations, hard cancellation, truthful 201

The earlier claim that all BullMQ connections require `maxRetriesPerRequest: null` was too broad.
BullMQ's official production guidance requires `null` for Worker blocking connections, but
recommends a finite retry count for a Queue used by an HTTP endpoint so callers do not wait
forever. Phase 2 has a producer only. Its ioredis generation therefore uses:

```
maxRetriesPerRequest: 1
commandTimeout: ENQUEUE_TIMEOUT_MS       # default 500ms
connectTimeout: ENQUEUE_TIMEOUT_MS       # default 500ms
enableOfflineQueue: false
retryStrategy: () => null
```

`OrdersQueueService` becomes the sole owner of a lazily-created producer **generation**: one raw
ioredis client, one BullMQ `Queue`, one attached `error` listener, a set of owned add settlements,
and one close promise. `REDIS_QUEUE_CLIENT` and raw `ORDERS_QUEUE` cease to be injectable/exported
application tokens; callers inject `OrdersQueueService`. At most one active-or-retiring generation
exists. `MAX_PRODUCER_IN_FLIGHT = 64` and `PRODUCER_REOPEN_BACKOFF_MS = 1000` are source constants,
not env knobs.

For each `enqueue(payload)`:

1. If closing, in reopen backoff, retiring, or already at 64 in-flight adds, reject immediately.
   The reservation ledger remains the recovery authority.
2. Attach fulfillment and rejection handlers to `queue.add(...)` immediately, register that
   settlement in the generation, and race it against `ENQUEUE_TIMEOUT_MS`.
3. Success removes the settlement and returns. Rejection or deadline atomically retires that
   generation: detach it from new callers, call raw `redis.disconnect(false)`, and observe every
   already-registered add settlement. No new generation may be created until those settlements
   have cleared; if BullMQ ever fails to settle after hard disconnect, the circuit stays open and
   later calls reject fast instead of accumulating more work.
4. Dispose the Queue under one bounded close promise, remove the exact Queue `error` listener in
   `finally`, and enter the 1000ms reopen backoff. Queue errors are logged as
   `orders_queue.error`; no listener is leaked across generations.

`PurchaseService` still invokes `enqueue` at most twice with the identical job id. The first
deadline normally opens the circuit, so the second invocation may reject immediately; "retry
once" means a second call, not permission to retain a second underlying add. If both calls fail,
the response remains truthful **201 `CONFIRMED`**, the API never compensates, and
`purchase.enqueue_failed` retains `reservationId`. Phase 3's ledger sweep remains the sole I4
recovery mechanism. The response therefore completes within `2 * ENQUEUE_TIMEOUT_MS + 250ms`,
and sustained outage traffic cannot accumulate adds beyond the fixed 64-operation generation.

`OrdersQueueService.close()` is idempotent, rejects new work, hard-disconnects the active
generation, owns all add rejections, performs bounded Queue disposal/listener removal, and is the
first resource attempted by `InfraModule` shutdown. The remaining A3 observer → Redis → Postgres
ordering and signal watchdog remain unchanged. `InfraModule` must never use `void operation` as a
substitute for settlement ownership.

**Required proof.** Unit tests use never-settling adds and fake timers to prove the 64 cap, one
generation, timeout hard-disconnect, circuit-open fast rejection, no second underlying add for a
timed-out request retry, recovery only after retirement/backoff, idempotent close, and exact
listener removal. Integration uses the real `bullmq.Queue` and real ioredis client against a
test-owned black-hole TCP server (not an `OrdersQueueService`/`queue.add` stub), while store Redis
remains real and healthy. A confirmed POST must return 201 within the bound; stock, buyers, and
reservation ledger remain committed; repeated confirmed traffic remains bounded; all producer
add settlements clear after hard disconnect; no Queue error/unhandled rejection appears; and
shutdown completes. The existing real-Redis job-id/dedup test remains required.

### 18.5 Accepted risks — explicit, not security sign-off by omission

The final Sol review accepts these only for the local take-home boundary:

- `GET /api/health/ready` and `GET /api/sale/metrics` remain public and disclose aggregate
  dependency/queue state. A real deployment must place them on an internal listener or protect
  them at the gateway. Liveness remains I/O-free. This is accepted Phase 2 scope, not a claim that
  public operational telemetry is generally safe.
- Identity is client-asserted because PRD §1.2 excludes real authentication. Attackers can consume
  another identifier's entitlement and probe purchase state one candidate at a time. Production
  must bind both purchase routes to an authenticated principal. The `(ip,userId)` limiter only
  prevents cross-IP budget theft; it does not authenticate purchases.
- Limiter fail-open remains accepted because it is a stability control, not an invariant control.
  This increases the importance of §18.1's socket deadlines. `TRUST_PROXY=false` remains correct
  for the current direct topology.

The existing headers, exact-match CORS, request-id validation, response-error hygiene, audit, and
secret posture are accepted as sound. These dispositions must be carried into README's accepted
risks in Phase 6; Phase 2 does not add authentication or an internal ops listener.

### 18.6 Terra implementation briefs — exclusive path ownership

Run sequentially in the stated order where one brief consumes an earlier interface. No brief may
edit another row's paths.

| Brief | Exclusive paths | Required work and proof |
|---|---|---|
| **A4-A — HTTP + env + atomic limiter** | `apps/api/src/main.ts`; `apps/api/src/config/**`; `apps/api/src/common/per-user-rate-limit.guard.ts`; `apps/api/src/common/per-user-rate-limit.guard.spec.ts` | Implement §§18.1–18.3 source behavior and unit matrix. Export shared adapter/configuration without import-time listen. Do not touch queue, infra, or integration paths. Load `nestjs-best-practices`, `redis-core`, `redis-connections`, `vitest`. |
| **A4-C — bounded producer lifecycle** | `apps/api/src/common/tokens.ts`; `apps/api/src/queue/**`; `apps/api/src/infra/redis.providers.ts`; `apps/api/src/infra/infra.module.ts`; `apps/api/src/infra/infra.module.spec.ts`; `apps/api/src/purchase/purchase.service.ts`; `apps/api/src/purchase/purchase.service.spec.ts` | Implement §18.4, remove obsolete raw producer tokens/providers, preserve A3 cleanup order/watchdog, and prove bounded generations/listeners/add settlement plus truthful retry behavior. Do not edit harness/integration. Load `bullmq-specialist`, `redis-connections`, `redis-observability`, `nestjs-best-practices`, `vitest`. |
| **A4-E — real boundary regressions** | `apps/api/test/**`; `apps/api/vitest.integration.config.ts` | Consume A4-A/C exports; remove duplicate bootstrap configuration; add raw slow-header/body socket proof, real-Redis TTL self-heal/cardinality proof, and real BullMQ+ioredis black-hole producer proof with ledger/boundedness/zero-unhandled assertions. No production edits. Load `vitest`, `redis-core`, `redis-connections`, `bullmq-specialist`. |

Merge order is **A4-A → A4-C → A4-E**, then a Terra adversarial pass focused on retained work,
listener counts, raw sockets, and I1–I4, followed by final Sol security/architecture review. Luna may
perform only the subsequent formatting/import/comment sweep. The Phase 2 gate remains §12 and now
also requires every A4 proof above.

### 18.7 CLARIFICATION A4.1 — queue inspection is a test-owned observer

**Authority:** ARCHITECT · **Version:** A4.1 · **Date:** 2026-07-22 · **Status:** FROZEN ·
**Clarifies:** §11.2–§11.4, §18.4, §18.6

A4 removed the raw `ORDERS_QUEUE` token deliberately, but the pre-A4 integration suite obtained
that token from Nest to inspect persisted BullMQ jobs. Restoring a raw Queue getter or adding
`getJob`/`getJobs` to `OrdersQueueService` would pierce the ownership boundary A4 exists to create:
diagnostics could issue uncapped commands through the producer generation, create it merely by
observing it, or couple health/tests to a retiring circuit. **Rejected.** The producer remains a
write-and-lifecycle boundary only.

The frozen `OrdersQueueService` public surface is exactly:

```ts
enqueue(payload: OrdersQueueJobPayload): Promise<Job>;
close(): Promise<void>;
readonly activeGenerationCount: number;
readonly inFlightCount: number;
```

The two counters are boundedness diagnostics only. No `queue`, `client`, `getJob`, `getJobs`,
`getJobCounts`, or arbitrary-command escape hatch is added. Health continues to use the separately
bounded `QueueDepthProbe.depth(): Promise<QueueDepth>` from A3; it never uses the producer.

Integration inspection uses a second, **test-owned read-only observer** in
`apps/api/test/support/queue-test-observer.ts` [A4-E]. Freeze this API:

```ts
export type ObservedQueueState = 'waiting' | 'active' | 'delayed' | 'failed';

export interface ObservedOrderJob {
  id: string;
  name: typeof PERSIST_ORDER_JOB_NAME;
  data: OrdersQueueJobPayload;
}

export interface QueueTestObserver {
  getJob(jobId: string): Promise<ObservedOrderJob | null>;
  listJobIds(states: readonly ObservedQueueState[]): Promise<string[]>;
  getJobCounts(): Promise<OrdersQueueDepth>;
  close(): Promise<void>;
}

export function createQueueTestObserver(options: {
  redisUrl: string;
  queueName: string;
}): QueueTestObserver;
```

`OrdersQueueDepth` is the existing four-number shape `{ waiting, active, delayed, failed }`; if
its current production export was removed during A4-C, A4-E defines the structurally identical
test-local type rather than reopening the producer API. `getJob` normalizes BullMQ's missing value
to `null` and returns only the three frozen fields above. `listJobIds` returns sorted, non-null
string ids and accepts only the four read states. `getJobCounts` requests exactly those same four
states. No mutating method (`add`, `remove`, `clean`, `drain`, `obliterate`, retry/promotion) is
exposed.

The observer owns one dedicated ioredis client and one real BullMQ `Queue`, using the harness's
actual `redisUrl`, `queueName`, and prefix `bull`. It attaches an explicit Queue `error` listener
at creation. `close()` is idempotent and owns, in order, bounded Queue close, listener removal,
and Redis close/hard-disconnect fallback; the harness includes it in its own teardown. It is never
registered in Nest DI and never exists in production. Therefore it cannot affect the producer's
64-operation cap, generation/circuit state, shutdown ordering, or readiness connection.

`bootHarness()` returns this observer as `queueObserver`, and A4-E replaces every integration
lookup/import of `ORDERS_QUEUE` with only:

- `harness.queueObserver.getJob(buildOrdersJobId(...))` for payload/id assertions;
- `harness.queueObserver.listJobIds(['waiting', 'active'])` for the I4 exact-id set;
- `harness.queueObserver.getJobCounts()` where the four-state count object is genuinely needed.

The real job-id/dedup proof may call the injected `OrdersQueueService.enqueue(...)` to perform
writes, then observe results through `queueObserver`; it must never call a raw Queue's `add()`.
This keeps the production writer under A4's bound while preserving independent Redis-side proof.

**Ownership clarification.** A4-C implements **no new method and changes no additional file** for
A4.1: its implementing file remains `apps/api/src/queue/orders-queue.service.ts`, with the exact
four-member public surface above. A4-E exclusively creates
`apps/api/test/support/queue-test-observer.ts` and updates `apps/api/test/support/app-harness.ts`
plus affected `apps/api/test/integration/**` consumers. This remains disjoint from A4-C and does
not authorize A4-E to edit production source.

### 18.8 CLARIFICATION A4.2 — own BullMQ initialization before enqueue

**Authority:** ARCHITECT · **Version:** A4.2 · **Date:** 2026-07-22 · **Status:** FROZEN ·
**Clarifies:** §18.4 and the A4-C brief in §18.6

The real black-hole test exposed one promise family A4 did not name: constructing BullMQ `Queue`
starts `RedisConnection.init()` before `queue.add()`. With ioredis `enableReadyCheck: true` and
`enableOfflineQueue: false`, ioredis's internal `_readyCheck` issues `INFO` while the stream is not
writable. Disconnect then produced late `Stream isn't writeable and enableOfflineQueue options is
false` rejections outside the tracked add settlement. Tracking `queue.add()` alone therefore
cannot prove zero unhandled work or clear a retiring generation.

#### 18.8.1 Producer connection options — exact superseding set

Keep offline queuing disabled and finite retries, but the producer generation now uses all of:

```ts
{
  lazyConnect: true,
  enableReadyCheck: false,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  commandTimeout: env.ENQUEUE_TIMEOUT_MS,
  connectTimeout: env.ENQUEUE_TIMEOUT_MS,
  retryStrategy: () => null,
}
```

`lazyConnect: true` prevents ioredis from beginning connection work before the service can attach
ownership. BullMQ's constructor then deliberately starts its one initialization when it asks the
`wait` client to connect. `enableReadyCheck: false` is required specifically because BullMQ
performs its own version/connection `INFO` during `RedisConnection.init()`; running ioredis's
additional private ready-check adds no correctness property and creates a second hidden command
promise. It does **not** mean "assume Redis is usable": the BullMQ initialization/version command
must still succeed before any add is attempted. `enableOfflineQueue: false` remains unchanged, so
no application command is retained waiting for a future connection.

#### 18.8.2 Generation owns readiness as a first-class settlement

`ProducerGeneration` adds these exact fields:

```ts
type ReadinessResult = { ok: true } | { ok: false; error: unknown };

redisErrorListener: (error: Error) => void;
queueErrorListener: (error: Error) => void;
readiness: Promise<ReadinessResult>; // always fulfills; attached in createGeneration()
```

Creation order is binding:

1. Create the lazy Redis client and attach `redisErrorListener` immediately.
2. Construct the BullMQ Queue and attach `queueErrorListener` synchronously before yielding.
3. In that same call stack, call `queue.waitUntilReady()` exactly once and immediately convert it
   with `.then(() => ({ok:true}), error => ({ok:false,error}))`. Store this always-fulfilled
   promise as `generation.readiness`. No raw initialization promise is returned or ignored.

Both listeners log structured `orders_queue.error` records and are removed by exact function
identity during disposal. Event listeners supplement promise ownership; they never substitute for
it.

`enqueue()` uses one absolute deadline, captured before it obtains the generation. It first awaits
the shared `generation.readiness` within the remaining `ENQUEUE_TIMEOUT_MS` budget. Only
`{ok:true}` may proceed to `queue.add()`. A readiness rejection or deadline retires the generation
and rejects the attempt; no `queue.add()` is created. If readiness succeeds, the add receives only
the remaining portion of the same deadline. This preserves **one 500ms budget per service call**,
not 500ms for readiness plus another 500ms for add.

Every promise created by readiness, add, retirement, Queue close, and a deadline is converted at
creation into an always-fulfilled tagged settlement. Do not use `void promise`, a bare `.catch()`
whose returned promise is then abandoned, or `Promise.race()` against a raw rejecting promise.
Timer handles are cleared in both branches.

#### 18.8.3 Retirement completion and clearing bound

Retirement is single-flight. Its exact order is:

1. Mark retiring and detach the generation from new enqueue work.
2. Hard-disconnect Redis once.
3. Await the already-owned `readiness` plus a snapshot of every owned add settlement. Because
   ready-check is disabled, offline queuing is disabled, retry is terminal, and command/connect
   timeouts are finite, hard disconnect must settle them.
4. Only after those settle, call the single owned/bounded `Queue.close()` settlement.
5. Remove both Redis and Queue error listeners in `finally`, hard-disconnect once more, clear the
   settlement set, set `generation = null`, and start the reopen backoff.

From the first enqueue deadline, `inFlightCount` and `activeGenerationCount` must both reach zero
within:

```
PRODUCER_RETIRE_BOUND_MS = 2 * ENQUEUE_TIMEOUT_MS + 250
```

This bound covers cancellation settlement plus bounded Queue disposal; it is an assertion, not a
new timer that abandons work. If it fails, the implementation remains defective and the suite
fails. Subsequent requests reject fast while retirement is in progress. Shutdown awaits the same
single retirement settlement and retains A3's outer process watchdog.

I4 behavior is unchanged: PurchaseService still calls `enqueue` at most twice, still returns
truthful 201 after Redis confirmation, never compensates, logs the reservation identity, and
relies on Phase 3 ledger reconciliation.

#### 18.8.4 Precise A4-C fix and proof

**Exclusive source/test ownership remains A4-C:**

- `apps/api/src/queue/orders-queue.service.ts`
- `apps/api/src/queue/orders-queue.service.spec.ts`

No A4.2 change is authorized in integration tests, harness, infra, purchase, STATE, or git. Update
the producer option set, generation fields, creation order, single-budget enqueue flow, and
single-flight retirement exactly as §§18.8.1–18.8.3 specify.

Required A4-C unit regressions use controlled readiness and add promises with fake timers and
assert:

1. readiness is attached exactly once during generation creation and shared by concurrent calls;
2. no `queue.add()` runs before readiness succeeds;
3. readiness rejection/timeout performs one hard disconnect, creates zero adds, and settles every
   caller;
4. add rejection/timeout retires once and all concurrent owned adds settle;
5. both listeners are installed once and removed once by the same identities;
6. retirement/close promises are always fulfilled/owned, two `close()` calls share one result,
   and no unhandled rejection event is observed after advancing beyond the retire bound;
7. `activeGenerationCount === 0` and `inFlightCount === 0` no later than
   `PRODUCER_RETIRE_BOUND_MS` after the first deadline.

A4-E then reruns its existing real BullMQ+ioredis black-hole integration unchanged. Passing means
truthful 201 plus intact stock/buyer/ledger state, no `_readyCheck`/`Redis.info` unhandled
rejections, and zero generation/in-flight counts within the frozen bound. The integration test
must not suppress, filter, or catch process-level unhandled errors to manufacture green evidence.
