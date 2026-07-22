# Phase 3 — FROZEN CONTRACT (Worker & Durability)

**Authority:** ARCHITECT (Sol/Opus-mapped) · **Date:** 2026-07-22 · **Status:** FROZEN v1
**Above this doc:** `PRD.md`. **Also binding:** Phases 0–2, including Phase 1 §11 and
Phase 2 Amendments A1–A4.2. This document makes only the explicit amendments below.
**Consumers:** Phase 3 implementation and review agents. They do not invent shared names.

> Phase 3 closes I4. Every Redis-confirmed reservation must reach exactly one terminal
> outcome: a matching `persisted` Postgres row, or reservation-identity-safe Redis
> compensation. A failed BullMQ job is durable pending work, not permission to forget it.

> This contract is frozen when handed off. Ambiguity routes orchestrator → architect and
> results in a numbered amendment. Implementers do not negotiate cross-slice changes and do
> not edit paths outside their ownership row.

---

## 0. Scope, inherited facts, and deliberate amendments

### 0.1 In scope

- Move the producer/consumer queue contract to `@flash/shared` and migrate the Phase 2
  producer/tests to consume it.
- Implement the BullMQ `orders` consumer, idempotent Postgres persistence, retry exhaustion,
  durable failed-set/DLQ compensation, continuous enqueue-gap repair, and boot reconciliation.
- Extend the Postgres schema so Redis reservation identity is the durable order identity.
- Add only the Redis primitives needed to make reconciliation race-safe.
- Worker readiness, structured lifecycle ownership, graceful drain, and real-container
  failure-mode integration tests.
- Minimal env/Compose/Turbo wiring required by those behaviors.

### 0.2 Out of scope

| Deferred work | Owner |
|---|---|
| Frontend or `prototype/**` | Phase 4 |
| k6, load audit, throughput tuning | Phase 5 |
| README prose/final diagrams/fresh-clone narrative | Phase 6 |
| Authentication, multi-product/multi-sale semantics | PRD non-goals |
| API endpoint shape changes | not authorized in Phase 3 |
| Replacing Redis/BullMQ/Postgres or weakening I1–I4 | never |

No Phase 3 route exposes reconciliation, reservation scans, queue mutation, or compensation.

### 0.3 Amendments to earlier frozen contracts

1. **Shared queue contract location.** Phase 2 §8.3/A3 defined queue symbols inside
   `apps/api`. They move, without compatibility re-exports, to
   `packages/shared/src/queue.ts` and the `@flash/shared` root export. Both apps import the
   one definition.
2. **Job ID stays executable and user-deterministic.** The A3 form remains exactly
   `buildOrdersJobId(saleId, userId) === `${saleId}-${userId}``. Phase 3 explicitly handles
   a compensated user's later reservation colliding with the retained failed job; it does
   not silently change the ID format.
3. **Reconciliation stock authority is the reservations ledger, not a stale PG count.**
   Phase 1's comment that Phase 3 passes `totalStock - persistedOrderCount` to
   `reconcileStock()` is superseded. That formula inflates stock whenever confirmed jobs are
   still queued. Phase 3 uses a new atomic `reconcileStockFromReservations()` primitive:
   `totalStock - HLEN(reservations)` at the Redis serialization point.
4. **Purchase duplicate defense is strengthened.** `purchase.lua` treats either buyers-Set
   membership **or** an existing reservations-hash field as `ALREADY_PURCHASED`; if only the
   ledger field exists, it repairs `SADD buyers` before returning. This closes the warm-AOF
   drift window where a missing Set member could otherwise overwrite a live reservation and
   decrement stock twice. It changes no valid-state outcome and only strengthens I2/I4.
5. **Postgres `orders.id` is the reservation UUID.** The Phase 0 default-generated UUID is
   replaced by the UUID already generated atomically with the Redis confirmation. One identity
   now joins Redis ledger, queue payload, worker logs, DLQ, and Postgres.

### 0.4 Declared durability boundary

Redis 7.4 with AOF `everysec` plus BullMQ on that Redis is the PRD's durable handoff. The system
recovers process crashes, command lost acknowledgements, partial sale-key loss, worker/PG
outages, and enqueue gaps while Redis/BullMQ durable state or Postgres survives. Simultaneous
irrecoverable loss of Redis AOF **before an unqueued reservation reaches Postgres** destroys the
only record of that confirmation and is not solvable by application code without introducing a
synchronous second durable write on the hot path, which the PRD rejects. Tests called “cold
Redis” therefore mean sale keys are missing while Postgres and/or BullMQ job payloads survive;
they do not claim recovery from destruction of every copy of unpersisted data.

---

## 1. Hard invariants — enforcement in this phase

| Invariant | Phase 3 enforcement |
|---|---|
| **I1 no oversell** | Worker never decrements stock. Compensation calls the existing atomic, capped, reservation-matching Lua script. Reconciliation computes stock inside Redis from `totalStock - HLEN(reservations)` after restoring authoritative PG/queue identities; it never writes a caller-computed count. An overcommitted ledger is a fatal readiness incident, never clamped into a healthy state. |
| **I2 one per user** | `orders_user_id_uniq` remains unique on `user_id` alone. The worker's conflict adjudication never overwrites a different `persisted` row. Redis purchase now checks both buyers and reservations; reconciliation restores both. |
| **I3 window** | Phase 3 never creates a reservation. `purchase.lua` keeps the Redis `TIME` half-open `[startsAt, endsAt)` check unchanged. Re-enqueueing only transports an already-confirmed identity and cannot create a purchase. |
| **I4 no lost confirmations** | A confirmed ledger entry is continuously diffed against PG and every BullMQ state. Missing work is re-enqueued. At-least-once inserts are idempotent by reservation identity. Exhausted jobs remain in `failed` until the DLQ sweep proves persisted or compensates under a PG advisory-lock protocol. No failed job is auto-removed before terminal resolution. |

**Fail-closed rule:** malformed job data, conflicting durable identity, overcommitted state,
buyer-only state with no recoverable identity, or an indeterminate PG commit is never “fixed” by
blind compensation. It remains durable failed work, emits an error, and keeps readiness degraded
until the safe terminal action succeeds.

---

## 2. File-level exclusive ownership and dispatch order

Ownership is exact. `~` modifies an existing file; `+` creates it. No two agents edit one path.

### S1 — shared queue contract and API migration

Required skills: `turborepo-monorepo`, `bullmq-specialist`, `vitest`.

```
packages/shared/src/queue.ts                                      +
packages/shared/src/queue.spec.ts                                 +
packages/shared/src/index.ts                                      ~
packages/shared/src/index.spec.ts                                 ~
apps/api/src/queue/orders-queue.service.ts                        ~
apps/api/src/queue/orders-queue.service.spec.ts                   ~
apps/api/test/support/queue-test-observer.ts                      ~
apps/api/test/integration/concurrency.integration.spec.ts         ~
apps/api/test/integration/purchase-flow.integration.spec.ts       ~
```

S1 moves names; it does not change producer generation/circuit/shutdown semantics from A4.2.

### S2 — race-safe Redis reconciliation primitives

Required skills: `redis-core`, `redis-connections`, `vitest`.

```
packages/redis/src/types.ts                              ~
packages/redis/src/index.ts                              ~
packages/redis/src/sale-store.ts                         ~
packages/redis/src/scripts/purchase.lua.ts               ~
packages/redis/src/scripts/registry.ts                   ~
packages/redis/src/scripts/reconcile-state.lua.ts        +
packages/redis/src/scripts/reconcile-membership.lua.ts   +
packages/redis/src/sale-store.purchase.spec.ts           ~
packages/redis/src/sale-store.concurrency.spec.ts        ~
packages/redis/src/sale-store.reconcile.spec.ts          ~
packages/redis/src/scripts/registry.spec.ts              ~
```

### S3 — durable Postgres schema

Required skills: `postgresql-table-design`.

```
infra/postgres/init/001_schema.sql                       ~
```

### S4 — worker production implementation and unit tests

Required skills: `bullmq-specialist`, `postgresql-table-design`, `redis-core`,
`redis-connections`, `redis-observability`, `nestjs-best-practices`, `vitest`.

```
apps/worker/package.json                                 ~
pnpm-lock.yaml                                           ~  S4 only
apps/worker/src/main.ts                                  ~
apps/worker/src/worker.module.ts                         ~
apps/worker/src/config/env.ts                            ~
apps/worker/src/config/env.schema.ts                     +
apps/worker/src/config/env.spec.ts                       +
apps/worker/src/common/tokens.ts                         +
apps/worker/src/infra/redis.providers.ts                 +
apps/worker/src/infra/postgres.provider.ts               +
apps/worker/src/infra/infra.module.ts                    +
apps/worker/src/infra/infra.module.spec.ts               +
apps/worker/src/orders/order.repository.ts               +
apps/worker/src/orders/order.repository.spec.ts          +
apps/worker/src/orders/order.processor.ts                +
apps/worker/src/orders/order.processor.spec.ts           +
apps/worker/src/orders/orders.consumer.ts                +
apps/worker/src/orders/orders.consumer.spec.ts           +
apps/worker/src/orders/orders.module.ts                  +
apps/worker/src/reconciliation/reconciliation.service.ts +
apps/worker/src/reconciliation/reconciliation.service.spec.ts +
apps/worker/src/reconciliation/reconciliation.module.ts  +
apps/worker/src/health/health.controller.ts              ~
apps/worker/src/health/health.controller.spec.ts         ~
apps/worker/src/health/health.service.ts                 +
apps/worker/src/health/health.service.spec.ts            +
apps/worker/src/health/health.module.ts                  ~
```

### S5 — worker real-container integration suite

Required skills: `bullmq-specialist`, `postgresql-table-design`, `redis-core`,
`redis-connections`, `vitest`.

```
apps/worker/vitest.config.ts                             ~
apps/worker/vitest.integration.config.ts                 +
apps/worker/test/**                                      +
```

### S6 — runtime wiring

Required skills: `multi-stage-dockerfile`, `turborepo-monorepo`.

```
.env.example                                             ~
turbo.json                                               ~
infra/docker-compose.yml                                 ~
```

**Merge/implementation order:** S1 → S2 → S3 → S4 → S5 → S6. S1–S3 may be authored in
parallel because paths are disjoint, but S4 verifies only after all three land. S5 consumes S4.
S6 is last so its env list matches the actual reader. `.claude/contracts/**`, `STATE.md`, tags,
and commits remain architect/orchestrator-owned. No slice touches `.codex/`.

---

## 3. Shared queue interface — exact exports

`packages/shared/src/queue.ts` exports:

```ts
export const ORDERS_QUEUE_PREFIX = 'bull' as const;
export const PERSIST_ORDER_JOB_NAME = 'persist-order' as const;
export const ORDERS_JOB_ATTEMPTS = 5 as const;
export const ORDERS_JOB_BACKOFF_DELAY_MS = 200 as const;

export interface OrdersQueueJobPayload {
  saleId: string;
  userId: string;
  reservationId: string; // UUID text; exact Redis ledger identity
  reservedAtMs: number;  // finite safe integer >= 0
  requestId: string;     // original request ID, or `reconcile-<reservationId>`
}

export function buildOrdersJobId(saleId: string, userId: string): string;
export function assertOrdersQueueJobPayload(value: unknown): asserts value is OrdersQueueJobPayload;
```

`buildOrdersJobId` first calls existing `assertSaleId`, validates `userId` against the existing
trimmed `USER_ID_*` constants, and returns exactly `${saleId}-${userId}`. It does not accept or
encode `reservationId`. `assertOrdersQueueJobPayload` is a zero-dependency runtime assertion;
no Zod import is added to the root `@flash/shared` entry. It rejects extra/missing keys, invalid
sale/user IDs, non-UUID reservation IDs, unsafe/non-integer timestamps, and invalid request IDs
(`^[A-Za-z0-9_-]{1,128}$`; reconciliation IDs fit). It returns nothing on success and throws
`TypeError` on failure.

The Phase 2 producer deletes its local declarations and imports all six shared values/types. Job
options remain:

```ts
{
  jobId: buildOrdersJobId(payload.saleId, payload.userId),
  attempts: ORDERS_JOB_ATTEMPTS,
  backoff: { type: 'exponential', delay: ORDERS_JOB_BACKOFF_DELAY_MS },
  removeOnComplete: { count: 1000 },
  removeOnFail: false,
}
```

It calls `assertOrdersQueueJobPayload(payload)` before `queue.add`. No compatibility re-export
remains in `orders-queue.service.ts`; all repository imports migrate to `@flash/shared` so the
worker cannot accidentally bind to API source.

**User-deterministic ID collision after compensation:** a retained failed R1 job and a new live
R2 reservation for the same user share a job ID. That is expected. Reconciliation compares the
existing job's `data.reservationId` with the ledger. It may remove R1 only after Postgres records
R1 as `compensated`; it then adds R2. It never treats “a job with this ID exists” as proof that
the matching reservation is queued.

---

## 4. Postgres durable model

### 4.1 Schema — exact final DDL intent

Keep `sales` and `order_status`. Replace the `orders` definition with this semantic shape (names
and constraints exact; formatting may differ):

```sql
CREATE TABLE orders (
  id           uuid         PRIMARY KEY, -- Redis reservationId; no DB default
  user_id      text         NOT NULL,
  sale_id      text         NOT NULL REFERENCES sales (id) ON DELETE RESTRICT,
  status       order_status NOT NULL,
  created_at   timestamptz  NOT NULL,     -- reservedAtMs converted with to_timestamp
  persisted_at timestamptz,
  request_id   text         NOT NULL,
  CONSTRAINT orders_user_id_len CHECK (char_length(user_id) BETWEEN 3 AND 64),
  CONSTRAINT orders_request_id_len CHECK (char_length(request_id) BETWEEN 1 AND 128),
  CONSTRAINT orders_persisted_at_state CHECK (
    (status = 'persisted' AND persisted_at IS NOT NULL) OR
    (status IN ('reserved', 'compensated') AND persisted_at IS NULL)
  )
);
CREATE UNIQUE INDEX orders_user_id_uniq ON orders (user_id);
CREATE INDEX orders_sale_id_status_idx ON orders (sale_id, status);
CREATE INDEX orders_created_at_idx ON orders (created_at DESC);
```

`reserved` remains in the enum for the already-frozen API vocabulary, but the Phase 3 worker
does not commit a `reserved` row: Redis is the reserved state. Fresh persisted inserts set
`status='persisted'`; safe terminal failure writes `status='compensated'`.

The schema stays fresh-init SQL for this take-home. No migration framework is added. Integration
tests apply this file to a new Postgres 16 container.

### 4.2 Sale row boot contract

The reconciliation leader executes an insert with the worker's validated sale env, then reads
the row back:

```sql
INSERT INTO sales (id, name, total_stock, starts_at, ends_at)
VALUES ($1,$2,$3,$4,$5)
ON CONFLICT (id) DO NOTHING;
```

An existing row must exactly match name, stock, and epoch-millisecond window. Drift is fatal and
readiness remains false; the worker never silently mutates a live sale definition.

### 4.3 Per-reservation serialization

Every persistence or compensation decision begins a PG transaction and runs:

```sql
SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0)); -- $1 reservation UUID text
```

Then it locks the user's current order row with `SELECT ... FOR UPDATE`. A hash collision merely
serializes unrelated work and is safe. This lock closes the otherwise fatal race “compensator
observes no row → persister commits → compensator returns stock,” which could create a durable
order plus resold stock (I1/I4).

No compensation is attempted when Postgres is unreachable or commit outcome is indeterminate.
The failed BullMQ job remains the durable retry source until PG can answer safely.

### 4.4 Persistence algorithm and `ON CONFLICT` semantics

For payload R, inside the §4.3 transaction:

```sql
INSERT INTO orders (id,user_id,sale_id,status,created_at,persisted_at,request_id)
VALUES ($reservationId,$userId,$saleId,'persisted',to_timestamp($reservedAtMs/1000.0),clock_timestamp(),$requestId)
ON CONFLICT (user_id) DO NOTHING
RETURNING id,status;
```

- Insert returned a row → commit → success.
- No row returned → select the `user_id` row `FOR UPDATE` and adjudicate:
  - same id + `persisted` → idempotent success (covers insert-ack crash/redelivery);
  - same id + `compensated` → terminal compensated; acknowledge stale persistence without
    resurrection;
  - different id + `persisted` → invariant conflict; roll back and throw permanent failure;
  - different id + `compensated` → call `store.getReservation(saleId,userId)` while holding the
    transaction. Only an exact R identity permits a guarded update of that compensated row to R,
    `persisted`, with the new timestamps/request ID. Missing/mismatched ledger throws and does
    not overwrite history.

The guarded update has `WHERE user_id=$userId AND id=$oldId AND status='compensated'` and must
affect exactly one row. `ON CONFLICT DO UPDATE` is forbidden because it cannot encode the identity
and state checks above and could overwrite a genuinely persisted different reservation.

The processor returns only after COMMIT succeeds. A disconnect/timeout during COMMIT is
indeterminate and is thrown; redelivery resolves it by the same-id row check.

---

## 5. Redis reconciliation interface and scripts

### 5.1 New public types/methods

`@flash/redis` adds, without removing the Phase 1 API:

```ts
export type ReconcileStateOutcome = 'RECONCILED' | 'NOT_INITIALIZED' | 'OVERCOMMITTED';
export interface ReconcileStateResult {
  outcome: ReconcileStateOutcome;
  previousStock: number;
  newStock: number;
  reservationCount: number;
  totalStock: number;
}

export interface BuyerScanPage { cursor: string; userIds: string[]; }

SaleRedisStore.prototype.getReservation(
  saleId: string, userId: string
): Promise<ReservationEntry | null>;
SaleRedisStore.prototype.scanBuyers(
  saleId: string, cursor?: string, count?: number
): Promise<BuyerScanPage>;
SaleRedisStore.prototype.reconcileBuyerMembership(
  saleId: string, userId: string
): Promise<'PRESENT' | 'ABSENT'>;
SaleRedisStore.prototype.reconcileStockFromReservations(
  saleId: string
): Promise<ReconcileStateResult>;
```

`getReservation` performs one `HGET` and uses the same strict parser as `scanReservations`.
Malformed ledger values throw; they never become made-up IDs. `scanBuyers` uses cursor-paged
`SSCAN`, default/count 200; no `SMEMBERS`.

### 5.2 `reconcile-membership.lua.ts`

Two keys, same sale hash tag: buyers, reservations. `ARGV[1]=userId`.

```lua
if redis.call('HEXISTS', KEYS[2], ARGV[1]) == 1 then
  redis.call('SADD', KEYS[1], ARGV[1])
  return 'PRESENT'
end
redis.call('SREM', KEYS[1], ARGV[1])
return 'ABSENT'
```

This is the only automatic buyer removal. It is atomic against `purchase.lua`, so a concurrent
new reservation cannot be removed based on a stale client-side `HGET`.

### 5.3 `reconcile-state.lua.ts`

Three keys, same tag: config, stock, reservations. No ARGV.

```lua
if redis.call('EXISTS', KEYS[1]) == 0 then return {'NOT_INITIALIZED',-1,-1,0,-1} end
local total = tonumber(redis.call('HGET', KEYS[1], 'totalStock') or '-1')
local count = redis.call('HLEN', KEYS[3])
local previous = tonumber(redis.call('GET', KEYS[2]) or '-1')
if total < 0 or count > total then
  return {'OVERCOMMITTED',previous,previous,count,total}
end
local desired = total - count
redis.call('SET', KEYS[2], desired)
return {'RECONCILED',previous,desired,count,total}
```

`OVERCOMMITTED` performs no write. It is an incident: do not cap to zero and claim health.
Because purchase and reconciliation scripts serialize on Redis, a purchase immediately before
this script is included in HLEN and one immediately after sees the corrected stock. There is no
lost decrement window.

### 5.4 Purchase amendment

The original config/window checks keep their exact order. The duplicate branch becomes:

```lua
if redis.call('SISMEMBER', KEYS[3], ARGV[1]) == 1 or
   redis.call('HEXISTS', KEYS[4], ARGV[1]) == 1 then
  redis.call('SADD', KEYS[3], ARGV[1])
  return {'ALREADY_PURCHASED', stock, nowMs, ''}
end
```

Use the same stock/time variables/tuple positions already frozen in the shipped script. The
repairing SADD is the only new side effect in this branch. Tests must prove ledger-only drift
cannot confirm again under 200 concurrent attempts and the buyer Set is healed.

The old `reconcileStock(saleId, number)` stays exported for compatibility/tests but **zero Phase
3 worker source calls it**. A reviewer grep must find none.

---

## 6. Worker module, connections, and lifecycle

### 6.1 DI tokens

`apps/worker/src/common/tokens.ts` exports exact strings:

```ts
WORKER_ENV = 'WORKER_ENV'
WORKER_REDIS_STORE_CLIENT = 'WORKER_REDIS_STORE_CLIENT'
WORKER_REDIS_QUEUE_CLIENT = 'WORKER_REDIS_QUEUE_CLIENT'
WORKER_SALE_STORE = 'WORKER_SALE_STORE'
WORKER_PG_POOL = 'WORKER_PG_POOL'
ORDERS_QUEUE_ADMIN = 'ORDERS_QUEUE_ADMIN'
ORDERS_BULL_WORKER = 'ORDERS_BULL_WORKER'
RECONCILIATION_STATE = 'RECONCILIATION_STATE'
```

No request-scoped provider. No raw client is constructed per job.

### 6.2 Connections

- Store Redis: `createRedisClient`, name `flash-worker-store`, finite defaults; used for sale
  store/reconciliation/compensation only.
- BullMQ Worker connection: a dedicated ioredis client, name `flash-worker-consumer`,
  `maxRetriesPerRequest:null`, `enableReadyCheck:false`. BullMQ duplicates blocking connections
  as required; never share the store client.
- Queue admin connection: dedicated finite observer/mutator, name `flash-worker-admin`,
  `maxRetriesPerRequest:2`, `commandTimeout:2000`, `connectTimeout:2000`, used for pause/resume,
  paged state inspection, failed sweep, and gap enqueue only.
- One `pg.Pool`: `max=WORKER_PG_POOL_MAX`, `connectionTimeoutMillis=2000`,
  `idleTimeoutMillis=30000`, `statement_timeout=WORKER_PG_STATEMENT_TIMEOUT_MS`,
  `application_name='flash-worker'`.

All Redis/BullMQ error emitters get owned error listeners before async work begins. No naked
rejecting promise, `void queue.add`, or abandoned `Promise.race` is allowed.

### 6.3 Boot/readiness sequence

1. Parse env synchronously and fail on invalid values.
2. Start the Fastify health listener. `/health` is liveness 200/no dependency I/O;
   `/health/ready` is 503 until the rest of this sequence finishes.
3. `ReconciliationService.start()` retries with capped exponential backoff while PG/Redis are
   unavailable; liveness remains available. It acquires a Postgres **session** advisory lock
   `pg_advisory_lock(hashtextextended('flash-reconcile:' || SALE_ID,0))` on one checked-out
   client. Every replica runs the same protocol; only one reconciles at once.
4. Globally pause the `orders` queue, wait (bounded polling) until `active===0`, upsert/validate
   the sale, execute the full §8 boot pass, and release the session lock in `finally`.
5. Construct the BullMQ `Worker` only after that pass is green. Await `worker.waitUntilReady()`,
   resume the queue, start continuous gap/DLQ timers, then set readiness true.

If global pause cannot drain active jobs within 30s, readiness stays false and the pass retries;
it never reconciles across active processors. Adds may continue while paused and are included by
the ledger/queue scan. Repeated replicas may perform sequential idempotent boot passes; this is
safe and preferred to a stale “already reconciled” flag.

Worker readiness becomes false on shutdown, loss of the consumer, an unresolved boot/reconcile
incident, or an `OVERCOMMITTED`/unrecoverable buyer-only finding. A transient periodic scan error
sets false until a later complete pass succeeds.

### 6.4 Worker construction

Queue name `env.ORDERS_QUEUE_NAME`, prefix `ORDERS_QUEUE_PREFIX`, concurrency
`env.WORKER_CONCURRENCY`. Worker accepts only `PERSIST_ORDER_JOB_NAME`. It validates payload
before any DB/Redis action. `lockDuration=30000`, `stalledInterval=30000`, `maxStalledCount=2` are
source constants. The job's `opts.attempts` must equal `ORDERS_JOB_ATTEMPTS`; mismatch is logged
and failed, never trusted as a weaker retry policy.

Processor errors are thrown to BullMQ. Attempts/backoff are producer-owned shared constants.
There is no processor-side “if last attempt then compensate” branch: crashes can put a job in
failed state without executing that branch. The independent failed-set sweep is the sole terminal
resolver.

### 6.5 Shutdown

First signal/direct close shares one idempotent promise:

1. readiness false; stop/unref reconciliation and DLQ timers; reject new pass triggers;
2. `worker.pause(true)` (local), then `worker.close()` to drain in-flight jobs;
3. close QueueEvents/admin Queue and their listeners;
4. close store/admin/consumer Redis clients (hard disconnect after individual 2s budgets);
5. `pgPool.end()`;
6. close Nest/Fastify listener.

`SIGTERM`/`SIGINT` arms an unref'd 10s process watchdog; clean completion clears it, otherwise log
fatal and exit 1. `unhandledRejection`/`uncaughtException` logs fatal, enters the same shutdown,
and exits 1. Tests do not suppress unhandled errors.

---

## 7. Retry exhaustion and DLQ compensation

### 7.1 Durable DLQ source

The BullMQ `orders` **failed set** is the DLQ, exactly as Phase 2's `removeOnFail:false` states.
`QueueEvents('failed')` is only a wake-up hint. Independently, every
`WORKER_DLQ_SWEEP_INTERVAL_MS` the single-flight sweep pages at most
`WORKER_DLQ_SCAN_COUNT` failed jobs. A missed event or process crash therefore cannot strand
work. Failed jobs are retained until terminal handling finishes.

### 7.2 Exact terminal-resolution algorithm

For each failed job:

1. Validate name, payload, `jobId===buildOrdersJobId(...)`, and `attemptsMade >=
   ORDERS_JOB_ATTEMPTS`. Non-exhausted jobs are left alone. Malformed jobs remain failed and
   degrade readiness; without a trustworthy identity compensation is forbidden.
2. Begin PG transaction, take the §4.3 reservation advisory lock, select the user order
   `FOR UPDATE`.
3. If a same-id `persisted` row exists: COMMIT, then remove the failed job. This is the
   insert-ack/max-stalled crash window; **never compensate it**.
4. If a same-id `compensated` row exists: COMMIT, invoke identity-safe compensation once more
   (expected NOOP), then remove the failed job.
5. Otherwise call `store.compensate(saleId,userId,reservationId)` **while the PG transaction and
   advisory lock are held**. Only `COMPENSATED`, `COMPENSATED_CAPPED`, or `NOOP` are accepted.
6. Record compensation without overwriting a persisted order:
   - no row → insert R with `status='compensated'`, `persisted_at=NULL`;
   - different-id row with `status='compensated'` → guarded update to R compensated;
   - different-id `persisted` → preserve it; the Lua call can only remove R if R is still the
     current Redis identity and is otherwise NOOP.
7. COMMIT. Only after commit remove the failed BullMQ job. If removal fails, the next sweep is
   safe: PG says terminal and compensation is idempotent.

If Redis compensation succeeds and the process dies before PG commit, retry sees no marker,
calls compensation again (NOOP), and commits the marker. If PG fails before safe decision, the
job stays failed. This is why compensation waits for PG recovery rather than guessing after an
indeterminate insert.

### 7.3 Re-purchase collision cleanup

After R1 is durably `compensated`, the user may obtain R2. If failed job ID `sale-user` still
exists with R1 data, the gap repair may remove it only after confirming the PG R1 compensated
row under the R1 advisory lock. It then enqueues R2. A mismatched waiting/active/delayed job is
never removed; that is a live race and reconciliation retries after it settles.

---

## 8. Boot and continuous reconciliation

### 8.1 Sources and precedence

For one sale, build the active reservation map by identity:

1. Postgres `orders WHERE sale_id=$1 AND status='persisted'` (durable active truth).
2. Valid BullMQ jobs in `waiting`, `active`, `delayed`, `failed`, and `completed`, paged in
   bounded batches. Job data is validated; job ID alone is insufficient.
3. Redis `scanReservations()` pages (live confirmed truth, including post-Lua/pre-enqueue gaps).

Same user with different active identities is not silently merged:

- persisted PG identity wins as the only confirmed durable order; any different Redis identity
  must be safely driven to compensation via a failed repair job;
- different nonterminal queue/ledger identities without a persisted row are an incident and
  readiness stays false until one becomes terminal;
- a compensated PG identity is historical and may be replaced only by an exact current ledger
  identity per §4.4.

### 8.2 Full pass — exact order

1. Upsert/validate the `sales` row (§4.2).
2. Read Redis status. If uninitialized, `seed()` from the validated PG/env sale. Config drift is
   fatal. A missing stock key is repaired only later by the atomic state script.
3. Page PG rows and all queue states. Restore every persisted PG order. Restore a valid
   waiting/active/delayed/failed queue identity only when Postgres does **not** mark that same
   identity compensated and does not contain a different persisted identity for the user.
   Completed jobs are handled by step 4. Never restore a PG-compensated identity merely because
   its old failed job is still retained.
4. Page the Redis reservations ledger. For each entry:
   - matching PG persisted → no queue required;
   - matching waiting/active/delayed job → no action;
   - matching failed job → DLQ sweep owns it;
   - matching completed job + no PG row → remove that completed job and enqueue the same payload
     anew (a completed-without-commit contradiction);
   - no matching job and no PG row → enqueue `persist-order` with requestId
     `reconcile-${reservationId}`.
5. Job-ID collision with different payload follows §7.3. Merely finding `sale-user` is never
   enough to suppress repair.
6. For every ledger entry call `reconcileBuyerMembership` (ensures membership). Page buyers via
   `scanBuyers`. For each buyer, first call `getReservation` and consult the already-built PG/job
   maps. If a recoverable PG/queue identity exists, restore it and then call the atomic membership
   primitive. A buyer-only entry absent from ledger, PG, and every queue payload is reported as
   unrecoverable identity loss and makes the pass fail; **do not call the ABSENT/SREM branch for
   that user**, and do not silently compensate it. The ABSENT branch is permitted only for a
   caller-proven stale membership whose terminal compensated identity is durable in PG.
7. Call `reconcileStockFromReservations()` last. `RECONCILED` is success;
   `NOT_INITIALIZED`/`OVERCOMMITTED` fails readiness.
8. Trigger the failed-set sweep, then declare the pass complete.

All scans are cursor/page based; no `KEYS`, `SMEMBERS`, or unbounded `getJobs(0,-1)`. Page size is
`WORKER_RECONCILE_SCAN_COUNT`. Queue paging uses fixed start/end windows of that size.

### 8.3 Continuous repair

After boot, the same logical diff (steps 3–8) runs every
`WORKER_RECONCILE_INTERVAL_MS`, single-flight with coalesced triggers. It does **not** globally
pause the queue and does not rewrite sale config. Its Redis mutations are per-user atomic plus
the atomic HLEN-based stock script, so concurrent purchases/processors cannot lose a decrement or
remove a new identity. HSCAN/SSCAN weak consistency is acceptable only because passes repeat;
one complete later pass must eventually observe every stable entry.

Continuous repair is mandatory. Startup-only repair would leave an API post-Lua/pre-enqueue gap
forever on a healthy worker process that never restarts, violating I4.

---

## 9. Environment contract

Worker env uses Zod, parsed once at module load. Production requires explicit non-empty
`DATABASE_URL`, `REDIS_URL`, `SALE_ID`, `SALE_NAME`, `SALE_STARTS_AT`, `SALE_ENDS_AT`, and
`SALE_TOTAL_STOCK`; development/test retain `.env.example` defaults. `assertSaleId`, exact ISO
parsing, `endsAt > startsAt`, and positive integer bounds are mandatory.

| Name | Type | Default | Consumer / constraint |
|---|---:|---:|---|
| `NODE_ENV` | enum | `development` | worker |
| `LOG_LEVEL` | enum | `info` | worker |
| `WORKER_HEALTH_PORT` | int | `3001` | 1–65535 |
| `DATABASE_URL` | URL string | host-dev URL | worker; explicit production |
| `REDIS_URL` | URL string | host-dev URL | worker; explicit production |
| `SALE_ID` | sale id | `flash-2026` | worker; explicit production |
| `SALE_NAME` | nonempty text | existing example | worker; explicit production |
| `SALE_STARTS_AT` | ISO UTC | existing example | worker; explicit production |
| `SALE_ENDS_AT` | ISO UTC | existing example | worker; explicit production |
| `SALE_TOTAL_STOCK` | int ≥0 | `500` | worker; explicit production |
| `ORDERS_QUEUE_NAME` | nonempty text | `orders` | worker |
| `WORKER_CONCURRENCY` | int 1–128 | `16` | BullMQ Worker |
| `WORKER_MAX_ATTEMPTS` | int | `5` | must equal `ORDERS_JOB_ATTEMPTS`; drift is fatal |
| `WORKER_PG_POOL_MAX` | int 1–100 | `10` | PG pool |
| `WORKER_PG_STATEMENT_TIMEOUT_MS` | int 100–30000 | `2000` | PG pool |
| `WORKER_RECONCILE_INTERVAL_MS` | int 250–60000 | `2000` | continuous repair |
| `WORKER_RECONCILE_SCAN_COUNT` | int 10–1000 | `200` | all scan pages |
| `WORKER_DLQ_SWEEP_INTERVAL_MS` | int 250–60000 | `1000` | failed sweep |
| `WORKER_DLQ_SCAN_COUNT` | int 10–1000 | `100` | failed page |
| `REDIS_TEST_URL` | optional | empty | tests |
| `POSTGRES_TEST_URL` | optional | empty | tests |

S6 adds the six new `WORKER_*` names to `.env.example`, `turbo.json`, and worker Compose env; it
also passes the existing sale name/window/stock vars to the worker. No alternative spelling.
Compose worker healthcheck changes from `/health` to `/health/ready`; liveness remains manually
available at `/health`.

---

## 10. Health and observability

`GET /health`: exact Phase 0 liveness shape, always 200, no I/O.

`GET /health/ready`:

```jsonc
{
  "status": "ok" | "degraded",
  "service": "worker",
  "version": "0.0.0",
  "uptimeSeconds": 12.3,
  "checks": {
    "bootstrapReconciled": true,
    "consumerReady": true,
    "reconciliationHealthy": true,
    "lastReconciledAt": "2026-07-22T00:00:00.000Z",
    "lastDlqSweepAt": "2026-07-22T00:00:00.000Z",
    "activeJobs": 0,
    "failedJobs": 0
  }
}
```

200 only when the first full pass completed, consumer is ready, and the latest continuous pass
has not failed. `failedJobs > 0` is reported but does not by itself 503 while the DLQ sweep is
actively resolving them; malformed/unresolvable failed jobs do degrade.

Required structured event names: `order.persisted`, `order.idempotent`,
`order.persistence_conflict`, `order.failed`, `order.compensated`,
`order.compensation_noop`, `reconciliation.started`, `reconciliation.completed`,
`reconciliation.failed`, `reconciliation.enqueue_repaired`, `reconciliation.overcommitted`,
`worker.shutdown_started`, `worker.shutdown_completed`. Every order event includes saleId,
userId, reservationId, jobId, requestId, attempt number. Never log DB URLs, Redis URLs, raw job
objects, or stack traces in health responses.

---

## 11. Exact test contract

### 11.1 Unit floor

- Shared validator and job-ID tests, including hyphenated inputs and malformed/extra payload
  rejection.
- Producer still uses the shared name/options/helper and A4.2 generation tests remain green.
- Lua: ledger-only duplicate repairs buyers and never decrements; 200 concurrent attempts all
  `ALREADY_PURCHASED`; reconcile membership cannot remove a concurrent live reservation;
  HLEN-based stock reconcile includes a purchase serialized immediately before/after it;
  overcommitted performs no write.
- Repository: every §4.4 branch, guarded affected-row count, same-id insert-ack idempotency,
  compensated-old → current-new promotion, different persisted conflict, commit error thrown.
- Processor: wrong name/payload/options rejected; no compensation branch; errors reach BullMQ.
- Reconciler: single-flight/coalescing, bounded pages, exact queue-state matrix, job-ID/data
  mismatch, repeated HSCAN coverage, startup gating, timers unref/stop, and shutdown ordering.

### 11.2 Real-container integration harness

`apps/worker/test/global-setup.ts` starts Redis 7.4 and Postgres 16 once, applies the exact schema,
and exports URLs; supplied test URLs reuse external services. Integration config:

```ts
include: ['test/integration/**/*.integration.spec.ts']
globalSetup: './test/global-setup.ts'
testTimeout: 120_000
hookTimeout: 180_000
fileParallelism: false
pool: 'forks'
singleFork: true
```

No datastore-dependent skip and no ignored unhandled errors. Every test owns teardown.

### 11.3 Required failure-mode specs

1. **Normal + duplicate delivery:** one real job → one persisted row whose `id` equals payload
   reservationId; replay same payload/job processing → still one row and success.
2. **Insert-ack crash window:** child worker is killed after PG COMMIT but before BullMQ ack via a
   test-owned injectable post-commit barrier. Redelivery detects same persisted ID, does not
   compensate, and completes. Stock/buyer/ledger remain one active reservation.
3. **Postgres outage/recovery:** exhaust all five real BullMQ attempts while PG is unavailable;
   job reaches failed and reservation remains untouched. Restore PG; DLQ sweep takes the lock,
   compensates exactly once, writes compensated row, removes failed job, stock returns by one,
   buyer+ledger disappear.
4. **Crash during compensation:** stop after Redis compensation before PG COMMIT. Retry observes
   Lua NOOP, commits compensated row, then removes job; stock is not incremented twice.
5. **Persist-vs-compensate race:** barriers start persister and DLQ resolver for the same R.
   Advisory lock forces one terminal result: persisted with no compensation, or compensated with
   no persisted order; never persisted plus returned stock.
6. **Stale R1 after R2:** R1 compensated; user receives R2. Redelivered R1 compensation is NOOP,
   cannot remove R2, and gap repair clears the terminal R1 job-ID collision then persists R2.
7. **Enqueue-gap repair:** call real `store.purchase()` without queue add. Running worker remains
   up (no restart); continuous pass enqueues and persists the exact ledger identity.
8. **Warm reconciliation:** corrupt stock, remove a persisted user's buyer membership, retain a
   ledger-only pending reservation, and leave a matching queue job. Full pass restores membership,
   preserves pending identity, and atomically sets stock to `totalStock - HLEN`; no duplicate.
9. **Cold sale-key rebuild:** persist N orders, delete only `sale:{id}:*`, leave PG/BullMQ. Boot
   pass seeds config, restores N ledger/buyer identities, sets stock `total-N`, then starts the
   consumer. No job runs before reconciliation completes.
10. **Completed-without-PG repair:** create a completed matching job but delete its PG row while
    ledger survives. Reconciler removes/re-adds it and persistence lands.
11. **Unrecoverable/overcommitted fail closed:** buyer-only identity with no PG/queue/ledger and
    ledger count > total stock each produce readiness 503, no blind SREM/stock clamp.
12. **Graceful shutdown:** an active processor barrier proves SIGTERM stops new jobs, drains the
    active one, closes resources/listeners, and exits 0; a never-draining injected resource hits
    the 10s watchdog and exits 1 with no unhandled rejection.

### 11.4 Mandatory negative control

`apps/worker/test/support/unsafe-compensator.ts` deliberately omits the PG advisory lock. The
test harness coordinates: compensator reads “no row,” persister commits, unsafe compensator then
returns Redis stock. The spec must detect the forbidden combined state (persisted row plus
returned stock) and passes only when that violation is observed. The production locked path runs
the identical schedule and must make the violation impossible. No production source imports the
unsafe helper.

---

## 12. ADR summary

| Decision | Alternative rejected | Why |
|---|---|---|
| Failed BullMQ set + independent periodic resolver | compensate only in processor's last-attempt branch | Crash/max-stalled paths can reach failed without executing that branch; periodic failed-state inspection is the durable source. |
| PG advisory lock around persist/compensate decision | query PG then compensate without serialization | Leaves a cross-system race that can persist an order and return its stock. |
| `orders.id = reservationId` | unrelated DB-generated UUID | One identity must correlate Redis, queue, PG, logs, and stale compensation. |
| `ON CONFLICT DO NOTHING` then explicit adjudication | blind `DO UPDATE` | Blind updates can overwrite a different persisted reservation and violate I2. |
| Atomic stock from Redis HLEN | caller computes `total - PG count` | PG omits queued confirmations; caller computation inflates stock and races new purchases. |
| Repeated HSCAN/SSCAN repair | blocking whole-container reads or startup-only sweep | Bounded Redis work and eventual observation of stable entries; startup-only misses later enqueue gaps. |
| Keep sale-user job ID, inspect payload identity | silently change Phase 2 job IDs | Preserves the shipped producer contract while explicitly resolving the legitimate compensated/re-purchase collision. |
| Wait for PG before compensation | compensate on PG outage/unknown commit | An unknown committed insert plus returned stock violates I1/I4; failed job can safely wait. |

---

## 13. Verification and gate evidence

### 13.1 Implementer slice evidence

Each slice returns actual output for its focused commands, at minimum:

```bash
pnpm --filter @flash/shared lint
pnpm --filter @flash/shared typecheck
pnpm --filter @flash/shared test
pnpm --filter @flash/redis lint
pnpm --filter @flash/redis typecheck
pnpm --filter @flash/redis test
pnpm --filter @flash/api lint
pnpm --filter @flash/api typecheck
pnpm --filter @flash/api test
pnpm --filter @flash/worker lint
pnpm --filter @flash/worker typecheck
pnpm --filter @flash/worker test
pnpm --filter @flash/worker test:integration
pnpm --filter @flash/worker build
```

### 13.2 Orchestrator Phase 3 gate

Run from repo root with real output and Turbo cache bypassed:

```bash
pnpm install --frozen-lockfile
pnpm format:check
pnpm exec turbo run lint typecheck test build test:integration --force
pnpm audit --audit-level high
node scripts/assert-build-output.mjs apps/api/dist/main.js apps/worker/dist/main.js
docker compose -f infra/docker-compose.yml config
```

Required observed evidence:

- Turbo reports zero failed tasks and `Cached: 0 cached` for the forced graph.
- All twelve §11.3 real failure modes pass; the negative control demonstrably produces the
  forbidden state while production locking prevents it.
- Greps below are clean.
- An `adversarial-reviewer` attacks insert/ack, stalled jobs, PG-commit ambiguity, stale R1/R2,
  queue-ID collisions, reconciliation/purchase races, scan windows, retry storms, shutdown, and
  resource/listener leaks. Any critical finding returns to implementation; two repeats escalate
  to architect.

```bash
rg -n "reconcileStock\(" apps/worker/src                         # ZERO
rg -n "SMEMBERS|HGETALL|\bKEYS\b" apps/worker/src packages/redis/src # ZERO new blocking use; readMetrics exception is pre-existing
rg -n "removeOnFail:\s*true" apps/api apps/worker                # ZERO
rg -n "unsafe-compensator" apps/worker/src                       # ZERO
rg -n "dangerouslyIgnoreUnhandledErrors|onUnhandledError" apps/worker # ZERO
rg -n "from ['\"](?:\.\./)*apps/api|from ['\"].*apps/api" apps/worker packages/shared # ZERO
rg -n "buildOrdersJobId|PERSIST_ORDER_JOB_NAME|OrdersQueueJobPayload" apps/api apps/worker | rg "orders-queue.service" # imports may reference service class only; shared symbols must come from @flash/shared
```

Phase completion remains orchestrator-only: commit, annotated `phase-3-done` tag, then update
`STATE.md` with exact evidence and Phase 4 actions. Implementers and reviewers do not tag or edit
`STATE.md`.

---

## 14. Concrete implementation dispatch briefs

### Brief S1 — shared queue seam

Own only S1 paths. Load `turborepo-monorepo`, `bullmq-specialist`, `vitest`. Implement §3,
migrate every listed API source/test import, preserve A4.2 producer ownership, and return focused
shared/API lint/typecheck/unit output. Do not touch worker or lockfile.

### Brief S2 — Redis correctness primitives

Own only S2 paths. Load `redis-core`, `redis-connections`, `vitest`. Implement §5 exactly against
real Redis 7.4, including ledger-only duplicate concurrency and stock-reconcile interleavings.
Do not change existing compensation identity semantics. Return test output; datastore absence
must fail, never skip.

### Brief S3 — schema

Own only `infra/postgres/init/001_schema.sql`. Load `postgresql-table-design`. Implement §4.1,
validate by applying the whole file to fresh Postgres 16, and show `\d orders` plus constraint/
index queries. Do not add a migration framework or seed rows.

### Brief S4 — worker production slice

Own only S4 paths and `pnpm-lock.yaml`. Load all S4 skills. Implement §§4.2–4.4 and 6–10 with
unit tests. Consume only frozen shared/Redis exports. Install only project-local dependencies,
verify CommonJS `require` export conditions per Phase 2 A1, and preserve unrelated changes.
Return exact unit/typecheck/lint/build output and any escalation; do not edit integration/infra.

### Brief S5 — failure-mode proof

Own only S5 paths. Load all S5 skills. Implement §11 with real BullMQ, Redis 7.4, and Postgres 16;
no app.inject, fake datastore, skipped outage, or ignored unhandled error. Test-only barriers may
be injected through frozen interfaces but production behavior is not altered for tests. Return
the named result of every failure scenario and the negative control.

### Brief S6 — runtime wiring

Own only S6 paths. Load `multi-stage-dockerfile`, `turborepo-monorepo`. Wire §9, change Compose
worker health to `/health/ready`, run `docker compose ... config`, and do not change application
logic or dependencies.

---

## 15. AMENDMENT A1 — API purchase-status fixture schema alignment

**Authority:** ARCHITECT · **Version:** A1 · **Date:** 2026-07-23 · **Status:** FROZEN
**Amends:** §2 and §14 ownership only. The Phase 3 schema and application behavior are unchanged.

### 15.1 Gate finding and decision

The forced Phase 3 graph reached the API integration suite with **70 passing / 2 failing** tests.
Both failures are fixture drift in
`apps/api/test/integration/purchase-status.integration.spec.ts`: its persisted and compensated
fixtures still use the Phase 0 `orders` insert shape and omit columns that Phase 3 §4.1 correctly
makes required (`id`, `created_at`, and `request_id`). No frozen S1–S6 row owns this file, so an
implementer may not fix it until this amendment assigns ownership.

**Decision:** add one narrow corrective slice **S7** owning that test file only. Do not weaken the
schema with defaults or nullable columns. `orders.id` is reservation identity across Redis,
BullMQ, Postgres, and compensation; `request_id` is required correlation; `created_at` is the
reservation timestamp exposed by the status API. Making any of them optional merely to preserve
an obsolete fixture would weaken the Phase 3 durability contract.

This is test-fixture compatibility work. It changes no production source, DDL, response shape,
queue behavior, Redis state, or invariant enforcement.

### 15.2 S7 exclusive ownership

Agent role: `implementer` (Terra/Sonnet-mapped).

Required skills: `vitest`, `postgresql-table-design`.

```
apps/api/test/integration/purchase-status.integration.spec.ts   ~  S7 ONLY
```

Every other path is forbidden, including `infra/postgres/init/001_schema.sql`, all
`apps/api/src/**`, all worker/shared/Redis paths, `pnpm-lock.yaml`, `.env.example`, `turbo.json`,
`infra/docker-compose.yml`, `.claude/contracts/**`, `STATE.md`, and `.codex/`.

S7 starts only after S3's schema is present and after S1's API test migration has settled. It is
otherwise independent of S4–S6 and may run as soon as the current gate failure is reproduced.
Because the shared working tree already contains Phase 3 work, S7 preserves all unrelated edits
and does not format or rewrite files outside its one owned path.

### 15.3 Exact fixture semantics

Keep the two existing sale inserts and all HTTP assertions unchanged. Change only the two
`orders` fixture inserts so they satisfy the final schema explicitly.

**Persisted fixture** (`user_id = 'persisted-2026'`):

```sql
INSERT INTO orders
  (id, user_id, sale_id, status, created_at, persisted_at, request_id)
VALUES
  ($1, $2, $3, 'persisted', now(), now(), $4)
```

Parameters, in order:

```ts
[
  '00000000-0000-4000-8000-000000000052',
  'persisted-2026',
  harness.saleId,
  'fixture-persisted-2026',
]
```

This row must have non-null `persisted_at`, satisfying `orders_persisted_at_state`. The existing
test must continue proving `purchased === true`, status `persisted`, and non-null `createdAt`.

**Compensated fixture** (`user_id = 'compensated-2026'`):

```sql
INSERT INTO orders
  (id, user_id, sale_id, status, created_at, persisted_at, request_id)
VALUES
  ($1, $2, $3, 'compensated', now(), NULL, $4)
```

Parameters, in order:

```ts
[
  '00000000-0000-4000-8000-000000000074',
  'compensated-2026',
  harness.saleId,
  'fixture-compensated-2026',
]
```

This row must keep `persisted_at IS NULL`, satisfying `orders_persisted_at_state`. The existing
test must continue proving `purchased === false` and status `compensated`.

The two UUIDs and request IDs above are fixed, valid, distinct fixture identities. Do not restore
database-generated IDs, add test-only schema defaults, use `gen_random_uuid()`, or derive values
from wall-clock/random helpers. Deterministic fixtures make failures reproducible and prove the
caller supplies reservation identity as Phase 3 requires.

### 15.4 S7 done criteria and dispatch brief

**Exact dispatch brief:**

> Own only `apps/api/test/integration/purchase-status.integration.spec.ts`. You are not alone in
> the working tree; preserve every unrelated Phase 3 edit and do not revert or reformat other
> files. Load `vitest` and `postgresql-table-design`. Reproduce the two failing inserts against
> the Phase 3 schema, then implement §15.3 exactly: explicit deterministic UUID `id`, explicit
> `created_at`, state-correct `persisted_at`, and explicit deterministic `request_id` for the
> persisted and compensated fixtures. Keep the sale inserts and all endpoint assertions
> unchanged. Do not edit production code, schema, shared/Redis/worker code, lockfile, env,
> Compose, contract, STATE, tags, commits, or `.codex/`. Return actual output for every command
> below.

Required evidence:

```bash
pnpm --filter @flash/api exec vitest run --config vitest.integration.config.ts \
  test/integration/purchase-status.integration.spec.ts
pnpm --filter @flash/api test:integration
pnpm --filter @flash/api lint
pnpm --filter @flash/api typecheck
pnpm exec prettier --check apps/api/test/integration/purchase-status.integration.spec.ts
```

The focused file must report **6/6 passing**. The full API integration suite must report **72/72
passing** with zero unhandled errors. Lint, typecheck, and formatting must exit 0. After S7 passes,
the orchestrator reruns the unchanged §13.2 full Phase 3 gate; S7 does not certify or tag the
phase itself.

### 15.5 Invariant effect

- **I1:** unchanged; the fixture performs no Redis stock operation.
- **I2:** preserved; both deterministic users remain distinct and the production unique index is
  not weakened.
- **I3:** unchanged; no purchase decision or window logic changes.
- **I4:** strengthened as evidence: fixtures now exercise the same required durable reservation
  identity and request correlation as worker-written rows instead of bypassing them through an
  obsolete insert shape.

---

## 16. AMENDMENT A2 — terminal DLQ semantics, identity CAS, fairness, and executable proofs

**Authority:** ARCHITECT · **Version:** A2 · **Date:** 2026-07-23 · **Status:** FROZEN
**Amends:** §§2, 5, 7, 8, 11, 13, and 14. **A1 remains unchanged.**

### 16.1 Adversarial findings and decisions

The Phase 3 adversarial review rejected the implementation on five contract-level ambiguities:

1. §7.2 required `attemptsMade >= 5`, while §6.4 also configured BullMQ
   `maxStalledCount = 2`. BullMQ 5.80.9 can terminally fail a repeatedly stalled job with fewer
   than five processor attempts, so the old gate could retain a genuine terminal job forever.
2. Phase 1's additive `restoreReservations()` unconditionally writes `HSET`. A stale R1 recovery
   candidate can therefore overwrite a live R2 ledger identity before later code notices the
   conflict, re-arming stale compensation and violating I1/I2/I4.
3. Every DLQ sweep fetched failed indexes `0..pageSize-1`. A retained malformed job at the head
   can be inspected forever while valid terminal jobs beyond the first page are never visited.
4. §11.3's shutdown test used a hand-written signal snippet rather than the production
   `installProcessHandlers()` and did not prove Nest/Fastify/Redis/BullMQ/Postgres closure.
5. The safe and unsafe advisory-lock tests did not execute one identical, deterministic barrier
   schedule, so timing differences—not the lock—could explain the result.

A2 resolves all five without weakening the schema, queue durability, compensation identity, or
the four invariants. Implementation follows the exact corrective ownership and order in §16.8.

---

### 16.2 Terminal failed-job eligibility — BullMQ 5.80.9

#### 16.2.1 Frozen constants

`apps/worker/src/orders/orders.consumer.ts` exports and uses:

```ts
export const ORDERS_MAX_STALLED_COUNT = 2 as const;
export const BULLMQ_MAX_STALLED_FAILED_REASON =
  'job stalled more than allowable limit' as const;
```

The Worker option `maxStalledCount` must reference `ORDERS_MAX_STALLED_COUNT`; the literal may not
be duplicated. `lockDuration` and `stalledInterval` remain 30,000ms.

The exact reason is pinned to installed `bullmq@5.80.9`'s
`moveStalledJobsToWait-9.lua`. A BullMQ upgrade that changes this string or terminal mechanism is
a contract escalation, not permission to use substring matching.

#### 16.2.2 Exact predicate

A job is eligible for durable terminal resolution only after all structural validation succeeds:

- it was fetched from the `failed` set and `await job.getState()` still equals `'failed'`;
- `job.name === PERSIST_ORDER_JOB_NAME`;
- `assertOrdersQueueJobPayload(job.data)` succeeds;
- `job.id === buildOrdersJobId(job.data.saleId, job.data.userId)`;
- `job.opts.attempts === ORDERS_JOB_ATTEMPTS` (exactly 5); and
- one of the following **two and only two** terminal causes is true:

```ts
const retryExhausted = job.attemptsMade >= ORDERS_JOB_ATTEMPTS;

const maxStalled =
  job.failedReason === BULLMQ_MAX_STALLED_FAILED_REASON &&
  job.stalledCounter > ORDERS_MAX_STALLED_COUNT;

const terminalEligible = retryExhausted || maxStalled;
```

`attemptsMade < 5` is therefore legal only on the exact max-stalled branch. A generic early
failure, `UnrecoverableError`, malformed options, unknown failed reason, or a job that moved out
of `failed` is **not** safe evidence of retry exhaustion/max-stall; it remains retained and makes
readiness degraded. Never infer terminality from `failedReason` containing `stall`, from a failed
event alone, or from `stalledCounter` without the exact reason.

Once eligible, the existing §7.2 PG-advisory-lock resolution is mandatory. A max-stalled job is
not blindly compensated: the resolver first detects a matching persisted row, closing the
crash-after-commit/max-stall window exactly like normal retry exhaustion.

Required unit matrix:

| State | attemptsMade | stalledCounter | failedReason | Eligible? |
|---|---:|---:|---|---|
| failed | 5 | 0 | ordinary PG error | yes — retry exhausted |
| failed | 7 | 0 | ordinary PG error | yes — defensive `>=` |
| failed | 0–4 | 3 | exact max-stalled reason | yes — max stalled |
| failed | 0–4 | 2 | exact max-stalled reason | no |
| failed | 0–4 | 3 | any other/substr reason | no |
| waiting/delayed/active | any | any | any | no, even if stale scan object says otherwise |
| failed | any | any | any | no when `opts.attempts !== 5` |

The real integration proof must create a Worker with a deliberately lost lock and the production
`maxStalledCount`; the resulting failed job must have fewer than five attempts, the exact reason,
`stalledCounter > 2`, and must still reach persisted-detected or compensated terminal resolution.

---

### 16.3 Atomic compare-and-restore reservation primitive

#### 16.3.1 Public interface and result

S2 adds these exports to `@flash/redis`:

```ts
export type CompareRestoreReservationOutcome =
  | 'RESTORED'
  | 'ALREADY_MATCHED'
  | 'CONFLICT';

export interface CompareRestoreReservationInput {
  userId: string;
  reservationId: string;
  reservedAtMs: number; // finite safe integer >= 0; required, never Date.now default
}

export interface CompareRestoreReservationResult {
  outcome: CompareRestoreReservationOutcome;
  current: ReservationEntry | null;
}

SaleRedisStore.prototype.compareAndRestoreReservation(
  saleId: string,
  input: CompareRestoreReservationInput,
): Promise<CompareRestoreReservationResult>;
```

`current` is the post-decision ledger entry: the restored/matching candidate on success, or the
pre-existing different identity on conflict. Malformed stored ledger data throws; it is never
reported as a candidate match.

#### 16.3.2 `compare-restore-reservation.lua.ts`

Registry name: `COMPARE_RESTORE_RESERVATION_SCRIPT`; `numKeys: 2`. Keys, in this exact order,
share the sale hash tag:

1. `sale:{id}:buyers`
2. `sale:{id}:reservations`

ARGV: `userId`, `reservationId`, canonical decimal `reservedAtMs`.

```lua
local current = redis.call('HGET', KEYS[2], ARGV[1])
local candidate = ARGV[2] .. ':' .. ARGV[3]

if not current then
  redis.call('HSET', KEYS[2], ARGV[1], candidate)
  redis.call('SADD', KEYS[1], ARGV[1])
  return {'RESTORED', candidate}
end

local separator = string.find(current, ':', 1, true)
local currentId = separator and string.sub(current, 1, separator - 1) or current

if currentId == ARGV[2] then
  redis.call('SADD', KEYS[1], ARGV[1])
  return {'ALREADY_MATCHED', current}
end

return {'CONFLICT', current}
```

Binding properties:

- `CONFLICT` performs **zero writes**. Stale R1 cannot overwrite or mutate live R2.
- `ALREADY_MATCHED` repairs missing buyers membership but preserves the ledger's original
  `reservedAtMs`; a reconciliation timestamp cannot rewrite purchase history.
- `RESTORED` writes ledger before membership in the same atomic script execution.
- Inputs are validated like purchase payload identities. `reservedAtMs` has no fallback.

`restoreReservations()` remains exported for Phase 1 compatibility and its historical tests, but
**A2 supersedes every Phase 3 worker use of it.** After S4, this grep must return zero:

```bash
rg -n "restoreReservations\(" apps/worker/src
```

#### 16.3.3 Worker conflict handling

Every PG/job/buyer recovery candidate is applied one at a time through
`compareAndRestoreReservation`; no worker pipeline performs direct `HSET`.

- `RESTORED` / `ALREADY_MATCHED`: continue normally.
- Candidate is a persisted PG row and result is `CONFLICT` with live R2: preserve R2. Ensure R2
  has matching queue work (enqueue repair if absent) so normal persistence conflict → failed-set
  resolution compensates R2 under its own identity. Mark the pass unhealthy until R2 is terminal;
  a later pass restores persisted R1.
- Candidate is a queue job R1 and current is different R2: never restore R1. If PG durably marks
  R1 compensated, the retained job is historical collision cleanup; otherwise report conflicting
  active identities and keep readiness degraded.
- Buyer-only recovery uses the same rules. An unidentifiable buyer remains fail-closed as §8.2
  already requires.

No branch may respond to `CONFLICT` by calling legacy `restoreReservations`, `HSET`, compensating
the current ledger identity with the candidate ID, or deleting the current buyer.

Required Redis proof against real Redis 7.4:

1. missing → `RESTORED`, exact ledger + buyer;
2. same identity/different candidate timestamp → `ALREADY_MATCHED`, original timestamp retained;
3. R2 present then stale R1 → `CONFLICT`, byte-identical R2 ledger/buyer/stock;
4. 200 concurrent stale R1 restores against R2 → 200 `CONFLICT`, R2 unchanged;
5. compare/restore racing a real purchase serializes to one identity without stock inflation or
   buyer loss.

---

### 16.4 Fair, bounded failed-set traversal

`ReconciliationService` owns an in-memory `failedScanOffset`, initialized to `0`. Each
single-flight DLQ sweep performs this exact algorithm:

1. Read `totalBefore = await queue.getFailedCount()`. If zero, set offset 0 and finish.
2. `start = failedScanOffset % totalBefore`. Fetch ascending failed jobs at
   `[start, start + WORKER_DLQ_SCAN_COUNT - 1]`.
3. If the page is empty because concurrent removals invalidated the offset, reset `start=0` and
   fetch the first page **once**. Thus a sweep issues at most two failed-page reads.
4. Process every returned job independently. One malformed/unresolvable job records an error and
   degrades readiness but does not break the loop. Track `removedCount` only after `job.remove()`
   succeeds.
5. Read `totalAfter = await queue.getFailedCount()` and advance:

```ts
if (totalAfter === 0) failedScanOffset = 0;
else if (removedCount > 0) failedScanOffset = Math.min(start, totalAfter - 1);
else failedScanOffset = (start + page.length) % totalAfter;
```

Keeping the same start after removals visits jobs shifted into the vacated indexes; advancing
when none were removed walks past retained malformed heads. New failed jobs append in BullMQ's
failed ordering and are reached on a later wrap. Work per sweep stays bounded by the configured
page size (plus one empty-page retry), while every member of a stable finite failed set is
eventually visited. The cursor resets on process restart; periodic sweeps resume rotation.

Required unit/fake proof with `WORKER_DLQ_SCAN_COUNT=2`:

- two retained malformed head jobs plus five valid terminal jobs;
- run repeated sweeps without changing malformed jobs;
- every valid job is visited and removed; both malformed jobs remain and readiness is degraded;
- no sweep processes more than two jobs or makes more than two page reads;
- offset wraps and later-added tail jobs are visited;
- concurrent removal producing an empty page triggers exactly one reset fetch, never a loop.

Required real BullMQ proof repeats the retained-malformed-head scenario and asserts a valid job
beyond page one reaches compensation/persisted detection within bounded repeated sweeps.

---

### 16.5 Production process shutdown proof and handler seam

#### 16.5.1 Production API

`apps/worker/src/main.ts` exports `bootstrap`, `shutdown`, and `installProcessHandlers`. Production
execution (`require.main === module`) still invokes `installProcessHandlers()` and then
`bootstrap()` exactly once.

Freeze:

```ts
export const WORKER_SHUTDOWN_WATCHDOG_MS = 10_000 as const;

export interface ProcessHandlerOptions {
  shutdownFn?: (exitCode: number) => Promise<void>; // default: production shutdown
  watchdogMs?: number;                              // default: 10_000
}

export function installProcessHandlers(options?: ProcessHandlerOptions): void;
```

The optional seam has no `NODE_ENV` branch and is used only from a subprocess test. Invalid or
non-positive `watchdogMs` throws synchronously. The default path is the production shutdown
function and 10-second watchdog. Signal handling remains single-entry/idempotent. Clean
SIGTERM/SIGINT clears the watchdog and permits exit code 0; fatal/unhandled paths exit 1.

`shutdown()` must not merely close the consumer. It awaits reconciliation stop, consumer drain,
and `application.close()`, thereby invoking real Nest shutdown hooks, including InfraModule's
BullMQ admin, Redis clients, PG pool, and Fastify listener closure. Resource close methods remain
idempotent; failures flow to exit 1 rather than being swallowed into a false clean exit.

#### 16.5.2 Required subprocess integrations

S5 builds the real worker first, then spawns the actual `apps/worker/dist/main.js` with the
Testcontainers Redis/Postgres URLs, a unique queue/sale, and a free health port.

**Clean production SIGTERM proof:**

1. Wait for `/health/ready` 200—proving real Nest, Fastify, reconciliation, consumer, Redis, and
   Postgres initialized.
2. Submit one real order and wait until it is terminal or the worker is idle.
3. Send SIGTERM to that process; assert exit code **0** before 10 seconds.
4. Assert captured output contains `worker.shutdown_started` and `worker.shutdown_completed` and
   contains no unhandled rejection/error.
5. Assert the health port refuses a new connection after exit.
6. From independent test clients, assert no Redis `CLIENT LIST` entry remains with
   `flash-worker-store`, `flash-worker-consumer`, or `flash-worker-admin`; no PG
   `pg_stat_activity` row remains with `application_name='flash-worker'`; queue active count is 0.

This test must invoke the production `require.main` path; a mocked Nest application or direct
`consumer.close()` is not equivalent.

**Watchdog proof:** spawn a separate Node child that imports built `main.js`, calls the real
`installProcessHandlers({ shutdownFn: neverSettlingPromise, watchdogMs: 250 })`, signals READY,
then receives SIGTERM. Assert exit code 1 within 2 seconds. Also unit-assert the production default
constant remains 10,000. The watchdog child may shorten the injected deadline; it may not
reimplement the handler logic as an inline signal listener.

Verification is sequential so built production output is guaranteed:

```bash
pnpm --filter @flash/worker build
pnpm --filter @flash/worker test:integration
```

---

### 16.6 Deterministic identical advisory-lock race schedule

#### 16.6.1 Shared hook/barrier contract

S4 adds optional, default-no-op hooks to `OrderRepository` methods; they are dependency-injected
arguments, not environment branches and do not alter production ordering:

```ts
export interface AdvisoryRaceHooks {
  afterResolverAbsentRead?: () => Promise<void>;
  beforePersisterAdvisoryLock?: (backendPid: number) => Promise<void>;
  afterPersisterCommit?: () => Promise<void>;
}
```

- Safe `resolveFailed(..., hooks?)` calls `afterResolverAbsentRead` only after acquiring the
  reservation advisory xact lock and reading no user row, immediately before Redis compensation.
- `persist(payload, hooks?)` queries `pg_backend_pid()`, calls `beforePersisterAdvisoryLock(pid)`
  immediately before its reservation lock query, and calls `afterPersisterCommit` only after
  COMMIT succeeds.
- Normal production calls omit hooks. Hook rejection aborts/rolls back like any owned operation.
- The unsafe compensator accepts the same `AdvisoryRaceHooks` and calls
  `afterResolverAbsentRead` at the identical semantic point after its unlocked absence read.

`apps/worker/test/support/advisory-race-barrier.ts` owns one reusable runner; safe and unsafe tests
may pass only the resolver function. The orchestration code is otherwise byte-identical:

1. Start resolver; wait for `afterResolverAbsentRead`.
2. Start the same production `persist(payload, hooks)` contender.
3. After `beforePersisterAdvisoryLock(pid)`, poll `pg_stat_activity` for that exact PID.
4. Wait for exactly one deterministic observation:
   - `afterPersisterCommit` fires (unsafe resolver held no lock), or
   - that PID reports `wait_event_type='Lock'` and `wait_event='advisory'` (safe resolver holds
     the lock).
5. Release the resolver barrier, then await both actors and read PG/Redis terminal state.

There are no sleeps, arbitrary “give it time” windows, fake repositories, or different callback
ordering between safe and unsafe runs. Polling is condition-based with one overall test timeout.

Expected results under the identical runner:

- **Unsafe:** persister COMMIT is observed first; releasing the unlocked resolver then returns R
  stock, yielding the deliberately forbidden negative-control state (persisted R plus returned
  stock). The test passes only if it detects that violation.
- **Safe:** advisory wait is observed first; releasing the resolver compensates/commits while
  holding the lock, after which persister sees the compensated row and cannot resurrect it. Final
  state is compensated with stock returned exactly once and no persisted order.

This proves the lock—not scheduler luck—is the discriminating variable.

---

### 16.7 Corrective exclusive ownership

These rows temporarily re-open only original S2/S4/S5-owned files. No other Phase 3 path is
authorized.

#### A2-S2 — Redis identity CAS

Required skills: `redis-core`, `redis-connections`, `vitest`.

```
packages/redis/src/types.ts                                  ~
packages/redis/src/index.ts                                  ~
packages/redis/src/sale-store.ts                             ~
packages/redis/src/scripts/registry.ts                       ~
packages/redis/src/scripts/registry.spec.ts                  ~
packages/redis/src/scripts/compare-restore-reservation.lua.ts +
packages/redis/src/sale-store.reconcile.spec.ts              ~
```

Own only these paths. Implement §16.3 exactly. Do not change purchase/compensate/reconcile-state
semantics, worker code, integration tests, schema, shared queue contract, lockfile, env, Compose,
STATE, contracts, or `.codex/`.

#### A2-S4 — worker terminality, fairness, CAS use, hooks, and production handlers

Required skills: `bullmq-specialist`, `redis-core`, `redis-connections`,
`postgresql-table-design`, `nestjs-best-practices`, `vitest`.

```
apps/worker/src/orders/orders.consumer.ts                    ~
apps/worker/src/orders/orders.consumer.spec.ts               ~
apps/worker/src/orders/order.repository.ts                   ~
apps/worker/src/orders/order.repository.spec.ts              ~
apps/worker/src/reconciliation/reconciliation.service.ts     ~
apps/worker/src/reconciliation/reconciliation.service.spec.ts ~
apps/worker/src/main.ts                                      ~
apps/worker/src/infra/infra.module.ts                        ~
apps/worker/src/infra/infra.module.spec.ts                   ~
```

Own only these paths. Implement §§16.2, 16.3.3, 16.4, 16.5.1, and 16.6.1 with unit tests. Do not
edit S2, integration, harness, unsafe helper, health/config/module wiring, dependencies/lockfile,
schema, env, Compose, API/shared, STATE, contracts, or `.codex/`.

#### A2-S5 — real regressions and negative control

Required skills: `bullmq-specialist`, `redis-core`, `redis-connections`,
`postgresql-table-design`, `vitest`.

```
apps/worker/test/integration/failure-modes.integration.spec.ts ~
apps/worker/test/support/harness.ts                            ~
apps/worker/test/support/unsafe-compensator.ts                 ~
apps/worker/test/support/advisory-race-barrier.ts              +
```

Own only these paths. Implement the real max-stalled, malformed-head fairness, production
SIGTERM/watchdog, and identical safe/unsafe barrier proofs in §§16.2, 16.4, 16.5.2, and 16.6. Do
not edit production source, S2, configs, schema, dependencies/lockfile, env, Compose, API/shared,
STATE, contracts, or `.codex/`.

All three agents preserve unrelated shared-worktree edits and never revert another slice.

### 16.8 Sequence and exact dispatch briefs

**Strict sequence:** A2-S2 → A2-S4 → A2-S5. No A2 corrective slice runs in parallel: S4 consumes
S2's frozen CAS interface, and S5 consumes both production implementations.

#### Dispatch A2-S2

> Own only the A2-S2 paths in §16.7. Load `redis-core`, `redis-connections`, and `vitest`.
> Implement the exact `compareAndRestoreReservation` types, Lua script, registry/export/store
> decoding, validation, and real-Redis cases in §16.3. Preserve all unrelated work and existing
> compensation/purchase semantics. Do not touch worker, integration, schema, shared, lockfile,
> env, Compose, contract, STATE, git metadata, or `.codex/`. Return actual output for:

```bash
pnpm --filter @flash/redis lint
pnpm --filter @flash/redis typecheck
pnpm --filter @flash/redis test
pnpm exec prettier --check \
  packages/redis/src/types.ts \
  packages/redis/src/index.ts \
  packages/redis/src/sale-store.ts \
  packages/redis/src/scripts/registry.ts \
  packages/redis/src/scripts/registry.spec.ts \
  packages/redis/src/scripts/compare-restore-reservation.lua.ts \
  packages/redis/src/sale-store.reconcile.spec.ts
```

#### Dispatch A2-S4

> Start only after A2-S2 is green. Own only the A2-S4 paths in §16.7. Load
> `bullmq-specialist`, `redis-core`, `redis-connections`, `postgresql-table-design`,
> `nestjs-best-practices`, and `vitest`. Implement §§16.2, 16.3.3, 16.4, 16.5.1, and 16.6.1:
> exact retry/max-stalled eligibility, rotating fair bounded failed traversal, exclusive CAS
> restoration use and conflict handling, real process-handler seam/default watchdog, and the
> shared advisory-race hooks. Preserve all unrelated work. Do not touch Redis-owned files,
> integration/harness, dependencies, schema, env, Compose, API/shared, contract, STATE, git
> metadata, or `.codex/`. Return actual output for:

```bash
pnpm --filter @flash/worker lint
pnpm --filter @flash/worker typecheck
pnpm --filter @flash/worker test
pnpm --filter @flash/worker build
pnpm exec prettier --check \
  apps/worker/src/orders/orders.consumer.ts \
  apps/worker/src/orders/orders.consumer.spec.ts \
  apps/worker/src/orders/order.repository.ts \
  apps/worker/src/orders/order.repository.spec.ts \
  apps/worker/src/reconciliation/reconciliation.service.ts \
  apps/worker/src/reconciliation/reconciliation.service.spec.ts \
  apps/worker/src/main.ts \
  apps/worker/src/infra/infra.module.ts \
  apps/worker/src/infra/infra.module.spec.ts
rg -n "restoreReservations\(" apps/worker/src # ZERO
```

#### Dispatch A2-S5

> Start only after A2-S4 is green and built. Own only the A2-S5 paths in §16.7. Load
> `bullmq-specialist`, `redis-core`, `redis-connections`, `postgresql-table-design`, and `vitest`.
> Implement the real BullMQ max-stalled terminal case, retained-malformed-head traversal, actual
> built production SIGTERM exit-0/resource-closure proof, real `installProcessHandlers` watchdog
> child, and one shared condition-driven advisory race runner used unchanged by safe and unsafe
> cases. No sleeps/fake datastore/inline replacement signal handler/ignored unhandled errors.
> Preserve unrelated work. Do not edit production source, Redis, schema, config, dependencies,
> env, Compose, API/shared, contract, STATE, git metadata, or `.codex/`. Return actual output for:

```bash
pnpm --filter @flash/worker build
pnpm --filter @flash/worker test:integration
pnpm exec prettier --check \
  apps/worker/test/integration/failure-modes.integration.spec.ts \
  apps/worker/test/support/harness.ts \
  apps/worker/test/support/unsafe-compensator.ts \
  apps/worker/test/support/advisory-race-barrier.ts
```

### 16.9 A2 gate and invariant evidence

After A2-S5, the orchestrator reruns the unchanged §13.2 forced Phase 3 gate and a fresh
adversarial review. Additionally required:

```bash
rg -n "restoreReservations\(" apps/worker/src                    # ZERO
rg -n "attemptsMade\s*<\s*ORDERS_JOB_ATTEMPTS" apps/worker/src # ZERO old contradictory gate
rg -n "process\.once\(['\"]SIGTERM" apps/worker/test            # ZERO inline replacement handlers
```

Evidence must name:

- max-stalled terminal resolution with `attemptsMade < 5`, exact BullMQ reason, and counter >2;
- 200 concurrent stale R1 CAS conflicts leaving R2 byte-identical;
- valid tail DLQ jobs resolved behind retained malformed heads with bounded page reads;
- actual built worker SIGTERM exit 0 plus Fastify/Redis/BullMQ/PG closure and real watchdog exit 1;
- identical barrier runner: unsafe forbidden state detected, safe state serialized;
- zero skipped datastore tests and zero unhandled errors.

Invariant effect:

- **I1:** CAS prevents stale identity overwrite; advisory proof prevents persisted-plus-returned
  stock; terminal resolver still checks PG before compensation.
- **I2:** live R2 buyer/ledger identity cannot be replaced by stale R1; PG unique index remains.
- **I3:** unchanged; no purchase window semantics change.
- **I4:** max-stalled and tail failed jobs can no longer remain invisible forever; real shutdown
  proves owned in-flight work/resources reach a bounded terminal process outcome.

## 17. AMENDMENT A3 — non-blocking boot classification and identity-specific collision repair

**Authority:** ARCHITECT · **Version:** A3 · **Date:** 2026-07-23 · **Status:** FROZEN
**Escalation:** mandatory AGENTS §8 architecture escalation after two adversarial-review failures.
**Amends:** §§8, 13, 16.3.3, 16.4, 16.7–16.9. A1 and A2 remain binding except where A3
explicitly supersedes them.

### 17.1 Reproduced failures and decisions

The final A2 review established two critical failures in the implemented control flow:

1. `start()` calls the boot `runDiff()` before starting the consumer or installing DLQ timers.
   `scanJobs()` hard-asserts every payload, so one retained malformed failed job throws before
   the later DLQ sweep. Boot retries forever; the rotating failed cursor never runs and a valid
   terminal job behind the malformed entry cannot resolve.
2. With PG-persisted R1, a retained completed R1 job, and newly Redis-confirmed R2 after partial
   Redis loss, the persisted-candidate CAS conflict sees `currentJobs.length > 0` and suppresses
   R2 repair even though the only job is R1. The later ledger repair also rejects completed R1
   because R1 is persisted rather than compensated. R2 remains confirmed without a usable queue
   path, violating I4.

A3 makes two decisions:

- Queue-entry data quality is **retained and readiness-degrading**, but is not an operational boot
  exception. Valid entries in the same bounded pages continue through reconciliation and DLQ.
- Queue coverage and collision cleanup are decided by exact `reservationId`, never merely by
  `userId`, job presence, or deterministic `jobId`. A completed job for durable winner R1 is
  historical evidence for R1, not queue coverage for live R2.

No schema, Redis Lua, queue payload, deterministic job-ID, environment-variable, dependency, or
API contract changes are authorized by A3.

---

### 17.2 Queue-entry classification and bounded scanning

#### 17.2.1 Frozen internal taxonomy

`apps/worker/src/reconciliation/reconciliation.service.ts` defines these internal types (they need
not be exported from the package):

```ts
type QueueEntryIssueCode =
  | 'UNEXPECTED_NAME'
  | 'INVALID_PAYLOAD'
  | 'JOB_ID_MISMATCH';

interface QueueEntryIssue {
  jobId: string | null;
  state: JobType;
  code: QueueEntryIssueCode;
  message: string;
}

interface QueueScanResult {
  jobs: ScannedJob[];
  issues: QueueEntryIssue[];
}

interface DlqSweepResult {
  retainedUnsafeCount: number;
  removedCount: number;
}

interface ReconciliationPassResult {
  degraded: boolean;
  queueIssueCount: number;
}
```

These are two distinct error classes:

- **Retained queue-entry incident:** unexpected name, invalid payload, job ID/data mismatch,
  unsupported retry options, or a failed job that is not terminally eligible. It is untrusted
  evidence, so it is excluded from `jobsByUser`, never removed or rewritten, logged as
  `reconciliation.queue_entry_retained`, and degrades readiness. It does **not** throw from the
  scan/sweep and does not abort startup.
- **Operational/invariant failure:** Redis/BullMQ/Postgres command failure, configuration drift,
  active-drain timeout, overcommit, buyer-only identity with no authoritative recovery source,
  failed compensation/resolution, or an unsafe live identity collision. It still throws. During
  boot, `start()` retries with the existing bounded backoff and keeps the consumer paused.

`scanJobs()` returns `QueueScanResult`. For each queue state and each page, it classifies every job
inside an individual `try/catch`; one invalid job cannot terminate the page loop or suppress later
states/pages. Only valid `persist-order` jobs with a valid payload and exact
`buildOrdersJobId(saleId, userId)` enter `jobs`.

All queue reads remain bounded:

- every `queue.getJobs()` uses an inclusive window of at most
  `WORKER_RECONCILE_SCAN_COUNT` entries;
- every failed-only DLQ read uses at most `WORKER_DLQ_SCAN_COUNT` entries and the A2 one-reset
  maximum;
- `end = -1`, whole-queue `getJobs`, `KEYS`, `SMEMBERS`, and equivalent unbounded reads are
  forbidden;
- pages are consumed/classified before the next page is requested. Invalid payload bodies are not
  accumulated beyond their small `QueueEntryIssue` metadata.

The scan may visit all finite pages to construct the reconciliation snapshot, but it may never
issue an unbounded Redis command. The existing single-flight guard prevents concurrent full
passes; the configured intervals prevent a retry storm.

#### 17.2.2 DLQ retained-incident semantics

A3 supersedes A2 §16.4's final throw for structurally invalid/nonterminal failed entries.
`sweepFailed()` still processes every job in its page independently and advances the rotating
cursor exactly as A2 specifies, but returns `DlqSweepResult` when entries are merely retained as
unsafe. It throws only after attempting the rest of the page if a valid terminal job's PG/Redis
resolution or a BullMQ operation failed.

Consequences:

- malformed/nonterminal failed jobs remain in BullMQ and keep readiness degraded;
- valid terminal jobs behind them are visited on later bounded sweeps and removed after safe
  persisted detection or compensation;
- a retained malformed job is never treated as evidence for a user/reservation and never enters
  collision cleanup;
- restarting resets the in-memory cursor to zero, but repeated periodic sweeps again rotate past
  retained heads.

---

### 17.3 Startup and readiness state machine

`runDiff()` returns `ReconciliationPassResult`. A pass with only retained queue-entry incidents
finishes all safe work, stock reconciliation, and the bounded DLQ sweep, then returns
`degraded: true`; it does not throw. Existing fatal conditions from §17.2.1 still throw.

`ReconciliationState` adds:

```ts
retainedQueueEntries: number;
```

`createReconciliationState()` initializes it to `0`. It is internal health evidence; the HTTP
response schema does not change.

Boot executes in this exact order:

1. Pause the admin queue and drain active jobs under the existing session reconciliation lock.
2. Validate/seed sale configuration.
3. Run the full paginated diff. Classify retained entries, execute safe repairs, and perform one
   bounded failed sweep.
4. On an operational/invariant exception, keep `bootstrapReconciled=false`, keep the queue paused,
   set health false, and retry with the existing 100ms→5s backoff.
5. On a returned pass result—even when `degraded=true`—set `bootstrapReconciled=true`, record
   `retainedQueueEntries`, and leave `reconciliationHealthy=false` when degraded.
6. Start the real `OrdersConsumer`, set `consumerReady=true`, resume the queue, attach the failed
   hint, and install both periodic timers.
7. Periodic DLQ sweeps rotate beyond retained failed heads. Periodic reconciliation recomputes the
   retained issue count and may restore healthy readiness only when no retained queue issue,
   unresolved identity incident, or operational failure remains.

`lastReconciledAt` records a completed degraded pass because useful reconciliation occurred;
`reconciliationHealthy` remains false. `lastDlqSweepAt` records a completed sweep even when it
retained unsafe entries. The readiness endpoint therefore returns 503 while malformed entries are
retained, even though liveness, the consumer, timers, and valid-job resolution continue.

`runContinuousPass()` may not blindly set health true after `runDiff()`: it uses the returned
result plus `retainedQueueEntries`. A valid later page cannot clear a known retained incident;
only a complete subsequent queue scan that no longer observes it may reduce the count to zero.

---

### 17.4 Identity-specific queue coverage and collision algorithm

#### 17.4.1 Terms

For one user:

- **live reservation**: the current Redis ledger entry, e.g. R2;
- **durable winner**: the single PG row, e.g. persisted R1;
- **same-identity job**: valid job payload `reservationId === live.reservationId`;
- **different-identity job**: valid job payload `reservationId !== live.reservationId`.

Job presence by itself is never coverage. Every comparison uses exact reservation identity.

#### 17.4.2 Frozen helper and bounded authority check

S4 replaces the current collision loop in `enqueueRepair()` with one private helper:

```ts
type EnsureLiveQueueResult =
  | 'ENQUEUED'
  | 'ALREADY_COVERED'
  | 'DURABLY_SATISFIED'
  | 'RETAINED_COLLISION';

ensureLiveReservationQueued(
  live: ReservationEntry,
  durable: DurableOrder | undefined,
): Promise<EnsureLiveQueueResult>;
```

The helper reads the authoritative current job once with
`queue.getJob(buildOrdersJobId(saleId, userId))`; stale scan-map presence is not authoritative.
After one safe removal it may read that job ID once more before one enqueue. No loop, recursive
retry, all-state rescan, or unbounded collision search is permitted. A raced replacement is
validated and returned as `RETAINED_COLLISION` unless it exactly covers `live`.

The decision table is binding:

| Current job identity/state | Durable row | Decision |
|---|---|---|
| none | any | enqueue `live`, then validate returned payload identity |
| same as `live`; waiting/active/delayed/failed | any | `ALREADY_COVERED`; normal worker/DLQ owns terminality |
| same as `live`; completed | same ID + persisted | `DURABLY_SATISFIED`; repair Redis membership/stock only |
| same as `live`; completed | absent, compensated, or different ID | remove completed job, then enqueue `live` so persistence/DLQ makes the live reservation terminal |
| different from `live`; active | any | retain and degrade; never remove an active job |
| different from `live`; waiting/delayed/failed/completed | job ID equals durable row ID and durable status is persisted or compensated | remove historical job: I4 for that exact identity is already durably satisfied; then enqueue `live` |
| different from `live`; any state | no matching durable row for that job identity | retain and degrade; it is unsafe to infer history or delete it |
| invalid name/payload/job ID | any | retain and degrade under §17.2; it is never identity evidence |

For a valid failed historical job whose identity equals the durable winner, removal is persisted
detection, not compensation. For a compensated durable identity, removal is compensated
detection. Removing either queue record cannot lose a confirmation because PG already proves its
terminal state.

`enqueueRepair()` delegates to this helper and may not require a different-identity completed job
to be `compensated` specifically: `persisted` is also terminal evidence for that exact historical
identity. Conversely, a persisted row for R1 is never terminal evidence for R2.

#### 17.4.3 Required R1/R2 flow

For PG `R1/persisted` + completed job R1 + Redis ledger/buyer R2:

1. Persisted R1 CAS restore returns `CONFLICT` with current R2. The conflict handler searches for
   **matching R2**, not merely any user job.
2. The completed R1 job is different from live R2 but exactly matches durable persisted R1. Remove
   that historical completed job and enqueue R2 under the now-free deterministic user job ID.
3. R2 processing hits the PG user-unique conflict with persisted R1 and exhausts normal retries.
4. DLQ `resolveFailed(R2)` keeps PG R1 unchanged and calls identity-checked Redis
   `compensate(..., R2)`. Only the R2 ledger/buyer can be removed and stock is returned once.
5. Remove the terminal R2 job. A subsequent reconciliation restores R1's Redis ledger/membership
   from PG and derives stock from the ledger. Final state is PG R1 persisted, Redis R1 present,
   R2 absent/compensated, and stock `totalStock - persisted/reserved identities`.

While steps 1–5 are incomplete, readiness is degraded with a structured identity-conflict
incident. It may return healthy only after the live/durable identities converge and no other
degrading condition remains.

The completed R1 job must never:

- count as matching queue coverage for R2;
- cause `queue.add(R2)` to return R1 and be accepted;
- be compensated as R2;
- be removed merely because it shares a user unless its exact R1 identity is proven terminal by
  PG; or
- cause R1's durable row to be overwritten by R2.

---

### 17.5 Required tests

#### 17.5.1 S4 units

Unit tests must prove:

1. `scanJobs()` classifies malformed name, payload, and ID entries, retains them, continues the
   page and later pages, and returns valid entries plus issues without throwing.
2. A Redis/BullMQ/Postgres command error remains operational and rejects the pass.
3. `sweepFailed()` returns degraded for retained malformed/nonterminal entries, continues valid
   entries in the same page, advances the A2 cursor, and throws only for a failed valid terminal
   resolution/queue operation.
4. `start()` completes bootstrap, starts consumer, resumes queue, attaches hints, and installs
   timers when the only incidents are retained malformed failed jobs; health remains false.
5. `start()` still retries and never starts the consumer for configuration drift, overcommit,
   buyer-only ambiguity, and datastore failure.
6. Periodic successful valid work cannot clear `retainedQueueEntries`; only a complete clean scan
   can restore readiness.
7. The full §17.4 decision table, including same-live completed/different durable, different-live
   completed matching persisted winner, active collision, unknown historical identity, invalid
   collision, and queue-add race identity validation.
8. PG persisted R1 plus completed R1 never counts as coverage for Redis R2; R1 is removed and R2
   is enqueued exactly once.

Use fake timers/explicit promises for timer tests. No wall-clock sleeps or private direct-sweep
substitute is accepted as startup proof.

#### 17.5.2 S5 real integrations

**Restart with retained malformed heads:**

1. With `WORKER_DLQ_SCAN_COUNT=2`, create two malformed failed head jobs and at least one valid
   terminal failed tail reservation.
2. Stop the failure-producing worker. Construct a fresh reconciliation/consumer lifecycle over
   the same Redis/Postgres/queue state, proving an actual restart boundary.
3. Call only the fresh `reconciliation.start()`; do not call `triggerDlqSweep()` or private
   `sweepFailed()` in this proof.
4. Assert `start()` returns, `bootstrapReconciled=true`, `consumerReady=true`, the queue is resumed,
   and periodic timers resolve/remove the valid tail within bounded repeated sweeps.
5. Assert both malformed jobs remain byte-for-byte unchanged, `retainedQueueEntries >= 2`, health
   readiness is 503, and the valid tail is compensated exactly once.
6. Instrument queue reads: every general page is at most `WORKER_RECONCILE_SCAN_COUNT`, every DLQ
   page is at most two, no call uses `end=-1`, and no sweep makes more than the A2 two-page maximum.

**Partial Redis loss with completed winner collision:**

1. Reserve/persist R1 and retain its real BullMQ job in `completed`.
2. Delete/reseed the sale's volatile Redis reservation/buyer/stock state while preserving PG and
   BullMQ, then make a real Redis purchase for the same user, producing confirmed R2.
3. Assert precondition: PG R1 persisted, completed job payload R1, Redis ledger R2, and stock
   decremented for R2.
4. Construct a fresh lifecycle and call `reconciliation.start()`—no direct pass or sweep.
5. Assert completed R1 is removed as a durably satisfied different identity, R2 occupies the
   deterministic job ID, retries against the PG unique winner, and is terminally removed after
   identity-safe R2 compensation.
6. Assert final PG remains exactly R1/persisted; no R2 durable row exists; Redis ledger and buyer
   converge back to R1; stock is exactly `SALE_TOTAL_STOCK - 1`; repeated reconciliation does not
   change stock; and readiness eventually returns 200 when no unrelated retained incident exists.
7. Capture identities at every transition and prove no call compensates R1 while resolving R2.

Both integrations use real Redis 7.4, Postgres 16, and BullMQ. They must fail against the rejected
A2 implementation. No fake datastore, arbitrary sleep, direct private method, direct DLQ trigger,
or skipped-container fallback is acceptable.

---

### 17.6 Corrective exclusive ownership and sequence

Only two sequential corrective slices are authorized. They do not run in parallel.

#### A3-S4 — reconciliation classification, boot semantics, and identity collision repair

Required skills: `bullmq-specialist`, `redis-core`, `redis-connections`,
`postgresql-table-design`, `nestjs-best-practices`, `vitest`.

```text
apps/worker/src/reconciliation/reconciliation.service.ts      ~
apps/worker/src/reconciliation/reconciliation.service.spec.ts ~
```

Own only these paths. Implement §§17.2–17.4 and §17.5.1. Do not edit Redis/package contracts,
repository/consumer/processor, health files, integration/support files, API/shared, schema,
dependencies/lockfile, env, Compose, STATE, contracts, git metadata, or `.codex/`.

#### A3-S5 — restart and partial-loss integrations

Required skills: `bullmq-specialist`, `redis-core`, `redis-connections`,
`postgresql-table-design`, `nestjs-best-practices`, `vitest`.

```text
apps/worker/test/integration/failure-modes.integration.spec.ts ~
apps/worker/test/support/harness.ts                            ~
```

Own only these paths. Implement §17.5.2 against S4's production behavior. Do not edit production
source, Redis/package contracts, other support helpers, API/shared, schema, dependencies/lockfile,
env, Compose, STATE, contracts, git metadata, or `.codex/`.

**Strict sequence:** A3-S4 → verification → A3-S5 → verification → full Phase 3 gate → fresh
adversarial review. S5 must consume green, built S4 output; no corrective fan-out is permitted.

### 17.7 Exact dispatch briefs

#### Dispatch A3-S4

> Start from the shared Phase 3 worktree and preserve every unrelated edit. Own only
> `apps/worker/src/reconciliation/reconciliation.service.ts` and
> `apps/worker/src/reconciliation/reconciliation.service.spec.ts`. Load `bullmq-specialist`,
> `redis-core`, `redis-connections`, `postgresql-table-design`, `nestjs-best-practices`, and
> `vitest`. Implement frozen contract §§17.2–17.4 and unit matrix §17.5.1 exactly: classify and
> retain invalid queue entries without aborting boot, keep operational/invariant failures fatal,
> preserve bounded rotating traversal, make readiness reflect retained incidents, and replace
> user-level collision suppression with the exact reservation-identity decision table. In the
> PG-R1/completed-R1/Redis-R2 case, remove only durably proven historical R1 and enqueue R2 exactly
> once so normal retry/DLQ can compensate R2. Do not touch repository, consumer, processor,
> health, integration/support files, Redis packages, API/shared, schema, dependencies/lockfile,
> env, Compose, STATE, contracts, git metadata, or `.codex/`. Return actual output for:

```bash
pnpm --filter @flash/worker lint
pnpm --filter @flash/worker typecheck
pnpm --filter @flash/worker test
pnpm --filter @flash/worker build
pnpm exec prettier --check \
  apps/worker/src/reconciliation/reconciliation.service.ts \
  apps/worker/src/reconciliation/reconciliation.service.spec.ts
```

#### Dispatch A3-S5

> Start only after A3-S4 is green and built. Preserve every unrelated edit. Own only
> `apps/worker/test/integration/failure-modes.integration.spec.ts` and
> `apps/worker/test/support/harness.ts`. Load `bullmq-specialist`, `redis-core`,
> `redis-connections`, `postgresql-table-design`, `nestjs-best-practices`, and `vitest`. Implement
> the two real-datastore restart proofs in frozen contract §17.5.2. Both must construct a fresh
> lifecycle over retained datastore state and enter through `reconciliation.start()` only—never a
> direct pass/sweep. Prove malformed failed heads remain retained/degraded while periodic bounded
> DLQ traversal resolves the valid tail. Prove PG persisted R1 plus retained completed R1 cannot
> suppress newly Redis-confirmed R2: historical R1 queue metadata is removed only after exact PG
> identity proof, R2 retries and is compensated under its own identity, PG R1 remains the winner,
> Redis/stock converge, and readiness recovers only in the clean scenario. No sleeps, fake
> datastore, skipped-container fallback, production edits, other helper edits, Redis/package
> changes, API/shared, schema, dependencies/lockfile, env, Compose, STATE, contracts, git metadata,
> or `.codex/`. Return actual output for:

```bash
pnpm --filter @flash/worker build
pnpm --filter @flash/worker test:integration
pnpm exec prettier --check \
  apps/worker/test/integration/failure-modes.integration.spec.ts \
  apps/worker/test/support/harness.ts
```

### 17.8 A3 gate and invariant evidence

After A3-S5, rerun the full unchanged §13.2 Phase 3 gate and a fresh adversarial review. Additional
required evidence:

```bash
rg -n "getJobs\([^\n]*-1" apps/worker/src/reconciliation apps/worker/test # ZERO
rg -n "restoreReservations\(" apps/worker/src                           # ZERO
```

The integration report must explicitly name:

- fresh `start()` crossing bootstrap with retained malformed failed heads;
- consumer/timers active, valid tail terminally compensated, malformed entries unchanged, and
  readiness 503;
- PG R1/completed R1/Redis R2 precondition and every identity transition;
- R2 compensation exactly once, PG R1 unchanged, Redis restored to R1, stock exactly total−1;
- bounded page widths, no unbounded queue read, zero skipped datastore tests, and zero unhandled
  errors.

Invariant effect:

- **I1:** R2 compensation matches only R2; stock returns once, then ledger-derived reconciliation
  counts durable R1 exactly once. Historical R1 queue cleanup never changes stock.
- **I2:** PG's user-unique persisted R1 remains the durable winner; R2 can never overwrite it.
- **I3:** unchanged; A3 does not touch the purchase decision or sale-window enforcement.
- **I4:** malformed queue data can no longer prevent the worker lifecycle and fair DLQ traversal
  from resolving valid confirmations. Completed R1 is no longer false coverage for R2; R2 gains a
  queue path and reaches identity-safe compensation while R1 remains durably persisted.

## 18. AMENDMENT A4 — paused-queue orphan recovery before boot reconciliation

**Authority:** ARCHITECT · **Version:** A4 · **Date:** 2026-07-23 · **Status:** FROZEN
**Amends:** §§6, 11, 13, 16.2, 17.3, 17.6–17.8. A1–A3 remain binding except where A4
explicitly supersedes their worker-start ordering.

### 18.1 Reproduced I4 deadlock and decision

The final architecture review rejected the production restart path:

1. `ReconciliationService.start()` globally pauses the queue and waits for `active === 0`.
2. `OrdersConsumer.start()` constructs the BullMQ `Worker` only after that wait and the boot diff.
3. In BullMQ 5.80.9, expired-lock recovery is performed by a Worker's stalled checker. A worker
   killed while a job is active therefore leaves an orphan in `active`; no Worker exists to move
   it, so every 30-second boot attempt times out and retries forever.
4. The existing crash integration starts a raw replacement BullMQ Worker, bypassing production
   `ReconciliationService.start()`, so it cannot detect this deadlock.

**Decision:** `OrdersConsumer` owns one BullMQ Worker for its entire process lifetime. It creates
that Worker with `autorun:false` while the admin queue is globally paused, starts only the Worker's
stalled checker, and does not start the processing loop. Once expired active jobs have been
reclaimed and the boot diff has completed, the same Worker starts its processor loop; only then is
the global queue resumed.

This is pinned to installed `bullmq@5.80.9` and its public `Worker.startStalledCheckTimer()` API.
The installed `moveStalledJobsToWait-9.lua` calls `getTargetQueueList`; when the queue meta hash is
globally paused, an unlocked orphan is atomically removed from `active` and appended to the
`paused` list, not exposed to processing. A BullMQ upgrade that changes this public API or paused
target behavior is an architect escalation.

Rejected alternatives:

| Decision | Alternative rejected | Why |
|---|---|---|
| One `autorun:false` Worker transitions from recovery-only to processing | Raw replacement Worker in integration | Bypasses production lifecycle and cannot prove restart safety |
| BullMQ public stalled checker | Direct invocation of private scripts/Lua or manual active-list mutation | Couples to internals and risks moving a still-locked job |
| Global queue remains paused through recovery and diff | Resume queue to let a normal Worker recover | Allows waiting work to execute before Redis/PG reconciliation is safe |
| One owned Worker | Separate temporary recovery Worker plus later consumer Worker | Adds connection/cleanup ownership and a checker handoff gap without benefit |

---

### 18.2 Frozen BullMQ timing and Worker options

`apps/worker/src/orders/orders.consumer.ts` exports and uses:

```ts
export const ORDERS_LOCK_DURATION_MS = 30_000 as const;
export const ORDERS_STALLED_INTERVAL_MS = 30_000 as const;
```

The single production Worker options are exactly:

```ts
{
  connection: consumerRedis,
  prefix: ORDERS_QUEUE_PREFIX,
  concurrency: env.WORKER_CONCURRENCY,
  autorun: false,
  lockDuration: ORDERS_LOCK_DURATION_MS,
  stalledInterval: ORDERS_STALLED_INTERVAL_MS,
  maxStalledCount: ORDERS_MAX_STALLED_COUNT,
}
```

`autorun:true`, omission of `autorun`, `skipStalledCheck:true`, and duplicated timing literals are
forbidden. `QueueEvents` and the Worker retain the A2 event/error logging.

The existing active-drain attempt remains 30 seconds per boot attempt. This is an attempt bound,
not a claim that one attempt covers the two-phase BullMQ stalled algorithm. The recovery Worker
persists across boot retries; therefore one check can mark active jobs as potentially stalled and
a later check can reclaim them after their lock expires. Each timed-out attempt degrades
readiness and uses the existing 100ms→5s retry backoff; it does not create another Worker,
connection generation, timer, or stalled checker.

Boundedness:

- exactly one recovery-capable Worker and one stalled-check loop exist per worker process;
- BullMQ's `stalled-check` Redis lease coordinates concurrent process restarts;
- the checker examines only the active set, whose supported local deployment bound is the sum of
  configured worker concurrency, never the waiting backlog;
- application polling of `getActiveCount()` is one command per 100ms and stops at 30 seconds per
  attempt;
- no application `LRANGE`, `SMEMBERS`, lock deletion, active-list mutation, or custom recovery Lua
  is permitted.

---

### 18.3 `OrdersConsumer` two-phase lifecycle contract

`OrdersConsumer` exposes:

```ts
prepareForBootstrapRecovery(): Promise<void>;
start(): Promise<void>;
close(): Promise<void>;
```

#### 18.3.1 `prepareForBootstrapRecovery()`

This method is single-flight and idempotent:

1. If a prepared Worker already exists, return its preparation promise.
2. Create the consumer Redis connection, events Redis connection, Worker with the exact §18.2
   options, and `QueueEvents`. Attach all `error`, `stalled`, and `failed` listeners before any
   readiness wait or checker start.
3. Await Worker and QueueEvents readiness.
4. Call and await the public `worker.startStalledCheckTimer()`. This starts the checker; completion
   of orphan recovery is observed by `ReconciliationService` through `getActiveCount()`, not
   inferred from this method's return.
5. Do not call `worker.run()`, `worker.resume()`, `queue.resume()`, the order processor, or any job
   fetch API. `ready` remains false because processing has not started.

If preparation fails, close/disconnect every locally created partial resource, remove its
listeners, clear the preparation generation, and reject. A later boot retry may construct exactly
one fresh generation. Partial cleanup errors are aggregated with the preparation error; they are
never swallowed.

#### 18.3.2 `start()`

`start()` requires/awaits successful preparation and is idempotent:

1. Call `worker.run()` exactly once on the already prepared Worker.
2. Store its lifetime promise immediately and attach rejection handling immediately; no detached
   or unhandled Worker promise is allowed.
3. Do **not** await the lifetime promise. Verify `worker.isRunning()` after `run()` has synchronously
   entered its running state; if it did not, reject startup.
4. Set the consumer's processing-ready state only after the run loop has started. The admin queue
   is still globally paused, so no job can be claimed yet.

`ReconciliationService`, not `OrdersConsumer`, owns the later global `queue.resume()` call.

#### 18.3.3 `close()`

Closure is idempotent in all lifecycle states: partial preparation, recovery-only, processing, or
already closed.

- stop accepting/processing work when a run loop exists;
- `worker.close()` stops the stalled checker, lock manager, normal/blocking Redis connections, and
  run loop;
- await/settle the stored `run()` lifetime promise after closing;
- close `QueueEvents`, quit/disconnect both explicitly owned Redis clients, remove listeners, and
  clear every field;
- aggregate errors only after attempting every cleanup.

A shutdown during the 30-second active wait must terminate the checker and let
`ReconciliationService.start()` exit without constructing or starting another generation.

---

### 18.4 Exact production restart algorithm

A4 supersedes A3 §17.3 steps 1–6 with this ordering inside the existing session reconciliation
lock and boot retry loop:

1. `await queue.pause()` globally. Verify `await queue.isPaused()` is true; failure/false is an
   operational boot failure.
2. `await consumer.prepareForBootstrapRecovery()`. The Worker is connected and its stalled checker
   is running, but its processor loop is not.
3. Poll `queue.getActiveCount()` every 100ms for at most 30 seconds in this boot attempt.
   - A live job with a valid lock is allowed to finish under its original worker.
   - An orphan is first marked by BullMQ, then after its lock is absent a later stalled check moves
     it atomically from `active` to the globally paused list.
   - Never delete a lock or move an active job directly.
4. If active count is still nonzero at the attempt deadline, throw the existing drain-timeout
   operational error. Keep the same prepared recovery Worker/checker alive; the outer bounded
   backoff retries step 1 and the count poll. `bootstrapReconciled` and `consumerReady` remain
   false, readiness remains 503, and the queue remains globally paused.
5. Once active count is zero, validate/seed sale configuration and execute the full A3 boot diff,
   including retained-entry classification and one bounded DLQ sweep. Any fatal result returns to
   the retry loop while recovery preparation remains single-generation.
6. On a completed boot result, set bootstrap/readiness state per A3.
7. `await consumer.start()` starts the processing loop on the same Worker while the queue remains
   globally paused. Set `consumerReady=true` only after this succeeds.
8. Attach failed hints and periodic reconciliation/DLQ timers, then `await queue.resume()`.
   Verify `await queue.isPaused()` is false. If resume or verification fails, set
   `consumerReady=false`, keep readiness 503, and fail startup; never claim ready on an uncertain
   queue state.
9. The reclaimed job becomes waiting only after the global resume and is processed normally. Its
   at-least-once replay either idempotently detects/persists the PG row or exhausts retries and is
   identity-safely compensated by the existing DLQ path.

No boot path may report readiness 200 while active orphans remain, while the processor loop is not
running, or while the queue is globally paused.

---

### 18.5 Required unit and real integration proofs

#### 18.5.1 S4 units

Unit tests must prove:

1. `prepareForBootstrapRecovery()` creates one Worker with exact options, calls
   `startStalledCheckTimer()` exactly once, and never calls `run()` or the processor.
2. Repeated preparation/start calls create one Worker, one checker, and one run loop.
3. `ready === false` during recovery-only mode and becomes true only after the stored run loop is
   started.
4. Partial preparation failure closes all created resources and permits one clean later retry.
5. `close()` fully closes recovery-only resources and settles the run promise in processing mode,
   with no unhandled rejection.
6. Boot globally pauses and verifies pause before preparation/count polling.
7. An active count that remains nonzero times out one attempt, while the same prepared checker is
   reused on the next attempt; no second Worker is constructed.
8. Active count reaching zero allows the diff, then `consumer.start()`, timer/hint installation,
   queue resume, and resume verification in the exact §18.4 order.
9. Reconciliation never calls consumer processing start or queue resume before active reaches
   zero and the diff succeeds.
10. Resume failure/false verification leaves consumer/readiness false and does not install a
    second lifecycle.

Use injected Worker/Queue constructor seams or spies, fake timers, and explicit promises. No real
sleep, lock deletion, private BullMQ script invocation, or raw replacement Worker is accepted as
unit evidence.

#### 18.5.2 S5 production-process crash regression

The integration test must use the built production entrypoint for both processes:

1. Build `apps/worker/dist/main.js`. Start process P1 through that entrypoint with the real
   Testcontainers Redis/Postgres URLs, unique queue/sale, and health port; wait for readiness 200.
2. Acquire the same PostgreSQL advisory key used by `OrderRepository.persist()` from an independent
   test connection, then make a real Redis reservation and enqueue its real job. This blocks the
   actual production processor after the job becomes active without modifying production code.
3. Assert BullMQ state is `active` and its lock key exists. Send **SIGKILL** to P1 and prove P1
   exits while the job remains active. Release the independent PG advisory lock only after P1 has
   exited.
4. Start process P2 only through the same built production entrypoint. Do not construct a raw
   replacement `Worker`, call `runWorker`, delete the job lock, invoke a private BullMQ script, or
   directly trigger reconciliation/DLQ.
5. While P2 boot recovery runs, prove the admin queue is globally paused, readiness stays 503,
   and the orphan is not processed. Condition-poll real state; arbitrary sleeps are forbidden.
6. Within the contract recovery budget (two 30-second stalled intervals plus boot retry/backoff;
   overall test watchdog 120 seconds), prove the expired-lock orphan leaves `active`, boot
   reconciliation completes, the same production Worker begins processing, and the queue resumes.
7. Prove the job reaches a legitimate terminal outcome:
   - preferred path: exactly one PG row with the reservation ID and `persisted` status, job
     `completed`, Redis ledger/buyer retained, stock `totalStock - 1`; or
   - if the deliberately injected persistence failure is retained instead, terminal DLQ
     compensation with no PG persisted row, job removed, Redis ledger/buyer removed, and stock
     exactly returned once.
8. Assert P2 readiness becomes 200 only after bootstrap/consumer/queue conditions are true. Send
   SIGTERM and reuse A2's production shutdown assertions: exit 0, no worker Redis/PG resources,
   no active jobs, and no unhandled errors.

The preferred test setup uses the advisory-lock block and therefore must assert the persisted
branch. “Persisted or compensated” is the architecture's allowed terminal set, not permission for
a nondeterministic test assertion.

This regression must fail against the rejected pre-A4 production ordering. It supplements rather
than replaces the A2 max-stalled, A3 malformed-head restart, and A3 R1/R2 partial-loss proofs.

---

### 18.6 Corrective exclusive ownership and sequence

Only two sequential slices are authorized.

#### A4-S4 — two-phase consumer and paused recovery ordering

Required skills: `bullmq-specialist`, `redis-connections`, `nestjs-best-practices`, `vitest`.

```text
apps/worker/src/orders/orders.consumer.ts                     ~
apps/worker/src/orders/orders.consumer.spec.ts                ~
apps/worker/src/reconciliation/reconciliation.service.ts      ~
apps/worker/src/reconciliation/reconciliation.service.spec.ts ~
```

Own only these paths. Implement §§18.2–18.4 and §18.5.1. Do not edit integration/support files,
main/module/infra/health/config, repository/processor, Redis packages, API/shared, schema,
dependencies/lockfile, env, Compose, STATE, contracts, git metadata, or `.codex/`.

#### A4-S5 — production crash/restart regression

Required skills: `bullmq-specialist`, `redis-connections`, `postgresql-table-design`, `vitest`.

```text
apps/worker/test/integration/failure-modes.integration.spec.ts ~
apps/worker/test/support/harness.ts                            ~
```

Own only these paths. Implement §18.5.2 against green S4 behavior. Do not edit production source,
other support helpers, Redis packages, API/shared, schema, dependencies/lockfile, env, Compose,
STATE, contracts, git metadata, or `.codex/`.

**Strict sequence:** A4-S4 → focused verification → A4-S5 → integration verification → full Phase
3 gate → fresh adversarial and final architecture review. No parallel A4 implementation.

### 18.7 Exact dispatch briefs

#### Dispatch A4-S4

> Preserve all unrelated shared-worktree edits. Own only
> `apps/worker/src/orders/orders.consumer.ts`,
> `apps/worker/src/orders/orders.consumer.spec.ts`,
> `apps/worker/src/reconciliation/reconciliation.service.ts`, and
> `apps/worker/src/reconciliation/reconciliation.service.spec.ts`. Load `bullmq-specialist`,
> `redis-connections`, `nestjs-best-practices`, and `vitest`. Implement frozen contract
> §§18.2–18.4 and unit matrix §18.5.1 exactly. Create one BullMQ Worker with `autorun:false`; make
> `prepareForBootstrapRecovery()` start only its public stalled checker while the admin queue is
> verified globally paused; reuse that same Worker across bounded active-drain retries; start its
> stored/handled `run()` lifetime only after active reaches zero and the boot diff succeeds; resume
> and verify the global queue only after consumer/timer/hint setup. Make partial preparation and
> recovery-only shutdown leak-free and idempotent. Do not delete locks, call private BullMQ
> scripts, resume early, create a second Worker, use sleeps, or touch integration/support,
> main/module/infra/health/config, repository/processor, Redis packages, API/shared, schema,
> dependencies/lockfile, env, Compose, STATE, contracts, git metadata, or `.codex/`. Return actual
> output for:

```bash
pnpm --filter @flash/worker lint
pnpm --filter @flash/worker typecheck
pnpm --filter @flash/worker test
pnpm --filter @flash/worker build
pnpm exec prettier --check \
  apps/worker/src/orders/orders.consumer.ts \
  apps/worker/src/orders/orders.consumer.spec.ts \
  apps/worker/src/reconciliation/reconciliation.service.ts \
  apps/worker/src/reconciliation/reconciliation.service.spec.ts
```

#### Dispatch A4-S5

> Start only after A4-S4 is green and built. Preserve all unrelated shared-worktree edits. Own
> only `apps/worker/test/integration/failure-modes.integration.spec.ts` and
> `apps/worker/test/support/harness.ts`. Load `bullmq-specialist`, `redis-connections`,
> `postgresql-table-design`, and `vitest`. Implement the real production-process regression in
> frozen contract §18.5.2: start built P1, block its real repository on the exact PG advisory key,
> enqueue a real confirmed reservation, prove it active/locked, SIGKILL P1, then start only built
> P2. Prove P2 remains globally paused and readiness 503 while its recovery-only stalled checker
> reclaims the expired orphan; then prove boot completes, the same Worker processes after resume,
> the job persists exactly once, readiness becomes 200, and production SIGTERM closes cleanly.
> Never construct a raw replacement Worker, call `runWorker`, delete a lock, directly trigger a
> pass/sweep, invoke private BullMQ APIs, use arbitrary sleeps, fake/skip datastores, or touch
> production source, other helpers, Redis packages, API/shared, schema, dependencies/lockfile,
> env, Compose, STATE, contracts, git metadata, or `.codex/`. Return actual output for:

```bash
pnpm --filter @flash/worker build
pnpm --filter @flash/worker test:integration
pnpm exec prettier --check \
  apps/worker/test/integration/failure-modes.integration.spec.ts \
  apps/worker/test/support/harness.ts
```

### 18.8 A4 gate and invariant evidence

After A4-S5, rerun the full unchanged §13.2 Phase 3 gate and both fresh reviews. Additional static
evidence:

```bash
rg -n "autorun:\s*false" apps/worker/src/orders/orders.consumer.ts
rg -n "startStalledCheckTimer" apps/worker/src/orders/orders.consumer.ts
rg -n "new Worker" apps/worker/src/orders/orders.consumer.ts # exactly one production construction site
rg -n "runWorker\(|new Worker" apps/worker/test/integration/failure-modes.integration.spec.ts
# Existing non-restart fixtures may remain; the named A4 regression contains neither.
```

Named dynamic evidence:

- actual built P1 ready → real job active with lock → P1 SIGKILL;
- actual built P2 only, queue globally paused and readiness 503 during orphan recovery;
- orphan leaves active without lock deletion/private scripts/raw replacement Worker;
- boot diff completes before processor start and global resume;
- exactly one persisted row for the reservation, completed job, Redis identity retained, stock
  total−1;
- readiness 200 only after bootstrap + consumer + resumed queue;
- P2 SIGTERM exit 0, resources closed, active count zero, zero unhandled errors, zero skipped
  datastore tests.

Invariant effect:

- **I1:** replay remains idempotent and never changes Redis stock unless the identity-safe DLQ
  compensator owns that reservation; no recovery step edits stock or locks directly.
- **I2:** replay uses the existing PG user-unique constraint and reservation advisory lock.
- **I3:** unchanged; recovery does not invoke the purchase decision or alter the sale window.
- **I4:** an expired-lock active reservation now has a production restart path to waiting while the
  queue remains safely paused, then to persisted detection/write or identity-safe compensation;
  it can no longer deadlock before the only stalled checker exists.

## 19. AMENDMENT A5 — fenced ready transition, fatal consumer supervision, and cancellable boot

**Authority:** ARCHITECT · **Version:** A5 · **Date:** 2026-07-23 · **Status:** FROZEN
**Amends:** §§7, 11, 13, 17.3, and 18.3–18.8. A1–A4 remain binding except where A5 explicitly
extends the Postgres fence and supersedes startup/shutdown failure propagation.

### 19.1 Reproduced failures and decisions

Post-A4 adversarial review found three lifecycle-level I4 failures:

1. The PG session advisory lock ends when `bootPass()`/`runDiff()` returns. Consumer start, failed
   hint/timer installation, queue resume, and resume verification happen after unlock. A second
   process can acquire the lock, pause, and enter its diff while the first process independently
   resumes the same queue.
2. Unexpected resolution or rejection of `Worker.run()` only clears
   `OrdersConsumer.processingReady`. Shared `ReconciliationState.consumerReady` remains true, so
   `/health/ready` stays 200 and the process remains alive without a processing loop.
3. `ReconciliationService.stop()` neither cancels nor awaits `start()`. SIGTERM during advisory
   lock acquisition, active-drain polling, backoff, or the boot diff can tear down consumer/infra
   while startup continues, or hit the process watchdog waiting on a non-cancellable operation.

A5 makes three binding decisions:

- The PG session lock fences the complete transition from global pause through active recovery,
  diff, consumer run-loop start, hint/timer installation, queue resume, and resume verification.
- Unexpected Worker lifetime settlement is a fatal supervised condition. It immediately fails
  shared readiness and rejects a handled fatal channel awaited by production bootstrap; the
  process performs bounded cleanup and exits nonzero so an external supervisor can restart it.
- Boot owns one `AbortController`. Shutdown aborts all lock polling, active-drain/backoff delays,
  and paginated boot work, closes recovery resources to break BullMQ readiness waits, then awaits
  every owned startup/pass/sweep promise before infrastructure teardown.

`HealthService` already derives readiness from `bootstrapReconciled && consumerReady &&
reconciliationHealthy`; no health source edit is needed. A5 propagates consumer death into those
shared fields synchronously. Directly injecting `OrdersConsumer` into health is rejected because
it would duplicate lifecycle truth and introduce a module dependency cycle.

---

### 19.2 Abortable PG session fence

#### 19.2.1 Repository interface

`apps/worker/src/orders/order.repository.ts` exports:

```ts
export const RECONCILIATION_LOCK_POLL_MS = 100 as const;

withSessionReconciliationLock<T>(
  work: () => Promise<T>,
  signal: AbortSignal,
): Promise<T>;
```

The implementation uses one checked-out `PoolClient` and this exact acquisition algorithm:

1. Before each query, call `signal.throwIfAborted()`.
2. Execute:

```sql
SELECT pg_try_advisory_lock(
  hashtextextended('flash-reconcile:' || $1, 0)
) AS acquired
```

3. If false, await an abortable 100ms delay and retry. There is no blocking
   `pg_advisory_lock(...)` call.
4. Once true, mark the session as owner, call `signal.throwIfAborted()`, and await `work()` on the
   same process while retaining that exact checked-out session.
5. In `finally`, if and only if ownership was acquired, execute the matching
   `pg_advisory_unlock(...)`. Require its returned `unlocked` value to be true. Then release the
   client exactly once.
6. Attempt unlock/release even when work or abort fails. Preserve the work/abort error and
   aggregate unlock failure with it; never silently claim the fence was released.

If abort happens before acquisition, no unlock query is issued. If it happens after acquisition,
the callback exits at its next A5 abort checkpoint and `finally` releases the lock. PG client
errors remain fatal and bounded by the existing 5-second statement timeout.

This polling is single-flight per process, one query per 100ms, and uses the existing PG pool—no
new connection, Redis lease, schema, environment variable, or dependency.

#### 19.2.2 Fence boundary

The callback passed to `withSessionReconciliationLock` includes, in order:

1. verified global queue pause;
2. A4 recovery-only Worker preparation;
3. active drain/orphan reclamation;
4. sale validation and the complete A3 diff;
5. shared boot-result staging while readiness remains false;
6. consumer unexpected-termination listener registration;
7. `consumer.start()` and explicit `consumer.ready === true` verification;
8. failed-hint and periodic timer installation;
9. global queue resume and `isPaused() === false` verification;
10. optional test barrier `afterQueueResumeVerified()`;
11. atomic shared-state commit to `bootstrapReconciled=true`, `consumerReady=true`, and
    `reconciliationHealthy=!bootResult.degraded`.

Only after the callback returns may the repository unlock the PG session. No field may advertise
ready before resume verification. An overlapping process cannot enter its fenced pause/diff until
the prior process has completed this entire transition.

All periodic `runContinuousPass()` executions also acquire the same session fence through the
abortable API. They do not globally pause or restart the consumer, but cannot overlap another
process's boot or reconciliation diff. DLQ sweeps retain their existing independent single-flight
path because terminal resolution is already protected per reservation by PG advisory xact locks.

---

### 19.3 Fenced transition failure and cleanup

`ReconciliationService.start()` is single-flight and owns `startPromise` plus one boot
`AbortController`. Before processing starts, operational boot failures release the fence and retry
with the existing abortable 100ms→5s backoff while reusing the A4 recovery Worker.

Once `consumer.start()` has been invoked, any start, hint/timer installation, resume, resume
verification, after-resume hook, state-commit, or fence-release failure is a **fatal transition
failure**, not a retryable boot error. For a failure raised inside the fenced callback, attempt all
of the following before that callback exits:

1. set `bootstrapReconciled=false`, `consumerReady=false`, and `reconciliationHealthy=false`;
2. dispose installed timers and the failed-hint subscription;
3. globally pause the queue and verify paused, recording but not hiding pause failure;
4. close `OrdersConsumer` idempotently;
5. aggregate cleanup errors with the original transition error.

The session lock is released only after this cleanup attempt. If the callback completed but the
repository's explicit unlock/checked-session release then fails, the outer `start()` catch
immediately sets all shared readiness fields false and runs the same disposer, queue-pause, and
consumer-close cleanup before propagating the aggregated fence error. It cannot retry the
half-started lifecycle. `start()` rejects to production bootstrap; the process follows §19.5 and
exits 1. A half-started process never retries a closed consumer and never leaves timers/hints
installed.

`OrdersConsumer.onFailedHint(listener)` now returns an idempotent unsubscribe function which
removes that exact listener from `QueueEvents`. `installContinuousLifecycle()` is single-install
and returns/records one disposer that clears both timers and unsubscribes the hint. All failure and
shutdown paths call the same disposer exactly once.

Two protected, default-no-op test barriers are frozen on `ReconciliationService`:

```ts
protected afterBootDiffBeforeConsumerStart(): Promise<void>;
protected afterQueueResumeVerified(): Promise<void>;
```

They run at the named points **inside the held session fence**. Production subclasses/hooks and
environment branches are forbidden; integration tests may subclass only to provide explicit
promise barriers.

---

### 19.4 Unexpected Worker lifetime settlement

#### 19.4.1 Consumer event contract

`apps/worker/src/orders/orders.consumer.ts` exports:

```ts
export type ConsumerRunTermination =
  | { kind: 'resolved' }
  | { kind: 'rejected'; error: unknown };

onUnexpectedRunTermination(
  listener: (termination: ConsumerRunTermination) => void,
): () => void;
```

Rules:

- `startProcessing()` attaches both fulfillment and rejection handlers to `worker.run()` in the
  same turn that obtains the lifetime promise. There is never a bare/detached rejection.
- If the lifetime settles while `closing === false`, set `processingReady=false` and synchronously
  notify every registered listener exactly once with `resolved` or `rejected`.
- Unexpected normal resolution is as fatal as rejection; a Worker processing loop has no valid
  spontaneous success terminal state.
- If `closing === true` before `worker.close()` causes settlement, it is planned shutdown: do not
  emit an unexpected termination.
- Listener exceptions are caught/logged independently and cannot create an unhandled rejection or
  suppress another listener.
- Registration/unsubscribe is idempotent. Reconciliation registers before `consumer.start()` and
  unsubscribes during failure/shutdown.

#### 19.4.2 Shared fatal channel

`ReconciliationService` owns a deferred fatal promise and exposes:

```ts
waitForFatal(): Promise<never>;
```

The original fatal promise receives a rejection handler immediately at construction so a Worker
that terminates during startup cannot cause an `unhandledRejection` before production bootstrap
begins awaiting it.

On unexpected consumer settlement, the registered handler synchronously:

1. sets `consumerReady=false` and `reconciliationHealthy=false`;
2. disposes continuous timers/hints;
3. logs `worker.consumer_terminated` with `kind` and the rejection message when present;
4. rejects the fatal channel once with `ConsumerRunTerminatedError` whose cause preserves the
   original rejection, or states that the run loop resolved unexpectedly.

It does not throw from the callback, call `process.exit`, fabricate a PG/Redis outcome, or attempt
an in-process Worker restart. At-least-once BullMQ recovery belongs to a fresh supervised process.

#### 19.4.3 Production supervision

`apps/worker/src/main.ts` exports and production `bootstrap()` uses:

```ts
export async function superviseWorkerLifecycle(
  reconciliation: Pick<ReconciliationService, 'start' | 'waitForFatal'>,
): Promise<never>;
```

It awaits `start()`, then `waitForFatal()`. If a test double incorrectly resolves the fatal
channel, it throws `worker fatal channel resolved unexpectedly`. Therefore unexpected Worker
resolve and reject both reject the production bootstrap promise. The existing top-level catch logs
fatal, calls `shutdown(1)`, and yields process exit code 1 after bounded cleanup. No unhandled
promise is used as a control signal.

Readiness becomes 503 synchronously before cleanup begins. `/health` liveness may remain 200 only
for the brief cleanup interval; the process must then exit 1. Recovery is a new process executing
the fenced A4/A5 boot path.

---

### 19.5 Cancellable bootstrap and shutdown ordering

Define internal `WorkerLifecycleAbortError` (or recognize `AbortSignal.reason`) so planned shutdown
cancellation is distinguishable from a fatal boot error.

Every boot/reconciliation loop checks the signal:

- before and after global pause verification and recovery preparation;
- before every active-count read and after every abortable 100ms delay;
- before/after sale validation;
- between every PG order page, BullMQ state page, Redis reservation page, buyers page, recovery
  candidate, and DLQ page;
- before consumer start, hint/timer installation, queue resume, resume verification, and ready
  state commit;
- before each retry/backoff delay.

An in-flight datastore command is awaited; cancellation occurs at the next checkpoint. No new work
or retry begins after abort.

`ReconciliationService.stop()` is idempotent and executes this exact order:

1. set `closing=true`, `bootstrapReconciled=false`, `consumerReady=false`, and
   `reconciliationHealthy=false`;
2. abort the boot controller;
3. dispose timers and failed-hint/consumer-termination subscriptions;
4. call `consumer.close()` **before** awaiting startup, so recovery-only Worker/QueueEvents/Redis
   closure breaks pending BullMQ readiness/checker work;
5. await settlement of the owned `startPromise`, `passPromise`, and `dlqPromise` with
   `Promise.allSettled`;
6. ignore only the recognized planned abort result; aggregate every other rejection and consumer
   cleanup failure.

`OrdersConsumer.close()` must not await a pending preparation promise before closing its already
created resources. It marks closing, snapshots/takes resources, closes them, then awaits the
preparation and run promises to settle. This prevents `waitUntilReady()` from deadlocking
shutdown. Preparation code checks `closing` after each await and never starts a stalled checker on
resources already taken for closure.

`main.shutdown()` continues to call reconciliation stop, consumer close, and application close;
the second consumer close is intentionally idempotent. InfraModule teardown occurs only after
reconciliation has released its PG session client/lock and all worker-owned Redis resources have
closed.

SIGTERM during orphan recovery exits 0 within the existing 10-second watchdog. It may leave the
orphan active and the global queue paused; that is safe because a subsequent process reclaims it.
It may not leave a PG reconciliation lock, Worker/checker, Redis client, timer, listener, or
continuing bootstrap promise.

---

### 19.6 Required proofs

#### 19.6.1 S4 unit proofs

Required unit matrix:

1. Repository try-lock polling: false→false→true, one client, abortable 100ms waits, callback under
   ownership, true unlock, one release.
2. Abort before acquisition: prompt exit, no callback/unlock, one release. Abort after acquisition:
   callback exits, unlock still required.
3. Work + unlock failure aggregation; false unlock is an error.
4. Fence event order includes diff → consumer start → hint/timers → resume → verification → state
   commit before unlock.
5. A second start cannot enter its boot barrier until the first has passed resume verification and
   released the fence.
6. Fatal transition cleanup pauses, disposes, closes, fails shared state, and never retries a
   closed consumer.
7. Worker run rejection and unexpected resolution each set private readiness false and emit one
   typed termination; planned close emits none; listener throw creates no unhandled rejection.
8. Reconciliation termination handler immediately sets shared readiness false, disposes
   lifecycle, and rejects the already-handled fatal channel once for both termination kinds.
9. `superviseWorkerLifecycle` rejects for fatal-channel rejection and for impossible resolution.
10. Stop during advisory-lock polling, active drain, retry backoff, and a paginated diff aborts
    promptly, closes consumer first, awaits start/pass/sweep, and leaves no timers/listeners.
11. Consumer close breaks pending preparation before awaiting it and settles both preparation/run
    promises without leaks.

Use fake timers and explicit promises. No wall-clock sleep, forced unhandled rejection, process
exit from a service, or private BullMQ API.

#### 19.6.2 S5 real concurrent boot proof

Using real Testcontainers Redis/Postgres/BullMQ and two fresh lifecycles P2/P3 for one sale/queue:

1. Subclass only the two protected A5 barriers. Start P2 and hold
   `afterBootDiffBeforeConsumerStart` while it owns the PG session fence and the queue is paused.
2. Start P3 concurrently. Prove P3 has not entered its boot-diff barrier and an independent
   `pg_try_advisory_lock` for the same sale returns false.
3. Release P2's first barrier and hold its `afterQueueResumeVerified` barrier. Prove P2 has started
   its consumer and verified resume, while P3 still cannot enter diff.
4. Release P2 completely. P3 then acquires the fence, globally pauses, completes its diff, and
   enters its first barrier.
5. Enqueue a real reservation while P3 is held. Prove it remains unprocessed because the queue is
   globally paused; the already-running P2 Worker cannot independently resume it.
6. Release P3. Prove P3 starts/verifies/resumes before unlock, the reservation persists exactly
   once, both lifecycle states remain coherent, and the PG fence is available after transition.

No direct queue resume, private service method, fake datastore, sleep, or production environment
branch is allowed.

#### 19.6.3 S5 fatal-settlement supervisor proofs

Build first. Two isolated Node subprocesses import the built `main.js` and invoke the exported
`superviseWorkerLifecycle` with deterministic doubles:

- one `waitForFatal()` rejects with the simulated Worker run rejection;
- one incorrectly resolves, exercising the “fatal channel resolved unexpectedly” guard.

Each subprocess uses the same production supervision rejection path to `shutdown(1)`, exits code
1 within 2 seconds, emits no `unhandledRejection`/`uncaughtException`, and leaves no handles. Unit
evidence from §19.6.1 connects real `Worker.run()` settlement to this channel; no test-only env
branch is permitted.

#### 19.6.4 S5 SIGTERM during orphan recovery

Extend the real A4 production crash scenario:

1. P1 claims a real job, is blocked on the exact reservation PG advisory key, and is SIGKILLed,
   leaving an active locked orphan.
2. Start built P2. Observe readiness 503, queue globally paused, orphan active, and P2 holding the
   sale reconciliation fence during recovery.
3. Before the orphan is reclaimed, SIGTERM P2. Assert exit 0 within the 10-second watchdog,
   `worker.shutdown_completed`, no unhandled errors, no worker Redis/PG clients, and active job
   unchanged.
4. From an independent PG connection, acquire and release the sale reconciliation advisory lock,
   proving P2 released it. Assert P2 health port is closed.
5. Start built P3 only through production `main.js`. Prove it reclaims the orphan, completes the
   fenced diff/start/resume sequence, persists the reservation exactly once, reaches readiness
   200, then exits 0 on SIGTERM with clean resources.

No lock deletion, raw replacement Worker, direct pass/sweep, skipped datastore, or arbitrary sleep.

---

### 19.7 Corrective exclusive ownership and sequence

Only two sequential slices are authorized.

#### A5-S4 — fence, fatal supervision, and cancellable lifecycle

Required skills: `bullmq-specialist`, `redis-connections`, `postgresql-table-design`,
`nestjs-best-practices`, `vitest`.

```text
apps/worker/src/orders/orders.consumer.ts                     ~
apps/worker/src/orders/orders.consumer.spec.ts                ~
apps/worker/src/orders/order.repository.ts                    ~
apps/worker/src/orders/order.repository.spec.ts               ~
apps/worker/src/reconciliation/reconciliation.service.ts      ~
apps/worker/src/reconciliation/reconciliation.service.spec.ts ~
apps/worker/src/main.ts                                       ~
apps/worker/src/main.spec.ts                                  +
```

Own only these paths. Implement §§19.2–19.5 and §19.6.1. Health source is deliberately unchanged.
Do not edit integration/support, modules/infra/health/config, processor, Redis packages,
API/shared, schema, dependencies/lockfile, env, Compose, STATE, contracts, git metadata, or
`.codex/`.

#### A5-S5 — concurrent boot, fatal supervisor, and recovery-shutdown integrations

Required skills: `bullmq-specialist`, `redis-connections`, `postgresql-table-design`, `vitest`.

```text
apps/worker/test/integration/failure-modes.integration.spec.ts ~
apps/worker/test/support/harness.ts                            ~
```

Own only these paths. Implement §§19.6.2–19.6.4 against green S4 behavior. Do not edit production
source, other helpers, health, Redis packages, API/shared, schema, dependencies/lockfile, env,
Compose, STATE, contracts, git metadata, or `.codex/`.

**Strict sequence:** A5-S4 → focused verification → A5-S5 → integration verification → full Phase
3 gate → fresh adversarial and final architecture review. No parallel A5 implementation.

### 19.8 Exact dispatch briefs

#### Dispatch A5-S4

> Preserve every unrelated shared-worktree edit. Own only
> `apps/worker/src/orders/orders.consumer.ts`,
> `apps/worker/src/orders/orders.consumer.spec.ts`,
> `apps/worker/src/orders/order.repository.ts`,
> `apps/worker/src/orders/order.repository.spec.ts`,
> `apps/worker/src/reconciliation/reconciliation.service.ts`,
> `apps/worker/src/reconciliation/reconciliation.service.spec.ts`,
> `apps/worker/src/main.ts`, and new `apps/worker/src/main.spec.ts`. Load `bullmq-specialist`,
> `redis-connections`, `postgresql-table-design`, `nestjs-best-practices`, and `vitest`. Implement
> frozen contract §§19.2–19.5 and unit matrix §19.6.1 exactly: replace blocking session-lock
> acquisition with abortable 100ms PG try-lock polling; hold that same session fence through diff,
> consumer start, hint/timers, resume verification, and ready-state commit; fence continuous diffs;
> clean a failed half-transition before unlock; propagate unexpected Worker run resolve/reject into
> shared readiness and an already-handled fatal channel; have production bootstrap supervise it and
> exit 1 after bounded cleanup; make stop abort/close/await all boot and runtime promises in the
> frozen order. Do not change health files, throw from lifecycle callbacks, create unhandled
> promises, restart a Worker in process, block on `pg_advisory_lock`, use sleeps, or touch
> integration/support, modules/infra/health/config, processor, Redis packages, API/shared, schema,
> dependencies/lockfile, env, Compose, STATE, contracts, git metadata, or `.codex/`. Return actual
> output for:

```bash
pnpm --filter @flash/worker lint
pnpm --filter @flash/worker typecheck
pnpm --filter @flash/worker test
pnpm --filter @flash/worker build
pnpm exec prettier --check \
  apps/worker/src/orders/orders.consumer.ts \
  apps/worker/src/orders/orders.consumer.spec.ts \
  apps/worker/src/orders/order.repository.ts \
  apps/worker/src/orders/order.repository.spec.ts \
  apps/worker/src/reconciliation/reconciliation.service.ts \
  apps/worker/src/reconciliation/reconciliation.service.spec.ts \
  apps/worker/src/main.ts \
  apps/worker/src/main.spec.ts
```

#### Dispatch A5-S5

> Start only after A5-S4 is green and built. Preserve every unrelated shared-worktree edit. Own
> only `apps/worker/test/integration/failure-modes.integration.spec.ts` and
> `apps/worker/test/support/harness.ts`. Load `bullmq-specialist`, `redis-connections`,
> `postgresql-table-design`, and `vitest`. Implement frozen real proofs §§19.6.2–19.6.4: use two
> barrier-controlled real lifecycles to prove P3 cannot enter diff before P2 has started, resumed,
> verified, and released the PG fence, and that P2 cannot consume while P3 holds the queue paused;
> run built subprocess fatal-channel reject/resolve proofs with exit 1 and no unhandled errors; and
> extend the production orphan scenario so SIGTERM interrupts P2 recovery, exits 0 cleanly and
> releases the PG fence before built P3 reclaims/persists the orphan. Never directly resume the
> queue, construct a raw replacement Worker, delete locks, invoke private pass/sweep/BullMQ APIs,
> use arbitrary sleeps, fake/skip datastores, or touch production source, other helpers, health,
> Redis packages, API/shared, schema, dependencies/lockfile, env, Compose, STATE, contracts, git
> metadata, or `.codex/`. Return actual output for:

```bash
pnpm --filter @flash/worker build
pnpm --filter @flash/worker test:integration
pnpm exec prettier --check \
  apps/worker/test/integration/failure-modes.integration.spec.ts \
  apps/worker/test/support/harness.ts
```

### 19.9 A5 gate and invariant evidence

After A5-S5, rerun the full unchanged §13.2 Phase 3 gate and both fresh reviews. Named evidence:

- PG try-lock false→true and abort-before/after-acquire cleanup;
- P2 fence held through resume verification; P3 diff excluded; queue-paused sentinel unprocessed;
- unexpected Worker reject and resolve each force shared readiness 503 then process exit 1 with no
  unhandled error;
- SIGTERM during active orphan recovery exits 0 under watchdog, releases PG fence/resources, and
  leaves no continuing bootstrap promise;
- built P3 subsequently reclaims and persists the orphan exactly once and reaches readiness 200;
- zero skipped datastore tests and full shutdown resource assertions.

Invariant effect:

- **I1:** fenced reconciliation prevents a competing resume during another process's diff; replay
  and compensation retain their identity/stock enforcement.
- **I2:** unchanged PG unique index and reservation locks remain authoritative during replay.
- **I3:** unchanged; A5 does not alter purchase/window semantics.
- **I4:** no process can expose work between another process's diff and ready transition; a dead
  processing loop fails shared readiness and exits for supervised replay; shutdown cannot abandon a
  live boot task holding the recovery fence or resources.

## 20. AMENDMENT A6 — reconciliation pool capacity and lossless cancellation failures

**Authority:** ARCHITECT · **Version:** A6 · **Date:** 2026-07-23 · **Status:** FROZEN

**Amends:** §§11, 19.2, 19.3, 19.5–19.9. A1–A5 remain binding except where A6 raises the
Postgres pool minimum and supersedes planned-cancellation classification and error precedence.

### 20.1 Reproduced failures and binding decisions

Post-A5 adversarial review found two I4 livelocks/error-loss paths:

1. The public env contract permits `WORKER_PG_POOL_MAX=1`. A5's session fence checks out that sole
   client, but fenced `ensureSale()`, order pages, and other repository reads still call
   `pool.query(...)`. They wait forever for the client retained by their own fence callback, so boot
   never reconciles, unlocks, starts consumption, or becomes ready.
2. If shutdown aborts while the fence is owned and the callback abort plus advisory-unlock failure
   becomes an `AggregateError`, the outer startup catch can call `checkpoint(signal)` and replace
   that aggregate with `WorkerLifecycleAbortError`. `stop()` then filters it as planned cancellation
   and reports a clean exit even though fence cleanup failed.

A6 freezes these decisions:

- Retain A5's one checked-out session solely for the session advisory fence, and retain pool-backed
  repository queries inside the callback. Raise `WORKER_PG_POOL_MAX` to a validated minimum of `2`:
  one slot may be retained by the fence and at least one distinct slot remains for fenced work.
- A planned cancellation is only the exact abort reason object installed by this service. An
  `AggregateError`, cleanup/unlock error, wrapped error, or merely same-class error is never planned
  cancellation.
- After an operational error is caught, an abort checkpoint may not replace it. If the signal is
  already aborted, every non-pure cancellation propagates immediately, preserving cleanup errors;
  shutdown fails and the process exits nonzero.

#### ADR A6-1 — capacity rather than routing all work through the lock client

| Decision | Alternative rejected | Why |
| --- | --- | --- |
| Minimum pool size `2`; fence owns one lease and callback repository work uses the shared pool | Thread the owning `PoolClient` through every fenced repository/query/transaction interface | The existing repository abstraction deliberately owns transaction clients. Passing the session client across the entire reconciliation graph would widen and couple every interface, and risks nesting transaction/advisory responsibilities. A validated second slot removes the self-deadlock with a small, testable operational boundary. |
| Strict abort-reason identity | Class-based or recursive `AggregateError` cancellation detection | Class/recursive matching can erase an unlock, release, pause, or consumer-close failure whenever an abort is also present. Only the exact reason supplied to `AbortController.abort(...)` represents clean cancellation. |

### 20.2 PostgreSQL pool capacity contract

A6 supersedes the `WORKER_PG_POOL_MAX` row in §11 with this exact row:

| Name | Type / validation | Default | Consumer |
| --- | --- | --- | --- |
| `WORKER_PG_POOL_MAX` | integer `2–100` | `10` | worker Postgres pool; one connection is reserved while the reconciliation session fence is held |

The complete wiring is frozen:

- `apps/worker/src/config/env.schema.ts` validates `.min(2).max(100).default(10)` through the
  existing integer helper. `1`, `0`, negative, fractional, nonnumeric, and values above `100` fail
  before Nest application creation or any PG/Redis/BullMQ resource is opened.
- `apps/worker/src/infra/postgres.provider.ts` continues to create the `pg.Pool` with
  `max=env.WORKER_PG_POOL_MAX`; `apps/worker/src/infra/infra.module.ts` continues to provide that
  one pool. A second pool or ad hoc client is forbidden.
- `.env.example` contains the immediately preceding comment
  `# Worker PG pool: integer 2-100; one slot is retained by the reconciliation fence.` and keeps
  `WORKER_PG_POOL_MAX=10`.
- `infra/docker-compose.yml` keeps
  `WORKER_PG_POOL_MAX: ${WORKER_PG_POOL_MAX:-10}` for the worker.
- `turbo.json` keeps `WORKER_PG_POOL_MAX` in the declared task environment list.

The capacity boundary is exact, not a throughput promise. During boot, the consumer cannot run
ordinary jobs before the fenced diff because the queue is globally paused and the recovery-only
Worker does not process jobs. Therefore, with `max=2`, the fence owns exactly one lease and all
sequential fenced `pool.query`/repository work has one obtainable lease. After resume, the fenced
callback performs no further pool-backed query before returning; advisory unlock uses the already
owned session client. During continuous reconciliation, worker queries may queue on the remaining
pool capacity, but the fence can no longer consume every connection itself. Existing statement,
connection, cancellation, and supervised-restart behavior remains binding.

`WORKER_PG_POOL_MAX=1` is invalid configuration, not a degraded mode. Production must log the
validation issue, expose no health listener, create no datastore/queue resources, and exit `1`.
There is no fallback to `1`, no silent coercion to `2`, and no readiness while configuration is
invalid.

### 20.3 Pure cancellation and error-precedence contract

`ReconciliationService` replaces class-based `isPlannedAbort(error)` with one private predicate
whose semantics are frozen as:

```ts
private isPurePlannedCancellation(error: unknown): boolean {
  const signal = this.bootController.signal;
  return (
    signal.aborted &&
    error === signal.reason &&
    signal.reason instanceof WorkerLifecycleAbortError
  );
}
```

`stop()` always calls
`bootController.abort(new WorkerLifecycleAbortError())`; the first abort reason is immutable and is
the only rejection the shutdown collector may ignore. The predicate must not unwrap
`AggregateError`, inspect `cause`, match by `name`/message, or accept another
`WorkerLifecycleAbortError` instance.

Every `startLifecycle()` catch obeys this error-precedence algorithm before any checkpoint,
backoff, retry, or state transition:

1. If the caught value is the pure planned cancellation, rethrow that exact value.
2. If processing started and transition cleanup has not run, run the A5 half-transition cleanup
   and replace the caught value only with its returned original-or-aggregate result.
3. If the resulting value is not pure cancellation **and the signal is aborted**, fail shared
   readiness/health and throw that resulting value immediately. Do not call `checkpoint`, delay,
   retry, or substitute `signal.reason`.
4. Only a non-cancellation operational error while the signal is not aborted may follow A5's
   retry/backoff path.

Repository cleanup keeps this precedence: callback/abort error is first, unlock/release failures
follow in deterministic order in one `AggregateError`. A false `pg_advisory_unlock` result is an
unlock failure. Client release is attempted exactly once even after unlock failure. Neither the
repository nor reconciliation may replace an aggregate with its abort member.

`stopLifecycle()` collects the results of consumer close, `startPromise`, `passPromise`, and
`dlqPromise` as A5 requires. It filters only values for which
`isPurePlannedCancellation(...) === true`; all aggregate/wrapped/cleanup errors remain. If any
remain, it rejects with `AggregateError('reconciliation shutdown failed')`, preserving each result
as an element in stable collection order. Consequently, SIGTERM/SIGINT with an unlock or other
cleanup failure does not emit `worker.shutdown_completed`: `main`'s existing rejected-shutdown
handler exits `1` within the watchdog. A clean pure cancellation still exits `0`.

### 20.4 Required proofs

#### 20.4.1 A6-S4 unit proofs

1. Env parsing rejects `WORKER_PG_POOL_MAX=1`, `0`, fractional, nonnumeric, and `101`; accepts `2`
   and `100`; omission resolves to `10`.
2. The PG pool provider receives the validated value unchanged. No second pool/client provider is
   introduced.
3. Abort-before-acquire with successful release remains the exact signal reason and is recognized
   as pure cancellation.
4. Abort while the fence is owned plus unlock failure yields an aggregate containing the exact
   abort reason first and unlock failure second. Startup rethrows that aggregate unchanged, with no
   checkpoint replacement, backoff, or retry.
5. The same aggregate reaching `stop()` is retained inside `reconciliation shutdown failed`; stop
   rejects. A distinct `WorkerLifecycleAbortError`, an aggregate containing only the real abort
   reason, and an error whose `cause` is the real abort reason are each retained, not filtered.
6. A stop whose only owned-promise rejection is the exact signal reason resolves cleanly after all
   resources settle.
7. Pre-consumer and post-consumer-start variants both fail shared readiness; the latter also runs
   A5 transition cleanup exactly once and preserves cleanup ordering/errors.
8. Process-handler/shutdown unit evidence proves a rejected stop takes the exit-`1` branch and does
   not log `worker.shutdown_completed`; clean pure cancellation retains exit `0`.

Use fake timers and explicit deferred promises. No wall-clock sleep, private-field mutation,
unhandled rejection, second PG pool, or process exit from a service.

#### 20.4.2 A6-S5 real boundary proofs

Using real Postgres 16, Redis 7.4, and BullMQ:

1. Construct a fresh lifecycle through the production module with
   `WORKER_PG_POOL_MAX=2`, the minimum legal value. Hold only A5's
   `afterBootDiffBeforeConsumerStart()` barrier. Prove the fenced `ensureSale`, PG page scans, queue
   scans, and Redis diff complete and reach that barrier within a deterministic test deadline while
   an independent PG connection proves the sale reconciliation lock is still owned.
2. Release the barrier; prove consumer start/resume/readiness complete, the fence becomes
   independently obtainable, and a real reservation persists exactly once. Assert the worker pool
   reports/behaves with a maximum of `2`; no alternate pool or direct lock deletion is allowed.
3. Spawn built production `main.js` with `WORKER_PG_POOL_MAX=1` and otherwise valid required env.
   It exits `1` within two seconds with a `WORKER_PG_POOL_MAX` validation diagnostic, never opens
   the health port, and leaves no PG, Redis, Worker, timer, or listener handle.

Use explicit barriers/event polling with deadlines, never arbitrary sleep. Do not fake/skip a
datastore, invoke private reconciliation methods, directly resume the queue, or alter production
behavior through a test-only environment branch.

### 20.5 Corrective exclusive ownership and strict sequence

Only these three sequential slices are authorized.

#### A6-S4 — validation and lossless cancellation propagation

Required skills: `postgresql-table-design`, `bullmq-specialist`, `redis-connections`,
`nestjs-best-practices`, `vitest`.

```text
apps/worker/src/config/env.schema.ts                          ~
apps/worker/src/config/env.spec.ts                            ~
apps/worker/src/infra/postgres.provider.ts                    ~
apps/worker/src/infra/infra.module.spec.ts                    ~
apps/worker/src/reconciliation/reconciliation.service.ts      ~
apps/worker/src/reconciliation/reconciliation.service.spec.ts ~
apps/worker/src/orders/order.repository.ts                    ~
apps/worker/src/orders/order.repository.spec.ts               ~
apps/worker/src/main.ts                                       ~
apps/worker/src/main.spec.ts                                  ~
```

Own only these paths. Implement §§20.2–20.4.1. Do not edit integration/support, other worker
source, Redis/API/shared packages, schema SQL, dependencies/lockfile, runtime env/Compose/Turbo,
STATE, contracts, git metadata, or `.codex/`.

#### A6-S5 — real minimum-capacity and invalid-production-env proofs

Required skills: `postgresql-table-design`, `bullmq-specialist`, `redis-connections`, `vitest`.

```text
apps/worker/test/integration/failure-modes.integration.spec.ts ~
apps/worker/test/support/harness.ts                            ~
```

Own only these paths. Implement §20.4.2 against green, built S4 behavior. Do not edit production
source, other tests/helpers, Redis/API/shared packages, schema SQL, dependencies/lockfile,
runtime env/Compose/Turbo, STATE, contracts, git metadata, or `.codex/`.

#### A6-S6 — public env and runtime wiring consistency

Required skills: `multi-stage-dockerfile`, `turborepo-monorepo`.

```text
.env.example              ~
infra/docker-compose.yml  ~
turbo.json                ~
```

Own only these paths. Add the exact `.env.example` range/reservation comment and preserve default
`10`; verify Compose defaults/forwards `10` and Turbo declares the variable. Do not edit worker
source/tests, Dockerfiles, packages, dependencies/lockfile, STATE, contracts, git metadata, or
`.codex/`.

**Strict sequence:** A6-S4 → focused verification → A6-S5 → integration verification → A6-S6 →
runtime-wiring verification → full Phase 3 gate → fresh adversarial and final architecture review.
No A6 implementation slices run in parallel.

### 20.6 Exact dispatch briefs and commands

#### Dispatch A6-S4

> Preserve every unrelated shared-worktree edit. Own only the A6-S4 paths in §20.5. Load
> `postgresql-table-design`, `bullmq-specialist`, `redis-connections`, `nestjs-best-practices`, and
> `vitest`. Implement §§20.2–20.4.1 exactly: validate `WORKER_PG_POOL_MAX` as integer `2–100`
> default `10`; preserve the one-pool architecture; recognize only the exact abort reason as pure
> cancellation; never let a checkpoint/backoff replace a caught aggregate; and retain unlock,
> release, transition-cleanup, and shutdown errors through the process exit-`1` path. Do not touch
> integration/support, other worker source, packages, schema SQL, dependencies/lockfile, runtime
> wiring, STATE, contracts, git metadata, or `.codex/`. Return actual output for:

```bash
pnpm --filter @flash/worker lint
pnpm --filter @flash/worker typecheck
pnpm --filter @flash/worker test
pnpm --filter @flash/worker build
pnpm exec prettier --check \
  apps/worker/src/config/env.schema.ts \
  apps/worker/src/config/env.spec.ts \
  apps/worker/src/infra/postgres.provider.ts \
  apps/worker/src/infra/infra.module.spec.ts \
  apps/worker/src/reconciliation/reconciliation.service.ts \
  apps/worker/src/reconciliation/reconciliation.service.spec.ts \
  apps/worker/src/orders/order.repository.ts \
  apps/worker/src/orders/order.repository.spec.ts \
  apps/worker/src/main.ts \
  apps/worker/src/main.spec.ts
```

#### Dispatch A6-S5

> Start only after A6-S4 is green and built. Preserve every unrelated shared-worktree edit. Own
> only `apps/worker/test/integration/failure-modes.integration.spec.ts` and
> `apps/worker/test/support/harness.ts`. Load `postgresql-table-design`, `bullmq-specialist`,
> `redis-connections`, and `vitest`. Implement §20.4.2: prove a production-module lifecycle at the
> legal minimum pool size `2` completes fenced PG/queue/Redis boot work without self-deadlock while
> retaining the lock through the barrier, then persists exactly once; prove built production
> startup at `1` rejects before health/resources. Use only explicit barriers/event deadlines. Do
> not touch production source, other tests/helpers, packages, schema SQL, dependencies/lockfile,
> runtime wiring, STATE, contracts, git metadata, or `.codex/`. Return actual output for:

```bash
pnpm --filter @flash/worker build
pnpm --filter @flash/worker test:integration
pnpm exec prettier --check \
  apps/worker/test/integration/failure-modes.integration.spec.ts \
  apps/worker/test/support/harness.ts
```

#### Dispatch A6-S6

> Start only after A6-S5 is green. Preserve every unrelated shared-worktree edit. Own only
> `.env.example`, `infra/docker-compose.yml`, and `turbo.json`. Load `multi-stage-dockerfile` and
> `turborepo-monorepo`. Add the exact `.env.example` comment from §20.2, keep value/default `10`,
> and confirm Compose forwarding plus Turbo task-env declaration. Do not touch Dockerfiles,
> application/tests/packages, dependencies/lockfile, STATE, contracts, git metadata, or `.codex/`.
> Return actual output for:

```bash
pnpm exec prettier --check .env.example infra/docker-compose.yml turbo.json
docker compose -f infra/docker-compose.yml config
rg -n 'WORKER_PG_POOL_MAX' .env.example infra/docker-compose.yml turbo.json
```

### 20.7 A6 gate and invariant evidence

After A6-S6, rerun the full unchanged §13.2 Phase 3 gate and both fresh reviews. Named evidence:

- env boundary rejects `1`, accepts `2`, defaults to `10`, and public/Compose/Turbo wiring agrees;
- real boot at pool size `2` reaches the inside-fence barrier, releases the fence, becomes ready,
  and persists a reservation exactly once;
- built production startup at pool size `1` exits `1` before health/resource creation;
- abort plus unlock failure remains an aggregate through startup and stop, performs no retry, and
  drives rejected shutdown/process exit `1`;
- exact pure abort alone settles all resources and exits `0`;
- zero skipped datastore tests and full shutdown resource assertions.

Invariant effect:

- **I1:** unchanged. Lua remains the atomic stock authority; A6 does not alter reservation or
  compensation arithmetic.
- **I2:** unchanged. Redis buyer membership and the Postgres `orders_user_id_uniq` constraint remain
  independent enforcement points.
- **I3:** unchanged. A6 does not alter the API sale-window guard or `[startsAt, endsAt)` semantics.
- **I4:** minimum pool capacity removes the self-deadlock that prevented fenced boot/diff and queue
  recovery; strict error precedence prevents an abort from hiding unlock/cleanup failure as a clean
  stop, forcing supervised nonzero restart until every confirmation is persisted or compensated.
