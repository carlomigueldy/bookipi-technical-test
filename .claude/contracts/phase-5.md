# Phase 5 — FROZEN CONTRACT (Stress, Audit & Measured Tuning)

**Authority:** architect (Sol/Opus-mapped) · **Date:** 2026-07-23 · **Status:** FROZEN v1
**Base:** annotated tag `phase-4-done`, commit
`2dcfdbf9f4e359ee6e9f971b1ab4fc053e4337f6`
**Phase branch:** `phase-5/stress`
**Above this document:** `PRD.md` in full. **Also binding:** `AGENTS.md`, `STATE.md`, and all
frozen Phase 0–4 contracts and amendments.
**Consumers:** Phase 5 implementation, verification, and review agents. They do not invent names.

> Phase 5 proves the shipped system under reproducible local load. It does not add an admin/reset
> endpoint, bypass an invariant, or tune by intuition. Every measured sale has a new sale identity
> and new buyer identities; every confirmation is audited to a durable or compensated terminal
> result before the run can pass.

This contract is frozen when handed off. Any ambiguity routes implementer → orchestrator →
architect and results in a numbered amendment. Side-channel changes are forbidden.

---

## 0. Scope, inherited facts, and explicit PRD resolutions

### 0.1 In scope

- Replace the Phase 0 `pnpm stress` placeholder with an isolated Docker-backed load orchestrator.
- Implement the PRD §6.2 k6 workloads:
  - `surge.js`;
  - `duplicate-storm.js`;
  - `window-edge.js`.
- Add `sold-out.js` as an explicit additive scenario. `STATE.md` requires a named sold-out proof;
  PRD §6.2 previously exercised sold-out mostly as the tail of surge. A separate tiny-stock run
  makes that behavior independently visible without changing any PRD scenario.
- Add a 30-second, 200 purchase-attempt/s `smoke.js` for the existing CI job promised by PRD
  §6.3, plus an unmeasured `warmup.js`.
- Add the TypeScript post-run audit, falsifiable unit tests, raw evidence collection, and a tracked
  Phase 5 results table.
- Maintain `.github/workflows/ci.yml` so k6 smoke is runnable on relevant pull requests once
  GitHub Actions billing is restored.
- Permit one evidence-driven tuning slice only when the untuned baseline misses a frozen
  threshold. Every candidate must have before/after/rollback evidence.

### 0.2 Out of scope

- Any endpoint that seeds, resets, truncates, flushes, compensates, or mutates sale state for a
  caller. In particular, no `/admin`, `/reset`, `/seed`, or test-only production route.
- `FLUSHDB`, `FLUSHALL`, `KEYS`, `SMEMBERS`, `HGETALL`, `TRUNCATE`, broad `DELETE`, schema drop,
  or deletion of the normal developer volumes `flash-pgdata` / `flash-redisdata`.
- Changes to Lua purchase/compensation semantics, Redis key names, shared DTOs, BullMQ job shape,
  Postgres schema, HTTP response shapes, user identity rules, or I1–I4 enforcement.
- A distributed/cloud benchmark. The PRD baseline is local Docker; k6 Cloud is not required.
- Frontend/browser performance, multi-sale product semantics, authentication, or production
  capacity claims extrapolated from one workstation.
- README final ship prose. Phase 5 produces the results artifact that Phase 6 will summarize.
- Treating GitHub Actions as gate evidence while the account billing failure in `STATE.md` remains.

### 0.3 Current runtime facts

The implementation and results must record, rather than hide, these observed planning facts:

- repository pins Node `22.14.x` compatibility and pnpm `11.9.x`; planning host currently reports
  Node `22.22.1` and pnpm `11.9.0`;
- planning host reports Docker Engine `29.5.3`, Compose `v5.1.4`, 20 logical CPUs, and about
  7.6 GiB RAM;
- the ordinary Compose stack owns ports 3000, 3001, 5173, 5433, and 6380 and uses persistent,
  explicitly named volumes;
- Phase 5 therefore uses a separate Compose file, project name, ports, network, and project-scoped
  disposable volumes. It never recreates or stops the ordinary `infra/docker-compose.yml` stack;
- k6 runs from the pinned official container image `grafana/k6:1.7.1`; no global k6 install is a
  prerequisite;
- application rate limits remain enabled, but benchmark-only values are high and finite so the
  2,000/s purchase run measures the purchase/queue path rather than returning 429 by design.

### 0.4 No-reset strategy

Every workload repetition boots API and worker with a fresh, contract-generated `SALE_ID` and
uses a disjoint buyer namespace. Postgres rows and Redis keys from an earlier repetition cannot
affect the current sale. Within a Phase 5 run, old run-scoped data may remain until final teardown;
all audit queries are scoped by sale id except the deliberate global I2 duplicate query.

The runner creates exactly one Compose project named `flash-load-<runId>`, where `<runId>` matches
`^[a-z0-9][a-z0-9-]{7,31}$`. In a `finally` path it may execute
`docker compose -p <validated-name> -f load/docker-compose.yml down -v --remove-orphans`.
That command is permitted only for the exact project created by the current process. The project
name is never supplied unsafely to a shell and never defaults to a blank or broad target. These
volumes are disposable workload fixtures, not the developer volumes named above.

---

## 1. Hard invariants — Phase 5 proof obligations

| Invariant | Enforcement remains | Phase 5 proof |
| --- | --- | --- |
| **I1 — no oversell** | Atomic Redis purchase Lua and reservation-identity-safe compensation; worker never decrements stock | After convergence: `0 <= stock <= totalStock`, `HLEN(reservations) <= totalStock`, `stock + HLEN(reservations) = totalStock`, active PG persisted count equals the Redis ledger count, and every fixed-stock scenario receives exactly its expected maximum confirmations. Any mismatch is a hard audit failure. |
| **I2 — one per user** | Redis buyer/ledger membership plus global `orders_user_id_uniq` | Duplicate storm sends ten simultaneous attempts for each of 5,000 users. Audit requires zero duplicate `user_id` groups globally and per sale, exact equality of buyer Set / reservation Hash / active PG user sets, and exactly one confirmation per duplicate-storm user. |
| **I3 — `[startsAt, endsAt)`** | Redis `TIME` inside `purchase.lua`; API fast guard remains advisory | Window-edge begins five seconds before start and ends five seconds after end. k6 requires zero `CONFIRMED` outside the returned millisecond window. Audit requires every PG `created_at` and every Redis `reservedAtMs` to satisfy `startsAt <= t < endsAt`. Pre/post-window business rejections are expected responses, not HTTP failures. |
| **I4 — no lost confirmations** | Durable BullMQ handoff, reconciliation, idempotent PG persistence, identity-safe compensation | Runner waits for queue/reconciliation convergence. Audit requires queue waiting/active/delayed/failed all zero, worker ready, every Redis reservation matched to the same persisted PG id/user, every persisted PG row matched back to Redis, compensated rows absent from active Redis state, and `k6 purchase_confirmed == PG persisted + compensated` for the fresh sale. A timeout or unmatched confirmation fails; it is never omitted from the table. |

Metrics are diagnostic, not invariant authority. `sale:{id}:metrics` increments are intentionally
fire-and-forget, so their count may lag k6 and must be reported as such; they must not replace the
k6-to-PG terminal equality used for I4.

---

## 2. Exclusive ownership, sequence, and freeze points

No two slices own one path. `+` creates; `~` modifies.

### L1 — load harness, audit, isolated runtime, results (`implementer`)

Mandatory skills, loaded in this order: `k6` first, then `redis-core`, `redis-connections`,
`redis-observability`, `postgresql-table-design`, `multi-stage-dockerfile`,
`turborepo-monorepo`, and `vitest`.

```text
load/package.json                                      +
load/tsconfig.json                                     +
load/eslint.config.mjs                                 +
load/contracts.ts                                      +
load/audit.ts                                          +
load/audit.spec.ts                                     +
load/README.md                                         ~
load/docker-compose.yml                                +
load/k6/common.js                                      +
load/k6/warmup.js                                      +
load/k6/smoke.js                                       +
load/k6/surge.js                                       +
load/k6/duplicate-storm.js                             +
load/k6/sold-out.js                                    +
load/k6/window-edge.js                                 +
load/results/phase-5-results.md                        +
load/results/phase-5-results.sha256                    +
load/results/.gitkeep                                  +
scripts/stress.mjs                                     ~
package.json                                           ~
pnpm-workspace.yaml                                    ~
pnpm-lock.yaml                                         ~
.env.example                                           ~  # only §11 stress rows
.gitignore                                             ~  # only §10.3 result rows
```

L1 owns no application, worker, shared, Redis-package, production-infra, CI, prototype, state,
contract, commit, or tag path.

### L2 — CI smoke wiring (`implementer`)

Mandatory skills: `k6`, then `turborepo-monorepo`.

```text
.github/workflows/ci.yml                               ~
```

L2 consumes L1 commands and file names exactly. It does not edit load or application paths.

### T1 — dormant measured tuning (`implementer`, dispatch only after baseline evidence)

Mandatory skills: `nestjs-best-practices`, `redis-connections`, `redis-observability`,
`bullmq-specialist`, `postgresql-table-design`, and `vitest`.

T1 reserves only the following paths. No other production file may be tuned in Phase 5:

```text
apps/api/src/config/env.schema.ts
apps/api/src/config/env.spec.ts
apps/api/src/infra/redis.providers.ts
apps/api/src/infra/postgres.providers.ts
apps/api/src/queue/orders-queue.service.ts
apps/api/src/queue/orders-queue.service.spec.ts
apps/worker/src/config/env.schema.ts
apps/worker/src/config/env.spec.ts
apps/worker/src/infra/redis.providers.ts
apps/worker/src/infra/postgres.provider.ts
apps/worker/src/orders/orders.consumer.ts
apps/worker/src/orders/orders.consumer.spec.ts
infra/docker-compose.yml
turbo.json
```

T1 may change only connection/pool/concurrency/bounded-backpressure parameters supported by a
measured bottleneck. It may not change outcome ordering, HTTP semantics, Lua, queue identity,
retry/compensation/reconciliation semantics, schema, or validation bounds that enforce safety.
It may not add a dependency or touch `pnpm-lock.yaml`. A needed path outside this list or any
semantic change is an architect escalation and numbered amendment, not an improvisation.

If all untuned thresholds pass, T1 is not dispatched and “no tuning required” is recorded.

### Sequence

1. Architect freezes this document.
2. L1 implements the entire harness and returns focused proof including negative controls.
3. L2 wires CI only after L1 names/commands exist.
4. Root runs one **untuned baseline** repetition of warmup + all four full scenarios.
5. If and only if a threshold misses, root identifies the measured limiting metric and dispatches
   T1 with one candidate hypothesis. Each candidate is verified and either retained or rolled back
   before another candidate. Maximum three implement→verify iterations, then architect escalation.
6. Root runs the final full suite at three repetitions with the chosen production tree.
7. After all commands pass, an `adversarial-reviewer` attacks I1–I4, window boundaries, response
   classification, generator saturation, convergence timeouts, identifier reuse, audit joins,
   unsafe cleanup, port collisions, resource leaks, and threshold evasion.
8. Root alone commits, tags, and updates `STATE.md`.

L1 and L2 may be authored in parallel only after this contract is frozen because their paths are
disjoint; their verification/merge order remains L1 then L2. T1 is necessarily sequential.

---

## 3. `@flash/load` package and command surface

### 3.1 Workspace package

`pnpm-workspace.yaml` adds the exact workspace row `load`. `load/package.json` is named
`@flash/load`, private, version `0.0.0`, and ESM. Internal dependencies use `workspace:*`.

Direct runtime dependencies: `ioredis` and `pg`. Direct dev dependencies:
`@flash/tooling`, `@types/node`, `@types/pg`, `eslint`, `tsx`, `typescript`, and `vitest`.
Use versions already present in the lockfile/workspace where available; `tsx` is the sole expected
new tool. No k6 npm package, xk6 extension, SQL ORM, CLI parser, or report SaaS dependency.

Exact package scripts:

```json
{
  "lint": "eslint . --max-warnings 0",
  "typecheck": "tsc -p tsconfig.json --noEmit",
  "test": "vitest run",
  "audit": "tsx audit.ts"
}
```

`load/tsconfig.json` extends `@flash/tooling/tsconfig/node.json`, sets `noEmit: true`, and includes
only `*.ts`. k6 files are plain JavaScript executed by k6 and are excluded from Node/TypeScript.
`load/eslint.config.mjs` consumes the tooling base config and ignores `k6/**` and `results/**`.

### 3.2 Root scripts

Root `package.json` freezes:

```json
{
  "stress": "node scripts/stress.mjs --profile full",
  "stress:smoke": "node scripts/stress.mjs --profile smoke",
  "stress:audit": "pnpm --filter @flash/load audit"
}
```

`pnpm stress` is the full local gate; `pnpm stress:smoke` is the 30-second CI/local smoke.
Neither silently falls back to a placeholder. A missing Docker daemon/image or occupied load port
is a nonzero environmental failure with a precise message.

### 3.3 `load/contracts.ts`

This file owns Node-side audit/result types only. Export these exact names:

```ts
export const STRESS_SCENARIOS = ['smoke', 'surge', 'duplicate-storm', 'sold-out', 'window-edge'] as const;
export type StressScenario = (typeof STRESS_SCENARIOS)[number];

export interface InvariantResult {
  pass: boolean;
  evidence: readonly string[];
}

export interface AuditReport {
  schemaVersion: 1;
  runId: string;
  scenario: StressScenario;
  saleId: string;
  auditedAt: string;
  expectedConfirmed: number;
  convergence: {
    elapsedMs: number;
    apiReady: boolean;
    workerReady: boolean;
    queue: { waiting: number; active: number; delayed: number; failed: number };
  };
  postgres: {
    totalStock: number;
    persisted: number;
    compensated: number;
    reserved: number;
    duplicateUsersGlobal: number;
    duplicateUsersInSale: number;
    outsideWindow: number;
  };
  redis: {
    stock: number;
    buyers: number;
    reservations: number;
    metricsConfirmed: number;
  };
  invariants: { I1: InvariantResult; I2: InvariantResult; I3: InvariantResult; I4: InvariantResult };
  pass: boolean;
}
```

No secret-bearing URL appears in this structure.

---

## 4. Identifier, sale, and profile contract

### 4.1 Run and sale IDs

If `STRESS_RUN_ID` is absent, the runner generates lower-case
`YYYYMMDDhhmmss-<8 lowercase hex>`. It validates the same 8–32-character form in §0.4.

Every repetition sale id is:

```text
p5-<8hex>-<scenario-token>-r<repetition>
```

Tokens are `warm`, `smoke`, `surge`, `dup`, `sold`, and `edge`. The result must pass
`SALE_ID_PATTERN`, remain ≤64 characters, and be unique across repetitions. `SALE_NAME` is
`Phase 5 <scenario> <runId> r<N>`.

### 4.2 Buyer IDs

`load/k6/common.js` exports `userId(prefix, index)` and returns:

```text
p5_<8hex>_<scenario-token>_<zero-padded decimal index>
```

It is trimmed, 3–64 characters, and matches `[a-zA-Z0-9._@-]+`. No UUID generation, random email,
timestamp per request, or finite CSV is used. The deterministic index is
`scenario.iterationInTest` unless a scenario below pins another mapping. Repetition and scenario
are part of the prefix, so Postgres's intentionally global `orders_user_id_uniq` never causes a
cross-run collision.

### 4.3 Profiles

`STRESS_PROFILE=full` is implemented by `pnpm stress`; `smoke` by `pnpm stress:smoke`. There is no
undocumented profile. The full final gate uses `STRESS_REPETITIONS=3`; smoke always uses one.

| Value | Full default | Smoke constraint |
| --- | ---: | ---: |
| repetitions | 3 | 1 |
| warmup | once, 10 s × 20 purchase/s | none |
| convergence deadline | 120,000 ms | 60,000 ms |
| k6 graceful stop | 10 s | 10 s |
| user pool for surge | 50,000 | at least 6,000 |

Every individual repetition must pass. Median values are informative; a median cannot hide a
failed repetition.

---

## 5. Common k6 protocol and metrics

### 5.1 Request names and expected responses

All scripts import only local `./common.js` plus built-in k6 modules. No remote JavaScript import.
Every HTTP call carries one exact `name` tag:

- `purchase` for `POST /api/purchase`;
- `sale_status` for `GET /api/sale/status`;
- `sale_metrics` for `GET /api/sale/metrics`;
- `api_readiness` for `GET /api/health/ready`.

Use `responseCallback: http.expectedStatuses(...)` per request so expected business responses do
not inflate `http_req_failed`:

- purchase: only the status codes/outcomes explicitly allowed by that scenario;
- sale status/metrics/readiness: only 200 after readiness;
- transport errors, 429, 5xx, malformed JSON/envelopes, and status/body disagreement are always
  unexpected in measured load.

Every body is minimally validated: JSON object, expected `status`, same sale/user where present,
integer `serverTimeMs`, and the correct HTTP/outcome pair. A bare expected HTTP status with a bad
body fails the check and increments `unexpected_responses`.

### 5.2 Custom metrics — exact names

`common.js` defines/exports these singleton metrics:

```text
purchase_duration              Trend(time=true)
purchase_confirmed             Counter
purchase_duplicate             Counter
purchase_sold_out              Counter
purchase_not_started           Counter
purchase_ended                 Counter
purchase_rate_limited          Counter
unexpected_responses           Counter
window_confirmed_outside       Counter
business_checks                Rate
```

`purchase_duration` records every purchase response duration, including expected 403/409/410
business outcomes. Status/metrics latency uses built-in tag-filtered `http_req_duration`.

### 5.3 Frozen thresholds

Every measured scenario includes all applicable thresholds below:

```js
{
  http_req_failed: ['rate<0.01'],
  'http_req_duration{name:purchase}': ['p(95)<200', 'p(99)<500'],
  'http_req_duration{name:sale_status}': ['p(95)<50'],
  'http_req_duration{name:sale_metrics}': ['p(95)<100'],
  unexpected_responses: ['count==0'],
  business_checks: ['rate==1'],
  window_confirmed_outside: ['count==0'],
  dropped_iterations: ['count==0'],
}
```

The PRD thresholds are literal strict inequalities: exactly 1% failures, 200 ms p95, or 500 ms
p99 fails. `dropped_iterations == 0` prevents a saturated load generator from claiming the target
rate while silently dropping work. Duplicate storm is closed-model and may omit the built-in
`dropped_iterations` row only if k6 does not emit it; it must still complete all 5,000 iterations.

Thresholds are never loosened by profile, repetition, environment variable, or tuning. Smoke uses
the same latency/failure thresholds at smaller scale.

### 5.4 Summary output

Each script exports `handleSummary(data)` and writes exactly:

```text
/results/<scenario>/r<repetition>/k6-summary.json
/results/<scenario>/r<repetition>/k6-summary.txt
```

`K6_RESULTS_DIR` is an internal runner/job variable whose container default is `/results`; the
native CI invocation sets it to the absolute checked-out artifact directory. It is not a user
configuration surface and never changes names below `<scenario>/r<repetition>`.

The JSON is the unmodified k6 summary plus a small `phase5` object containing runId, saleId,
scenario, repetition, configured profile, configured target, and custom outcome counts. The text
is the human k6 summary. The runner rejects a missing/invalid summary before audit.

---

## 6. Exact k6 scenarios

All durations/rates below are measured load. Observer scenarios start with the purchase workload,
run for the same measured duration, use their own executors, and do not call purchase.

### 6.1 `warmup.js` — not a result row

- active sale, stock 200, unique buyers;
- `constant-arrival-rate`, 20 purchase iterations/s, 10 s;
- 5 status reads/s and 1 metrics read/s;
- `preAllocatedVUs: 20`, `maxVUs: 100`;
- full envelope checks and audit still run, but warmup latency is excluded from Phase 5 results;
- purpose: pull image/code paths, establish Redis scripts, connections, BullMQ, PG pool, and JIT
  state before the baseline.

### 6.2 `surge.js` — PRD §6.2 scenario 1

- active sale: `startsAt = now - 60 s`, `endsAt = now + 30 min`, stock exactly 500;
- purchase executor: `ramping-arrival-rate`, `startRate: 1`, `timeUnit: '1s'`;
- stages exactly `30 s → 2,000 iterations/s`, then `60 s hold at 2,000/s`;
- `preAllocatedVUs: 500`, `maxVUs: 4,000`;
- 50,000 deterministic unique IDs, indexed modulo 50,000 after the first pool pass;
- expected purchase pairs: `201/CONFIRMED`, `409/ALREADY_PURCHASED`, `410/SOLD_OUT` only;
- observer executors: sale status 50/s and sale metrics 10/s for 90 s;
- exact postcondition: 500 k6 confirmations, 500 active persisted orders, Redis stock 0.

The target is purchase attempts, not total mixed requests. Observer traffic is additive.

### 6.3 `duplicate-storm.js` — PRD §6.2 scenario 2

- active sale, stock exactly 5,000;
- `shared-iterations`, 5,000 iterations, 500 VUs, `maxDuration: '2m'`;
- iteration `i` owns exactly one unique user and issues one `http.batch()` of ten simultaneous
  `POST /api/purchase` requests for that same user;
- expected pairs: `201/CONFIRMED` and `409/ALREADY_PURCHASED` only; 410/429/5xx is failure;
- exactly one response in each ten-response batch must be confirmed and nine duplicate;
- observer executors: status 20/s and metrics 5/s for 120 s or until the purchase scenario ends;
- exact postcondition: 50,000 attempted purchases, 5,000 confirmed, 45,000 duplicate, 5,000
  persisted, stock 0, zero duplicate durable users.

Using 500 concurrent users in waves preserves the required ten-way same-user race for all 5,000
users without requiring 5,000 JS runtimes on the 7.6 GiB planning host.

### 6.4 `sold-out.js` — additive explicit sold-out proof

- active sale, stock exactly 10;
- purchase executor: `constant-arrival-rate`, 1,000 iterations/s for 10 s;
- `preAllocatedVUs: 250`, `maxVUs: 2,000`; all 10,000 buyer IDs are unique;
- expected pairs: `201/CONFIRMED` and `410/SOLD_OUT` only; duplicate is failure;
- observer executors: status 20/s and metrics 5/s for 10 s;
- exact postcondition: 10 confirmed, 9,990 sold out, 10 persisted, stock 0.

### 6.5 `window-edge.js` — PRD §6.2 scenario 3

- runner configures `startsAt` at least 15 s after API/worker recreation and `endsAt` exactly 10 s
  after `startsAt`; stock exactly 1,000;
- after readiness, runner waits until Redis-reported server time is `startsAt - 5,000 ms ±250 ms`
  before launching measured k6; host wall-clock alone is forbidden;
- purchase executor: `constant-arrival-rate`, 500 iterations/s for 20 s, covering 5 s before,
  10 s active, and 5 s after the window;
- `preAllocatedVUs: 200`, `maxVUs: 1,500`; all buyer IDs are unique;
- before start only `403/SALE_NOT_STARTED` is allowed; inside `[startsAt, endsAt)` only
  `201/CONFIRMED` or `410/SOLD_OUT`; at/after end only `403/SALE_ENDED`;
- classification uses each valid purchase envelope's `serverTimeMs`, not generator time;
- any `CONFIRMED` whose `serverTimeMs < startsAtMs || serverTimeMs >= endsAtMs` increments
  `window_confirmed_outside` and is a hard threshold failure;
- observers: status 50/s and metrics 5/s for 20 s;
- exact postcondition: no outside-window confirmation, 1,000 confirmed/persisted, stock 0.

The start boundary is inclusive and end boundary exclusive. A 403 with the wrong side's outcome
is a business-check failure even though both map to HTTP 403.

### 6.6 `smoke.js` — CI-safe subset

- active sale, stock exactly 200;
- `constant-arrival-rate`, exactly 200 purchase iterations/s for 30 s;
- `preAllocatedVUs: 100`, `maxVUs: 750`, 6,000 unique buyers;
- expected `201/CONFIRMED` then `410/SOLD_OUT` only;
- status 10/s and metrics 2/s for 30 s;
- exact postcondition: 200 confirmed/persisted, 5,800 sold out, stock 0;
- same frozen performance thresholds and full audit; one repetition, no warmup.

---

## 7. Isolated Compose runtime

### 7.1 Services and ports

`load/docker-compose.yml` is standalone; it does not `include` or override the production file.
It defines only `redis`, `postgres`, `api`, `worker`, and profile-gated `k6`.

| Service | Image/build | Container port | Default host port | Limit |
| --- | --- | ---: | ---: | --- |
| redis | `redis:7.4-alpine`, AOF everysec | 6379 | 6680 | 1 CPU / 256 MiB |
| postgres | `postgres:16-alpine` | 5432 | 5543 | 2 CPU / 768 MiB |
| api | existing `infra/api.Dockerfile` | 3000 | 3300 | 4 CPU / 768 MiB |
| worker | existing `infra/worker.Dockerfile` | 3001 | 3301 | 2 CPU / 768 MiB |
| k6 | `grafana/k6:1.7.1` | none | none | 4 CPU / 3 GiB |

Do not set `container_name`, network `name`, or volume `name`. Compose project scoping must remain
effective. `postgres` mounts `../infra/postgres/init:/docker-entrypoint-initdb.d:ro`. `k6` mounts
`./k6:/scripts:ro` and the current raw results directory at `/results`.

The runner rejects occupied host ports before `up`; it never kills the occupying process. Values
may be changed only through the frozen `STRESS_*_PORT` env rows. API and worker speak to datastore
container ports and k6 speaks to `http://api:3000/api` on the project network.

### 7.2 Runtime env

API/worker use `NODE_ENV=production`, explicit sale fields, internal datastore URLs, queue name
`orders`, and the existing production defaults unless listed here:

```text
RATE_LIMIT_MAX=1000000
RATE_LIMIT_WINDOW_MS=1000
RATE_LIMIT_USER_MAX=100
RATE_LIMIT_USER_WINDOW_MS=1000
WORKER_CONCURRENCY=16
WORKER_PG_POOL_MAX=10
```

High-but-finite limits preserve both limiter code paths and a bounded configuration while keeping
429 outside the benchmark's expected outcomes. The run report records all six values.

### 7.3 Lifecycle

For each sale, runner order is exact:

1. validate run id, loopback port configuration, Docker availability, free ports, and disk space;
2. create raw result directory and compose project;
3. start fresh Redis/Postgres and wait for their health checks;
4. set scenario sale env and `up -d --build --force-recreate api worker`;
5. poll worker `/health/ready`, then API `/api/health/ready`, with a 60 s boot deadline;
6. verify `/api/sale/status` returns the exact sale id/window/stock;
7. capture pre-run observability snapshot;
8. run k6 and preserve its exit code/summary even on threshold failure;
9. wait for convergence and run audit; a k6 failure does not skip audit;
10. capture post-run evidence/logs;
11. proceed only when cleanup from the repetition has settled; recreate API/worker for next sale;
12. on completion, failure, SIGINT, or SIGTERM, stop samplers and tear down only the validated
    current Compose project with its disposable volumes.

First failure is not allowed to erase later diagnostic evidence. The command exits nonzero if any
k6 repetition, audit, evidence writer, or cleanup fails; multiple failures are summarized.

---

## 8. Audit contract

### 8.1 CLI

`load/audit.ts` accepts only these required flags:

```text
--run-id
--scenario
--sale-id
--initial-stock
--expected-confirmed
--api-url
--worker-url
--database-url
--redis-url
--deadline-ms
--out
```

Unknown/missing/duplicate flags, invalid integers, non-loopback host URLs in the orchestrated
command, invalid sale/run ids, or an output path outside the current raw run directory fails before
opening a datastore. Passwords are redacted from all errors. The pure evaluator is exported for
unit tests; CLI execution is guarded by an ESM main check.

### 8.2 Convergence

Poll with bounded exponential backoff: 100 ms initial, ×1.5, cap 2 s, deadline from profile.
Convergence requires simultaneously:

- API readiness 200 and exact sale id remains available from sale status;
- worker readiness 200 with `bootstrapReconciled`, `consumerReady`, and
  `reconciliationHealthy` true;
- API readiness queue counts waiting/active/delayed/failed all zero;
- worker `activeJobs == 0`, `failedJobs == 0`, and no retained queue entries if present;
- two consecutive matching datastore snapshots at least 250 ms apart.

HTTP 503, PG/Redis errors, or nonzero queue depth before deadline are retryable observations, not
success. Deadline expiry emits the last complete observation and fails I4.

### 8.3 Bounded datastore reads

Postgres queries are parameterized by `sale_id`; no string interpolation. The audit uses:

- exact `sales` row;
- order counts by status;
- `GROUP BY user_id HAVING count(*) > 1` globally and in sale;
- sale order identity/time rows ordered and paged 500 at a time;
- outside-window count using `created_at < starts_at OR created_at >= ends_at`.

Redis key names come from `@flash/shared` builders. Read stock/config/metrics with bounded scalar
commands; enumerate buyers with `SSCAN COUNT 500` and reservations with `HSCAN COUNT 500` until
cursor `0`. `SMEMBERS`, `HGETALL`, and `KEYS` are forbidden even in local audit. Malformed
reservation values fail closed.

### 8.4 Exact joins and pass conditions

After convergence the pure evaluator enforces all §1 relations, plus:

- sale config equality across runner input, API, PG, and Redis;
- Redis buyer and reservation user sets byte-for-byte equal;
- each Redis `userId -> reservationId:reservedAtMs` matches one PG `persisted` row with the same
  user, UUID id, sale, and millisecond `created_at`;
- every PG persisted row matches Redis in the reverse direction;
- every PG compensated row is absent from Redis buyers/reservations;
- PG `reserved` count is zero;
- `expectedConfirmed == persisted + compensated`;
- scenario-specific exact counts from §6.

The CLI writes one `AuditReport` JSON atomically, prints a concise I1–I4 table, and exits 0 only
when all four invariants and all scenario postconditions pass.

### 8.5 Mandatory falsification tests

`load/audit.spec.ts` must prove the evaluator rejects, with the named invariant:

1. **I1 negative control:** stock below zero and persisted count greater than total;
2. **I2 negative control:** duplicate PG users and a buyer/reservation set mismatch;
3. **I3 negative control:** one start-minus-1 ms and one exact-end confirmation;
4. **I4 negative control:** k6 confirmed count exceeds terminal PG count, queue nonzero, and an
   unmatched Redis reservation;
5. malformed Redis ledger identity/timestamp;
6. a positive compensated terminal case where stock is returned and active sets exclude it.

These are synthetic evaluator fixtures—never mutations of a live database. A negative-control
test that would also pass under the unsafe fixture is itself a gate failure.

---

## 9. Observability and saturation evidence

For each repetition create the following beneath
`load/results/raw/<runId>/<scenario>/r<N>/`:

```text
k6-summary.json
k6-summary.txt
audit.json
runtime.json
compose-config.yml
container-inspect.json
container-stats.csv
api-readiness.jsonl
worker-readiness.jsonl
sale-metrics.jsonl
redis-info-before.txt
redis-info-after.txt
redis-slowlog.txt
postgres-before.json
postgres-after.json
api.log
worker.log
command-status.json
```

Requirements:

- `runtime.json`: UTC start/end, base commit, implementation digest, dirty path list, Node/pnpm,
  Docker/Compose/k6 versions, OS/kernel, logical CPU count, memory, disk, profile, scenario config,
  all resource/limiter values. Never include datastore passwords.
- `container-stats.csv`: one sample/s of CPU %, memory use/limit, network, and block I/O for API,
  worker, Redis, Postgres, and k6 while k6 is active. Sampling is single-flight and always stopped.
- readiness/metrics JSONL: one sample/s with local timestamp, HTTP status, latency, and parsed body.
- Redis before/after: `INFO memory`, `INFO stats`, `INFO clients`, `INFO persistence`, `INFO cpu`;
  after also `SLOWLOG LEN`, `SLOWLOG GET 128`, and `LATENCY LATEST`. Do not reset global stats or
  slowlog inside a repetition.
- Postgres before/after: scoped `pg_stat_database`, `pg_stat_activity` aggregates, total/active
  connections, transactions, tuples inserted, deadlocks, and temp files/bytes. No `pg_stat_reset`.
- logs use `docker compose logs --no-color --timestamps`; redact URLs and credentials.
- `command-status.json` records k6/audit/sampler/cleanup exit status even on failure.

Warnings that fail the benchmark rather than being waved away:

- any k6 dropped iteration;
- `rejected_connections > 0`, sustained Redis blocked clients unrelated to BullMQ, Redis OOM,
  Postgres deadlock, container OOM kill, API/worker restart, or worker readiness degradation;
- unhandled rejection, uncaught exception, retained malformed queue work, or unresolved failed job;
- sampler or subprocess leak after runner exit.

Resource saturation may explain a miss; it never converts a miss into a pass.

---

## 10. Results artifact and integrity

### 10.1 Tracked table

`load/results/phase-5-results.md` is generated from final raw JSON, then reviewed. Header fields:

- UTC date;
- base commit and implementation digest;
- exact hardware/runtime versions and resource limits;
- profile/repetition count;
- “local Docker baseline; not a production capacity claim”;
- tuning state: `none required` or retained candidate with evidence path;
- CI billing note from §12.

One row per repetition, then median and worst rows per scenario, with columns:

| Scenario | Rep | Target purchase/s | Achieved purchase/s | Dropped | HTTP failed % | Purchase p95 ms | Purchase p99 ms | Status p95 ms | Confirmed | Duplicate | Sold out | Window rejected | PG persisted | PG compensated | Redis stock | I1 | I2 | I3 | I4 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- |

Never print `PASS` for missing data. A failed repetition remains in the table and prevents the
Phase 5 gate even if a rerun later passes; a rerun must use a new repetition/run id and the reason
must be recorded.

### 10.2 Integrity file

`phase-5-results.sha256` contains SHA-256 lines for the tracked Markdown and every final
`k6-summary.json`, `audit.json`, and `runtime.json` used to produce it. Paths are repository-
relative and sorted bytewise. This is an integrity manifest, not a claim of author identity and
not a replacement for Git history. Phase 6 may quote the tracked table.

The implementation digest hashes all Phase 5 authored/modified implementation files except
`load/results/**`, sorted by path and content. That makes the pre-commit benchmark tree
re-identifiable without circularly hashing the generated results.

### 10.3 Ignore rules

`.gitignore` replaces the obsolete Phase 0 k6 result rows with:

```gitignore
load/results/raw/
load/results/**/*.tmp
```

It explicitly unignores/tracks `.gitkeep`, `phase-5-results.md`, and
`phase-5-results.sha256`. No raw evidence is committed; root retains the local artifact through
the gate and may attach it outside Git only with separate user authorization.

---

## 11. Environment variable contract

Append an exact `# stress (Phase 5 local isolated stack)` section to `.env.example`:

| Name | Type/default | Consumer | Rule |
| --- | --- | --- | --- |
| `STRESS_RUN_ID` | empty or run-id | runner | empty generates; validated §4.1 |
| `STRESS_REPETITIONS` | int `3` | full runner | 1–5; smoke forces 1 |
| `STRESS_API_PORT` | int `3300` | Compose/audit | loopback host bind; 1–65535 |
| `STRESS_WORKER_PORT` | int `3301` | Compose/audit | distinct/free |
| `STRESS_POSTGRES_PORT` | int `5543` | Compose/audit | distinct/free |
| `STRESS_REDIS_PORT` | int `6680` | Compose/audit | distinct/free |
| `STRESS_CONVERGENCE_TIMEOUT_MS` | int `120000` | audit | 10,000–300,000; smoke uses min(value, 60,000) |

`STRESS_PROFILE` and `STRESS_K6_IMAGE` are not user env: commands and Compose freeze them, so a
casual env override cannot weaken the gate or silently change the engine. The runner rejects
unrecognized `STRESS_*` variables rather than guessing. These variables are not Turbo task inputs
and are not added to `turbo.json`.

All ordinary application env names remain unchanged.

---

## 12. CI-safe smoke and current billing boundary

### 12.1 Workflow behavior

Replace `k6-smoke`'s `if: false` placeholder. Add a small `load-changes` job that runs for pull
requests and emits `run=true` when the base/head diff touches any of:

```text
apps/api/**
apps/worker/**
packages/redis/**
packages/shared/**
infra/**
load/**
scripts/stress.mjs
package.json
pnpm-lock.yaml
```

Use `actions/checkout@v4` with full enough history and `git diff --quiet` against the exact PR base
SHA; no third-party path-filter action. `k6-smoke` needs `build`, `integration`, and `load-changes`,
runs only for `pull_request` with `run == true`, and has `timeout-minutes: 15`.

The job uses Redis 7.4 and Postgres 16 service containers, applies
`infra/postgres/init/001_schema.sql`, generates a unique active smoke sale, builds API/worker,
starts both built processes with high finite benchmark limits, waits for readiness, installs k6
with `grafana/setup-k6-action@v1`, runs the exact 30 s/200 rps smoke, runs `@flash/load` audit, and
uploads summaries/audit/logs with `actions/upload-artifact@v4` under `if: always()`.

Every background PID is captured explicitly and terminated in an `if: always()` cleanup step.
No `nohup` process is allowed to outlive the job. Missing `psql`, k6, readiness, output, or audit
is a job failure—not a skip. Secrets/URLs are not printed.

### 12.2 Billing note

The workflow is a maintained deliverable, but GitHub Actions currently aborts before execution
because of the account billing/spending-limit condition recorded in `STATE.md`. Phase 5 therefore
does **not** require or claim a green Actions run. The authoritative gate is the root-orchestrator
local uncached graph plus local full stress evidence. Results and `STATE.md` must say “CI not run:
owner-authorized billing bypass,” never “CI green” or “CI failed due to code.”

---

## 13. Measured tuning and rollback evidence

### 13.1 Entry condition

T1 requires all of:

1. one untuned warmup + full baseline repetition completed;
2. k6 summary and audit exist even if threshold failed;
3. observability identifies a bounded hypothesis (for example Redis connection pressure, producer
   in-flight saturation, worker backlog, or PG pool contention);
4. I1–I4 audit is either green or the finding is escalated as correctness—not “performance tuned.”

No source change is permitted merely because a number “looks low.”

### 13.2 Candidate loop

For candidate `t<N>-<slug>`, preserve:

```text
load/results/raw/<runId>/tuning/t<N>-<slug>/hypothesis.md
load/results/raw/<runId>/tuning/t<N>-<slug>/before.json
load/results/raw/<runId>/tuning/t<N>-<slug>/after.json
load/results/raw/<runId>/tuning/t<N>-<slug>/change.patch
load/results/raw/<runId>/tuning/t<N>-<slug>/decision.md
```

Change one logical parameter/set at a time, run the implicated focused tests, rerun the identical
scenario seed/profile, and compare achieved rate, p95/p99, drops, resource/queue metrics, and all
invariants. Retain only if it removes the miss without regressing another frozen threshold or
invariant and the improvement exceeds normal repetition noise (at least 5% for a latency/rate
claim, unless it crosses a hard pass boundary with three repeatable passes).

If rejected, restore the exact pre-candidate files with `apply_patch`/normal edits (never
`git reset --hard` or broad checkout) and record `REVERTED` plus a zero diff for T1 paths. If
retained, `decision.md` records the alternative rejected and why. All final three repetitions run
after the last retained/reverted candidate.

### 13.3 Rollback gate

Before final stress, root proves:

- every rejected candidate has no remaining diff;
- every retained candidate is inside T1 ownership and has focused unit/type/build evidence;
- no threshold/config was weakened;
- no new env spelling is unrecorded;
- Lua/schema/shared API hashes match `phase-4-done` because T1 never owns them.

---

## 14. Verification and Phase 5 gate

### 14.1 L1 focused evidence

```bash
pnpm install --frozen-lockfile
pnpm --filter @flash/load lint
pnpm --filter @flash/load typecheck
pnpm --filter @flash/load test
pnpm exec prettier --check load scripts/stress.mjs package.json pnpm-workspace.yaml .env.example .gitignore
docker compose -p flash-load-contract -f load/docker-compose.yml config -q
node scripts/stress.mjs --help
```

The test output must name all six §8.5 controls. Compose rendering must show project-scoped
volumes/no `container_name`, exact image pins, resource limits, and no ordinary-stack port.

### 14.2 L2 focused evidence

```bash
pnpm exec prettier --check .github/workflows/ci.yml
rg -n "if: false|k6 smoke placeholder" .github/workflows/ci.yml  # ZERO
rg -n "setup-k6-action@v1|upload-artifact@v4|load-changes|timeout-minutes: 15" .github/workflows/ci.yml
```

Review the rendered YAML/job dependency graph. A live Actions run is not required under §12.2.

### 14.3 Root canonical uncached graph

Run from repo root; subagent reports are claims, not gate evidence:

```bash
pnpm install --frozen-lockfile
pnpm format:check
pnpm exec turbo run lint typecheck test build test:integration --force
pnpm audit --audit-level high
node scripts/assert-build-output.mjs apps/api/dist/main.js apps/worker/dist/main.js
docker compose -f infra/docker-compose.yml config -q
docker compose -p flash-load-contract -f load/docker-compose.yml config -q
git diff --check
```

Required: all tasks successful, `Cached: 0 cached`, no skipped/unhandled datastore failures, audit
clean, both Compose files render, and build artifacts exist.

### 14.4 Full stress gate

```bash
pnpm stress
```

Required evidence:

- one audited warmup, then three passing repetitions of surge, duplicate storm, sold-out, and
  window-edge;
- every k6 threshold passes individually; zero dropped iterations and zero unexpected responses;
- all 12 measured audit reports (four scenarios × three) pass I1–I4;
- exact fixed counts in §6; status p95 <50 ms and purchase p95/p99 <200/<500 ms;
- no OOM/restart/deadlock/rejected-connection/readiness/resource-leak warning from §9;
- tracked result Markdown and SHA-256 manifest regenerate byte-identically from final raw inputs;
- runner leaves no `flash-load-<runId>` containers, networks, volumes, samplers, API/worker, or k6
  processes; ordinary `flash-*` developer resources, if any, remain untouched.

If the current host cannot meet the minimum resources or Docker is unavailable, Phase 5 is
blocked—not passed with smoke, reduced VUs, fewer repetitions, or loosened thresholds.

### 14.5 Required greps/negative checks

```bash
rg -n "FLUSHALL|FLUSHDB|TRUNCATE|SMEMBERS|HGETALL|\\bKEYS\\b" load scripts/stress.mjs
# ZERO outside comments/tests that assert rejection; runtime source has zero.
rg -n "(/admin|/reset|/seed|test-only endpoint)" apps load scripts/stress.mjs
# ZERO new production route.
rg -n "rate<0\\.01|p\\(95\\)<200|p\\(99\\)<500|p\\(95\\)<50|count==0" load/k6
# exact frozen thresholds visible.
rg -n "phase-5-results|load/results/raw" .gitignore load/results
git diff --name-only phase-4-done -- packages/shared packages/redis/src/scripts infra/postgres/init
# ZERO unless a later architect amendment explicitly owns a path.
```

### 14.6 Adversarial review

After §§14.1–14.5 are green, reviewer must attempt at least:

- lower k6 maxVUs to prove dropped-iteration threshold catches generator saturation;
- feed synthetic audit oversell/duplicate/window/lost-confirmation fixtures;
- tamper k6 confirmed count and one Redis/PG identity to prove I4 join fails;
- collide a load port and use a malformed project/run id to prove safe fail-before-cleanup;
- interrupt runner during k6 and audit to prove only current project is cleaned and no sampler
  survives;
- force one expected business status with an invalid body and one 429/500 to prove it increments
  unexpected/failed metrics;
- inspect that scenario observer traffic does not contaminate purchase latency thresholds;
- verify metrics lag cannot be mistaken for I4 loss and also cannot satisfy I4;
- inspect every T1 candidate/rollback if tuning occurred.

Reviewer edits nothing. Critical findings return to the owning implementer; two repeats of one
design issue escalate to architect.

### 14.7 Gate ritual — root only

Only after all evidence and review pass:

1. root commits Phase 5 with a Conventional Commit;
2. root creates annotated tag `phase-5-done` with a one-line summary;
3. root updates `STATE.md` with uncached graph totals, stress table summary, artifact/digest, review
   sign-off, current CI billing bypass, open risks, and exact Phase 6 actions;
4. no implementer/reviewer edits `STATE.md`, commits, tags, pushes, or opens a PR unless separately
   authorized by the user.

---

## 15. ADR summary

| Decision | Alternative rejected | Why |
| --- | --- | --- |
| Run-scoped isolated Compose project | Reset endpoint, `FLUSHDB`, `TRUNCATE`, or normal developer volumes | Reproducible state without exposing destructive production behavior or erasing user data |
| Fixed alternate host ports + collision failure | Kill occupants or silently reuse ordinary ports | A benchmark must not disturb unrelated processes; explicit failure is diagnosable |
| Official pinned k6 container | Global k6 install or floating `latest` | Fresh-clone portability and repeatable engine behavior |
| High finite benchmark rate limits | Disable limiter code or benchmark default 20/s limiter | Keeps real middleware/Redis limiter cost while preventing intentional 429s from replacing the purchase workload |
| Mixed observers in separate k6 scenarios/tags | Put GETs inside purchase iteration | Purchase arrival rate stays exact and endpoint latency remains independently attributable |
| Expected business HTTP callbacks | Let 403/409/410 count as `http_req_failed` | Business rejections are correct behavior; malformed/429/5xx still fail |
| `dropped_iterations == 0` | Report configured target only | Proves the generator actually offered the requested rate |
| k6-confirmed → PG terminal equality | Trust Redis metrics counter | Fire-and-forget metrics are observability, not durable confirmation authority |
| Cursor-paged Redis/PG audit | `SMEMBERS`, `HGETALL`, or unbounded row materialization | Bounded evidence collection cannot stall Redis or explode audit memory |
| Three final repetitions; every run must pass | One best run or median-only gate | Prevents transient lucky runs from becoming a capacity claim |
| Tune only after measured baseline | Pre-emptive refactor/config inflation | Preserves correctness and creates defensible before/after evidence |
| Local evidence while Actions billing is blocked | Pretend CI green or wait indefinitely | Matches owner decision in `STATE.md` while keeping the workflow ready to execute later |

---

## 16. Copy-ready dispatch briefs

### Brief L1 — load harness and audit

> Work on branch `phase-5/stress` from `phase-4-done`. You are not alone in the repository: preserve
> unrelated edits and never revert another agent. Read `PRD.md`, `AGENTS.md`, `STATE.md`, and the
> entire frozen `.claude/contracts/phase-5.md`. Load skills in this exact order: `k6` first, then
> `redis-core`, `redis-connections`, `redis-observability`, `postgresql-table-design`,
> `multi-stage-dockerfile`, `turborepo-monorepo`, and `vitest`. Own only L1 paths in §2. Implement
> §§3–11 exactly: isolated project-scoped Compose runtime, deterministic scenarios, strict
> thresholds, convergence/audit joins, six falsification controls, evidence capture, and tracked
> result generator. Never touch ordinary developer volumes, application/shared/Redis-package/
> production-infra/CI paths, `.codex/`, `STATE.md`, tags, or commits. Run §14.1 and return actual
> output plus any ambiguity; do not weaken a threshold or skip a failed audit.

### Brief L2 — CI smoke

> You are not alone in the repository: preserve unrelated edits and never revert another agent.
> Read the frozen Phase 5 contract. Load `k6`, then `turborepo-monorepo`. Own only
> `.github/workflows/ci.yml`; consume L1's exact `smoke.js`, audit CLI, env, and artifact names.
> Implement §12's path-aware PR smoke job with bounded background processes and always-run evidence
> upload/cleanup. Do not edit load/application/infra/package/lock/state/contract files or `.codex/`.
> Run §14.2 and return actual output. Do not claim a live green Action: billing remains unavailable.

### Brief T1 — measured tuning, only when root supplies baseline evidence

> This brief is invalid unless the root attaches the untuned baseline summary, audit, and a named
> bottleneck hypothesis. You are not alone in the repository: preserve unrelated edits and never
> revert another agent. Read Phase 5 §§2 and 13; load `nestjs-best-practices`,
> `redis-connections`, `redis-observability`, `bullmq-specialist`,
> `postgresql-table-design`, and `vitest`. Own only the T1 whitelist. Change one bounded
> connection/pool/concurrency/backpressure hypothesis, preserve I1–I4 and all semantics, write the
> required before/after/patch/decision evidence, and retain only a repeatable improvement. Revert a
> rejected candidate by ordinary scoped edits and prove zero candidate diff. Do not touch Lua,
> schema, shared contracts, load harness/results, lockfile, CI, state, contract, `.codex/`, commits,
> or tags. Return focused tests and identical-scenario comparison.

### Brief adversarial reviewer

> Review only after the root has independently passed §§14.1–14.5. Read all of Phase 5 and inspect
> the full diff/evidence with explicit intent to break I1–I4, generator truthfulness, window edges,
> safe cleanup, convergence, and result integrity. Execute §14.6 attacks, including negative
> controls and interruption/port-collision probes. If tuning occurred, verify every candidate and
> rollback. Report APPROVE or severity-ranked findings with exact file/line/evidence. Edit nothing;
> do not touch `.codex/`, state, tags, commits, or PRs.

---

## 17. Frozen decision index

- Workloads/rates/counts: §6.
- Thresholds and expected-status semantics: §5.
- Deterministic identities and repetitions: §4.
- Isolated stack, ports, resources, lifecycle: §7 and §11.
- I1–I4 audit/convergence/falsification: §§1 and 8.
- Raw/tracked evidence and table schema: §§9–10.
- CI billing-safe behavior: §12.
- Tuning entry/rollback: §13.
- Ownership, sequence, skills, and briefs: §§2 and 16.
- Gate commands: §14.

---

## 18. AMENDMENT A1 — auditable warmup discriminator and result exclusion

**Status:** FROZEN corrective amendment after L1 identified a pre-implementation schema
ambiguity.
**Amends:** §§3.3, 4.3, 5.4, 6.1, 8.1, 8.4, 8.5, 10.1, 10.2, 14.1, and Brief L1.
**Ownership:** unchanged. Only the existing L1 paths named in §2 may implement this amendment.

### 18.1 Finding and decision

Section 6.1 requires warmup to run the full invariant audit, but §3.3's original
`STRESS_SCENARIOS` tuple omitted `warmup`. Because `AuditReport.scenario` and the audit CLI's
`--scenario` validation derive from that tuple, an honest warmup report could not be represented.
Encoding it as `smoke` would falsify the workload identity; skipping its audit would violate §6.1.

**Decision:** `warmup` is an auditable `StressScenario`, but it is not a
`MeasuredStressScenario`. Full-run orchestration and the integrity manifest require its evidence;
the Phase 5 performance table and repetition aggregates exclude it. Smoke profile still runs no
warmup.

### 18.2 Exact schema amendment — supersedes §3.3 tuple/types

`load/contracts.ts` exports exactly:

```ts
export const STRESS_SCENARIOS = [
  'warmup',
  'smoke',
  'surge',
  'duplicate-storm',
  'sold-out',
  'window-edge',
] as const;
export type StressScenario = (typeof STRESS_SCENARIOS)[number];

export const MEASURED_STRESS_SCENARIOS = [
  'smoke',
  'surge',
  'duplicate-storm',
  'sold-out',
  'window-edge',
] as const satisfies readonly Exclude<StressScenario, 'warmup'>[];
export type MeasuredStressScenario = (typeof MEASURED_STRESS_SCENARIOS)[number];
```

The original `InvariantResult` and `AuditReport` shapes remain unchanged except that
`AuditReport.scenario: StressScenario` now legally includes `warmup`. `schemaVersion` remains `1`:
no implemented or persisted Phase 5 report predates this pre-implementation correction.

Code that decides table/repetition behavior must use `MeasuredStressScenario` or membership in
`MEASURED_STRESS_SCENARIOS`; it must not use a string inequality scattered through the runner.

### 18.3 CLI and k6 summary amendment

`load/audit.ts --scenario` accepts exactly the six `STRESS_SCENARIOS`, including `warmup`, and
rejects anything else before opening a datastore. A warmup report writes:

```text
load/results/raw/<runId>/warmup/r1/audit.json
```

`warmup.js` writes its existing summary contract to:

```text
/results/warmup/r1/k6-summary.json
/results/warmup/r1/k6-summary.txt
```

Its `phase5.scenario` is exactly `warmup`, `phase5.repetition` is exactly `1`, and its profile is
exactly `full`. It must never be labeled `smoke` or assigned a measured scenario token.

The runner passes `--scenario warmup`, `--initial-stock 200`, and the parsed
`purchase_confirmed` count as `--expected-confirmed`. Warmup's exact healthy postcondition is 200
confirmed, 200 persisted, 0 compensated, Redis stock 0, and I1–I4 all pass. A warmup threshold or
audit failure stops the full run before measured scenarios but still captures §9 evidence and
performs scoped cleanup.

### 18.4 Profile and result handling

Full profile execution is exactly:

1. one `warmup/r1` run and audit;
2. three repetitions each of the four full measured scenarios: surge, duplicate-storm, sold-out,
   and window-edge.

Smoke profile remains exactly one `smoke/r1` run with no warmup.

`load/results/phase-5-results.md` must contain a separate preflight block above the measured table:

```text
Warmup preflight: PASS | sale=<saleId> | confirmed=200 | audit=<relative audit path>
```

On warmup failure it says `FAIL` and the Phase 5 gate fails. Warmup has no measured table row and
is excluded from median/worst calculations, target-rate claims, and the count of 12 measured audit
reports. The report generator rejects:

- a full run with zero or more than one warmup report;
- warmup with repetition other than 1;
- warmup included in a measured aggregate;
- any of the 12 required measured reports missing;
- any smoke-profile artifact incorrectly claiming a warmup.

Section 10.2's integrity manifest **does include** the final warmup `k6-summary.json`, `audit.json`,
and `runtime.json`, because warmup is gate evidence even though it is not a measured result row.

### 18.5 Required tests and focused evidence

Add these named cases within L1's existing `load/audit.spec.ts` ownership or another test file only
if that file was already named in L1 ownership (no new path is authorized):

1. `A1 — STRESS_SCENARIOS includes warmup and all five measured scenarios exactly`;
2. `A1 — MEASURED_STRESS_SCENARIOS excludes warmup exactly`;
3. `A1 — audit CLI accepts warmup and emits scenario warmup`;
4. `A1 — audit CLI rejects an unknown scenario before datastore connection`;
5. `A1 — full result aggregation requires exactly one passing warmup but excludes it from 12 measured rows and median/worst calculations`;
6. `A1 — smoke profile rejects or omits warmup and still requires smoke/r1`;
7. `A1 — integrity inputs include warmup evidence`.

If runner/result aggregation is tested outside `load/audit.spec.ts`, L1 must first escalate because
§2 did not authorize another test-file path. Do not create an unowned file merely to satisfy the
test grouping.

Run the original §14.1 commands. In addition, return direct evidence:

```bash
rg -n "warmup|MEASURED_STRESS_SCENARIOS" load/contracts.ts load/audit.ts load/audit.spec.ts scripts/stress.mjs
pnpm --filter @flash/load test
```

Test output must name all seven A1 cases in addition to the six original §8.5 falsification
controls.

### 18.6 Invariant and ownership effect

- **I1/I2/I3:** warmup is audited under its true sale/scenario identity; no enforcement changes.
- **I4:** the required warmup confirmations can no longer disappear from evidence due to an
  unrepresentable discriminator.
- L1 ownership, dependency/image pins, thresholds, safe cleanup, L2 CI smoke behavior, and T1
  ownership remain unchanged.
- No application, Lua, schema, shared DTO, queue, CI, `STATE.md`, `.codex/`, commit, or tag edit is
  authorized by this amendment.

### 18.7 Copy-ready L1 correction brief

> **Phase 5 Amendment A1 correction.** You are not alone in the repository; preserve unrelated
> edits and do not revert another agent. Read `.claude/contracts/phase-5.md` §18 completely. Within
> the existing L1 ownership only, add `warmup` to the auditable `STRESS_SCENARIOS`, add the exact
> `MEASURED_STRESS_SCENARIOS`/`MeasuredStressScenario` exports, make the audit CLI accept and emit
> truthful `scenario: warmup`, and enforce one audited `warmup/r1` before the full measured suite.
> Keep warmup out of the 12 measured rows and all median/worst calculations, but include its
> summary/audit/runtime files in the integrity manifest and the results preflight block. Implement
> all seven named §18.5 cases and rerun §14.1 plus the amendment grep. Do not relabel warmup as
> smoke, skip its audit, change `schemaVersion`, add an unowned test path, or touch any path outside
> L1 ownership. All earlier skills, thresholds, images, safety rules, and forbidden paths remain
> binding.

---

## 19. AMENDMENT A2 — parser-safe mixed-file formatting and exact text-row verification

**Status:** FROZEN corrective amendment after L1 reproduced the original §14.1 command failure.
**Amends:** §14.1, Brief L1, and Amendment A1's instruction to rerun §14.1.
**Ownership:** unchanged. No new file or path is authorized.

### 19.1 Finding and decision

The original focused command passed `.env.example` and `.gitignore` directly to Prettier 3.
Prettier has no parser for either filename in this repository and there is no configured override,
so the exact command fails even when their content is correct.

**Decision:** use Prettier's `--ignore-unknown` for the mixed file list, then close the resulting
blind spot with:

1. `git diff --check` over tracked L1 modifications for whitespace/error-marker evidence; and
2. a read-only Node assertion that verifies every authorized `.env.example` and `.gitignore` row
   exactly once, rejects any extra `STRESS_*` spelling, and rejects the obsolete Phase 0 result
   patterns.

Do not add `.prettierignore` ownership, rename the files, invent a parser override, or omit them
from verification without the exact-row assertion.

### 19.2 Exact §14.1 replacement

The following block **supersedes the entire command block in §14.1**. Run from repository root:

```bash
pnpm install --frozen-lockfile
pnpm --filter @flash/load lint
pnpm --filter @flash/load typecheck
pnpm --filter @flash/load test
pnpm exec prettier --check --ignore-unknown --ignore-path .gitignore --ignore-path .prettierignore load scripts/stress.mjs package.json pnpm-workspace.yaml .env.example .gitignore
git diff --check -- load scripts/stress.mjs package.json pnpm-workspace.yaml pnpm-lock.yaml .env.example .gitignore
node --input-type=module -e "import fs from 'node:fs'; const env=fs.readFileSync('.env.example','utf8').split(/\\r?\\n/); const gitignore=fs.readFileSync('.gitignore','utf8').split(/\\r?\\n/); const once=(rows,value,file)=>{const count=rows.filter((row)=>row===value).length;if(count!==1)throw new Error(file+': expected exactly one '+JSON.stringify(value)+', found '+count)}; const envRows=['# stress (Phase 5 local isolated stack)','STRESS_RUN_ID=','STRESS_REPETITIONS=3','STRESS_API_PORT=3300','STRESS_WORKER_PORT=3301','STRESS_POSTGRES_PORT=5543','STRESS_REDIS_PORT=6680','STRESS_CONVERGENCE_TIMEOUT_MS=120000']; for(const row of envRows)once(env,row,'.env.example'); const allowedEnvRows=new Set(envRows.filter((row)=>row.startsWith('STRESS_'))); const extraEnvRows=env.filter((row)=>row.startsWith('STRESS_')&&!allowedEnvRows.has(row)); if(extraEnvRows.length)throw new Error('.env.example: unexpected STRESS_* rows: '+extraEnvRows.join(',')); const ignoreRows=['load/results/raw/','load/results/**/*.tmp','!load/results/.gitkeep','!load/results/phase-5-results.md','!load/results/phase-5-results.sha256']; for(const row of ignoreRows)once(gitignore,row,'.gitignore'); for(const obsolete of ['load/k6/results/','load/k6/*.summary.json','k6-results.json','k6-summary.json'])if(gitignore.includes(obsolete))throw new Error('.gitignore: obsolete Phase 0 result row remains: '+obsolete);"
docker compose -p flash-load-contract -f load/docker-compose.yml config -q
node scripts/stress.mjs --help
```

The Node assertion is intentionally inline and read-only. It creates no verification helper and
therefore does not widen L1's file tree. An assertion error is a focused-gate failure.

### 19.3 Required evidence and interpretation

L1 returns the actual output and exit status for every §19.2 command. Evidence must show:

- Prettier checks every supported file and reports no formatting failure; “ignored unknown” for
  `.env.example` / `.gitignore` is expected only because the following checks cover them;
- `git diff --check` is clean for all tracked L1 modifications;
- the Node assertion exits 0 with no output, proving exact authorized rows and no obsolete/extra
  spelling;
- the original §14.1 functional requirements still hold: all original and A1 tests pass, Compose
  is project-scoped with exact images/resources/ports, and `--help` is successful.

At the root gate, the existing repository-wide `pnpm format:check` remains binding. This amendment
changes only L1's mixed-file focused invocation; it does not weaken §14.3.

### 19.4 Ownership, invariants, and forbidden work

- No I1–I4 semantics change. This amendment makes verification executable without hiding the two
  non-Prettier files that carry safe isolation and cleanup configuration.
- L1 ownership remains exactly §2. `.prettierignore`, Prettier config, tooling presets, application,
  CI, production infra, shared/Redis/schema paths, `STATE.md`, `.codex/`, commits, and tags remain
  forbidden.
- L2 and T1 are unaffected.
- Amendment A1's “rerun §14.1” now means the replacement block in §19.2.

### 19.5 Copy-ready L1 correction brief

> **Phase 5 Amendment A2 verification correction.** Read `.claude/contracts/phase-5.md` §19
> completely. Do not change implementation solely to satisfy Prettier's lack of parsers for
> `.env.example` or `.gitignore`. Within unchanged L1 ownership, run the exact replacement block in
> §19.2: Prettier with `--ignore-unknown`, scoped `git diff --check`, the inline exact-row Node
> assertion, Compose config, and runner help. Return actual output and exit status. Do not edit
> `.prettierignore`, add a helper/config/parser override, remove either file from evidence, tolerate
> an extra `STRESS_*` row, retain an obsolete Phase 0 result-ignore row, or touch any path outside
> L1 ownership. Amendment A1 and every original functional/invariant requirement remain binding.

---

## 20. AMENDMENT A3 — non-root k6 bind-mount write ownership and failed-baseline disposition

**Status:** FROZEN corrective amendment after the first untuned baseline warmup completed HTTP
load but k6 could not write its bind-mounted summary files.
**Amends:** §§5.4, 7.1, 7.3, 9, 10, 14.1, Brief L1, and Amendments A1–A2.
**Ownership:** unchanged. Only existing L1 paths in §2 may implement this amendment.

### 20.1 Reproduced failure and classification

The pinned `grafana/k6:1.7.1` container ran warmup to completion and observed 200 confirmations at
low latency, then received permission denied writing:

```text
/results/warmup/r1/k6-summary.json
/results/warmup/r1/k6-summary.txt
```

The host runner had created the bind-mounted result tree as the invoking host user; the container's
default numeric user did not own that tree. Because the summary was absent, the runner correctly
did not start audit or measured scenarios and completed scoped cleanup without changing the
tracked results Markdown/manifest hashes.

This attempt is **not a correctness verdict**. The 200 HTTP confirmations and low latency are
diagnostic only: without the summary-driven expected-confirmed count and I1–I4 audit, neither pass
nor failure may be claimed.

The captured warmup evidence also contained a transient worker readiness HTTP 503. Preserve that
observation with the failed run. It does not by itself prove an invariant violation because no
audit completed. On the new run, readiness sampling and audit remain binding; if a transient 503
recurs after initial readiness while measured/warmup load is active, §9 treats it as an operational
benchmark failure requiring log/state diagnosis, while I1–I4 are reported only from a completed
audit.

### 20.2 Decision — derive and map the invoking non-root POSIX identity

On the supported local/CI execution surface (Linux, including WSL and GitHub-hosted Ubuntu), the
runner derives the invoking numeric identity from `process.getuid()` and `process.getgid()` and
runs only the k6 service as that exact `uid:gid`. The host-created bind-mount tree and the k6
process therefore share ownership without changing file modes.

The runner freezes two **internal Compose interpolation variables**:

```text
PHASE5_K6_UID
PHASE5_K6_GID
```

Rules:

- values come only from `process.getuid()` / `process.getgid()`; pre-existing environment values
  under these names are overwritten for every Compose child process and cannot bypass validation;
- both must be base-10 safe integers in `1..2147483647`; UID/GID `0`, missing POSIX APIs,
  fractional/signed/padded/non-decimal values, or overflow fail before Compose startup;
- they are internal, not user configuration: do not add them to `.env.example`, Turbo, the
  documented `STRESS_*` surface, or result-table knobs;
- the runner logs the validated numeric identity in `runtime.json`, never a username or host home
  path;
- non-POSIX hosts fail with an explicit “Phase 5 load runner requires a non-root POSIX UID/GID”
  message. This contract does not guess Docker Desktop VM ownership semantics.

Running k6 as root, `chmod 777`, `chmod -R`, `a+w`, `o+w`, ACL mutation, `chown`, privileged mode,
or a world/group-writable result tree is forbidden. Directory ownership—not broad permission—is
the mechanism.

### 20.3 Exact Compose amendment

Within the existing `load/docker-compose.yml` k6 service, add exactly:

```yaml
user: '${PHASE5_K6_UID:?PHASE5_K6_UID is required}:${PHASE5_K6_GID:?PHASE5_K6_GID is required}'
read_only: true
environment:
  # existing k6 environment remains
  HOME: /tmp/k6-home
  XDG_CONFIG_HOME: /tmp/k6-home/.config
  PHASE5_K6_UID: '${PHASE5_K6_UID:?PHASE5_K6_UID is required}'
  PHASE5_K6_GID: '${PHASE5_K6_GID:?PHASE5_K6_GID is required}'
tmpfs:
  - /tmp:rw,nosuid,nodev,noexec,mode=1777,size=64m
```

Keep both existing mounts unchanged in meaning:

```yaml
- ./k6:/scripts:ro
- ${RAW_RESULT_DIR:-./results/raw/contract-render}:/results
```

The runner must always pass `RAW_RESULT_DIR` as an absolute resolved path for real execution. The
contract-render fallback exists only so a read-only `docker compose config` can render; a live
runner must not rely on it. Do not grant write access to `/scripts`, the image root filesystem, or
any host path other than the run-scoped `/results` bind mount.

Only k6 receives `user:`. Redis, Postgres, API, and worker retain their image/runtime identities.

### 20.4 Exact runner changes and permission probe

Before any Compose `up`, `scripts/stress.mjs`:

1. derives and validates §20.2 UID/GID;
2. resolves `config.runDir` to an absolute path;
3. creates `runDir` and every `<scenario>/r<N>` directory from the host process with
   `mkdir({ recursive: true, mode: 0o700 })`;
4. never calls `chmod` or `chown`; the `mode` applies only when this process creates a directory;
5. injects validated `PHASE5_K6_UID`, `PHASE5_K6_GID`, and absolute `RAW_RESULT_DIR` into every
   Compose child environment, replacing any inherited values.

After creating a scenario directory and before starting samplers or the real k6 workload, run this
container-side probe through the same Compose service, user, and mount:

```text
docker compose -p <project> -f load/docker-compose.yml --profile k6 run --rm --no-deps
  --entrypoint /bin/sh
  -e PHASE5_PROBE_PATH=/results/<scenario>/r<N>/.phase5-write-probe
  k6 -eu -c 'umask 077; : > "$PHASE5_PROBE_PATH"; test -f "$PHASE5_PROBE_PATH"; rm "$PHASE5_PROBE_PATH"'
```

The implementation invokes Docker with an argv array—never a shell-joined host command. Scenario
and repetition are selected only from the frozen scenario union and validated positive repetition,
so `PHASE5_PROBE_PATH` cannot contain traversal or shell syntax.

The runner then verifies from the host that `.phase5-write-probe` no longer exists and writes
host-owned `permission-probe.json` atomically with:

```jsonc
{
  "uid": 1000,
  "gid": 1000,
  "containerExitCode": 0,
  "probeCreatedAndRemoved": true
}
```

The numbers are examples; actual validated values are recorded. Do not include host usernames,
paths, or environment dumps.

If the probe fails, times out, leaves the probe behind, or cannot start:

- do not start k6, samplers, or audit for that scenario;
- capture probe stdout/stderr and exit code in `permission-probe.json`/`command-status.json`;
- run the normal scoped project cleanup;
- exit nonzero with a permission-preflight error, not a workload/invariant result.

The real k6 run uses the identical k6 service and Compose environment. Its summary paths remain
the A1 paths; no stdout-summary redesign or alternate host writer is authorized by A3.

### 20.5 Tests and negative controls

Add these named cases to the existing L1-owned `load/audit.spec.ts`; no new test path:

1. `A3 — runner derives non-root POSIX UID and GID and overwrites inherited internal values`;
2. `A3 — missing POSIX identity or UID/GID zero fails before Compose`;
3. `A3 — rendered k6 service uses exact uid:gid, read-only root, private tmpfs, and read-only scripts`;
4. `A3 — successful permission probe removes its file before k6 starts`;
5. `A3 — failed permission probe prevents k6, sampler, and audit and still requests scoped cleanup`;
6. `A3 — runner passes an absolute RAW_RESULT_DIR and never invokes chmod, chown, or a shell-joined Docker command`;
7. `A3 — stale user-supplied PHASE5_K6_UID/GID values cannot override derived identity`.

Test seams may inject the two identity functions and command executor, but production defaults must
remain the real `process.getuid`/`process.getgid` and argv-based Docker runner. Do not weaken the
actual probe into a mocked-only assertion.

### 20.6 Focused verification — supersedes A2 Compose render row

Run every A2 §19.2 command, except replace its Compose render command with the exact identity-aware
form below:

```bash
PHASE5_K6_UID="$(id -u)" PHASE5_K6_GID="$(id -g)" RAW_RESULT_DIR=/tmp/phase5-contract-results docker compose -p flash-load-contract -f load/docker-compose.yml config -q
```

Before running it, `test "$(id -u)" -gt 0` and `test "$(id -g)" -gt 0` must both succeed. The
focused evidence additionally includes:

```bash
rg -n "PHASE5_K6_UID|PHASE5_K6_GID|permission-probe|RAW_RESULT_DIR" load/docker-compose.yml scripts/stress.mjs load/audit.spec.ts
rg -n "chmod|chown|0777|a\\+w|o\\+w|privileged" load scripts/stress.mjs
# ZERO runtime use; named negative-test descriptions may match and must be identified as tests.
pnpm --filter @flash/load test
```

Then perform one real probe without a workload by using the runner's tested permission-preflight
seam or the exact Compose `run` form in §20.4 against a temporary `/tmp/phase5-contract-results`
tree owned by the invoking user. Remove only that exact temporary tree after the probe. Evidence
must show the container's `id -u`/`id -g` equal the host-derived values, the probe was created and
removed, and no Compose project resources remain.

Test output must name all seven A3 cases, all seven A1 cases, and the original six §8.5
falsification controls.

### 20.7 Failed run, new run ID, and tracked artifacts

The permission-denied baseline run is immutable diagnostic evidence:

- do not reuse its `STRESS_RUN_ID`;
- do not write missing audit/summary files into its directory after the fact;
- do not merge it into a later run or use it as a tuning baseline;
- keep its tracked results/manifest hashes unchanged and exclude it from the final manifest;
- retain its logs/readiness/command status locally until Phase 5 closes.

After A3 implementation and the root uncached graph pass, root chooses a wholly new valid run ID
and reruns the complete untuned baseline: one audited warmup plus one repetition of all four full
scenarios. Only that completed run can decide “no tuning required” versus T1 dispatch.

The failed run's transient worker readiness 503 is called out in the new baseline handoff. The new
run must preserve per-second worker readiness evidence so recurrence can be correlated with worker
logs, reconciliation state, queue depth, container restart/OOM state, and audit results. Absence of
recurrence is recorded; it does not retroactively turn the failed run into a pass.

Baseline runs, including the new completed baseline, remain raw-only and must not modify
`load/results/phase-5-results.md` or `load/results/phase-5-results.sha256`. Only the designated
three-repetition final run owns those tracked contents.

### 20.8 Invariants and ownership

- **I1–I4:** unchanged. A3 restores the evidence channel needed to judge them; it does not infer
  correctness from the 200 warmup responses.
- The permission probe performs no API, Redis, PG, or queue mutation.
- No broad permission, root/privileged container, endpoint, schema, Lua, DTO, queue, threshold,
  workload, resource-limit, dependency, image, or env-user-surface change is authorized.
- L1 ownership remains exactly §2. L2, T1, application/shared/Redis-package/production-infra,
  `.prettierignore`, `STATE.md`, `.codex/`, commits, and tags remain untouched.

### 20.9 Copy-ready A3 correction brief

> **Phase 5 Amendment A3 permission correction.** You are not alone in the repository; preserve
> unrelated edits and do not revert another agent. Read `.claude/contracts/phase-5.md` §20 fully.
> Within existing L1 ownership only, derive validated non-root POSIX UID/GID from
> `process.getuid()`/`process.getgid()`, override the frozen internal Compose variables, run the k6
> service as that exact numeric identity with read-only root/scripts and private tmpfs, resolve the
> run bind mount absolutely, and precreate result directories at mode 0700 without chmod/chown.
> Add the exact container-side write/delete probe before samplers/k6/audit and fail as permission
> preflight with scoped cleanup if it does not pass. Implement all seven A3 tests and run §20.6 plus
> the still-binding A2/A1 checks. Do not use root, privileged mode, chmod/chown/ACLs, world/group
> write, stdout summary redesign, user-configurable UID/GID, a shell-joined Docker command, a new
> test path, or any path outside L1 ownership. Do not reuse or backfill the failed baseline run ID;
> its warmup and transient worker 503 remain diagnostic, not an I1–I4 verdict.

---

## 21. AMENDMENT A4 — executable audit command and race-safe reconciliation identity check

**Status:** FROZEN corrective amendment after the `baseline-20260723-a3` warmup.
**Amends:** §§0.2, 2, 8.4, 9, 13.1, 14, 16, 20.7–20.9, and inherited Phase 3 §8.2.
**Supersedes:** A3's instruction to start another baseline immediately after A3 verification.
**Disposition:** `baseline-20260723-a3` is immutable failed diagnostic evidence. A wholly new run ID
is mandatory after every A4 slice and the root graph are green.

### 21.1 Two reproduced blockers

#### Finding 1 — pnpm parses `audit` as its built-in command

L1 currently invokes this argv shape:

```text
pnpm --filter @flash/load audit -- --run-id ...
```

With pinned pnpm 11.9.x, `audit` resolves to pnpm's built-in dependency-audit command rather than
the `@flash/load` package script and exits with `ERR_PNPM_AUDIT_UNKNOWN_SUBCOMMAND`. The audit
therefore never runs even after k6 succeeds. This is a deterministic runner defect, not an audit
or invariant result.

The only authorized invocation is:

```text
pnpm --filter @flash/load run audit -- --run-id <runId> --scenario <scenario> ...
```

The literal `run` is load-bearing. The runner must use argv execution, not a shell string, and all
existing arguments/order after the package-script separator remain unchanged.

#### Finding 2 — the continuous reconciliation pass observes two non-snapshot scans

The A3 worker log records:

```text
2026-07-22T23:49:22.396Z reconciliation.failed:
  unrecoverable buyer-only identity for p5_60723-a3_warm_000129
2026-07-22T23:49:24.413Z reconciliation.failed:
  unrecoverable buyer-only identity for p5_60723-a3_warm_000169
```

The readiness sampler was healthy through `23:49:20.653Z`, returned 503 at `23:49:22.654Z` and
`23:49:24.654Z` with `activeJobs=0`, `failedJobs=0`, then returned 200 at `23:49:26.657Z`.

The implementation order in `ReconciliationService.runDiff()` is:

1. page Postgres orders;
2. page BullMQ states;
3. fully HSCAN Redis reservations into `ledgerByUser`;
4. later SSCAN buyers;
5. classify a scanned buyer absent from the old `ledgerByUser` map as unrecoverable without the
   targeted `getReservation()` required by frozen Phase 3 §8.2 step 6.

Redis `HSCAN` and `SSCAN` are bounded but are not one cross-key snapshot. A purchase committed by
the atomic purchase Lua script after step 3 and before step 4 exists in both Redis structures, yet
the old process-local map lacks it. The current code therefore emits a false buyer-only incident,
sets `reconciliationHealthy=false`, and correctly exposes that state as readiness 503. A later pass
sees the reservation and clears health, matching the A3 timeline.

This is a correctness implementation defect, not load saturation and not evidence for tuning.
No threshold, workload rate, reconciliation interval, readiness rule, or resource limit may be
relaxed to hide it.

### 21.2 Narrow scope exception and ownership

Phase 5 §0.2 remains binding except for this explicit correction. A4 may add one **read-only**
Redis Lua inspection primitive and repair the Phase 3 reconciliation implementation. It may not
change purchase, compensation, restoration, stock, queue, HTTP, schema, DTO, key, or timing
semantics.

No two A4 slices own one path. They may run only in the dependency order below. Every implementer
is told that other work is present, must preserve unrelated edits, and must not revert another
agent.

#### A4-L — runner command correction (`implementer`)

Mandatory skills: `k6`, then `turborepo-monorepo`, then `vitest`.

```text
scripts/stress.mjs                                    ~
load/audit.spec.ts                                    ~
```

A4-L may land independently of A4-R. It changes only the pnpm argv and its regression test; all
A1–A3 runner behavior remains binding.

#### A4-R — atomic read-only Redis identity inspection (`implementer`)

Mandatory skills: `redis-core`, then `redis-connections`, then `vitest`.

```text
packages/redis/src/scripts/inspect-reservation-membership.lua.ts  +
packages/redis/src/scripts/registry.ts                            ~
packages/redis/src/scripts/registry.spec.ts                       ~
packages/redis/src/types.ts                                       ~
packages/redis/src/sale-store.ts                                  ~
packages/redis/src/sale-store.reconcile.spec.ts                   ~
packages/redis/src/index.ts                                       ~
```

#### A4-W — worker reconciliation correction (`implementer`)

Mandatory skills: `bullmq-specialist`, `redis-core`, `redis-connections`,
`postgresql-table-design`, then `vitest`.

```text
apps/worker/src/reconciliation/reconciliation.service.ts          ~
apps/worker/src/reconciliation/reconciliation.service.spec.ts     ~
```

A4-W starts only after A4-R is complete and verified.

#### A4-I — real concurrent datastore regression (`implementer`)

Mandatory skills: `bullmq-specialist`, `redis-core`, `redis-connections`,
`postgresql-table-design`, then `vitest`.

```text
apps/worker/test/integration/failure-modes.integration.spec.ts    ~
```

A4-I starts only after A4-W is complete and verified. It owns no support/harness path; if the
required deterministic barrier cannot be expressed in this file against the existing harness, it
must escalate rather than widen ownership.

**Forbidden to all A4 slices:** every T1 path not explicitly listed above, environment/schema/shared
contracts, purchase/compensation Lua, production Compose, load thresholds/scenarios, result
tables/manifests, `.env.example`, lockfile/dependencies, `STATE.md`, `.codex/`, commits, and tags.

### 21.3 Frozen Redis interface

`@flash/redis` adds these public names:

```ts
export type ReservationMembershipOutcome =
  | 'BOTH'
  | 'NEITHER'
  | 'BUYER_ONLY'
  | 'RESERVATION_ONLY';

export interface ReservationMembershipInspection {
  outcome: ReservationMembershipOutcome;
  reservation: ReservationEntry | null;
}

SaleRedisStore.prototype.inspectReservationMembership(
  saleId: string,
  userId: string,
): Promise<ReservationMembershipInspection>;
```

The script names are frozen:

```ts
export const INSPECT_RESERVATION_MEMBERSHIP_LUA_SRC: string;
export const INSPECT_RESERVATION_MEMBERSHIP_SCRIPT: LuaScript;
```

`LuaScript['name']` gains exactly `'inspect-reservation-membership'`; the registry entry has
`numKeys: 2` and is appended to `LUA_SCRIPTS`. The package root exports both new types and
`INSPECT_RESERVATION_MEMBERSHIP_SCRIPT`; it does not export the raw Lua source, matching the
existing registry convention.

The method validates `saleId` with `assertSaleId` and validates `userId` with the existing frozen
trim/length/pattern rules (`USER_ID_MIN_LENGTH`, `USER_ID_MAX_LENGTH`, `USER_ID_PATTERN`) before
calling Redis. Invalid input throws `TypeError('Invalid reservation-membership userId')`.

The script receives:

```text
KEYS[1] = sale:{<saleId>}:buyers
KEYS[2] = sale:{<saleId>}:reservations
ARGV[1] = userId
```

It performs only `SISMEMBER` and `HGET` at one Redis serialization point and returns exactly a
two-element RESP array `[outcome, storedValue]`:

| Buyer member | Reservation value | Outcome | `storedValue` |
| --- | --- | --- | --- |
| yes | present | `BOTH` | exact stored ledger value |
| no | absent | `NEITHER` | empty string |
| yes | absent | `BUYER_ONLY` | empty string |
| no | present | `RESERVATION_ONLY` | exact stored ledger value |

The script contains no write command, no time/readiness logic, and no loop. `BOTH` and
`RESERVATION_ONLY` values are parsed by the same strict reservation parser as `getReservation()`;
malformed values throw. `NEITHER` and `BUYER_ONLY` return `reservation: null`. An unknown outcome,
wrong tuple arity/type, empty value for a reservation-bearing outcome, or non-empty value for an
absent outcome fails closed; it is never coerced.

This primitive does not replace the paged scans. It supplies one bounded, consistent identity
classification only for a buyer that the earlier reservations scan did not contain.

### 21.4 Exact worker algorithm

The existing PG → queue → reservations → buyers → stock → DLQ pass order remains. For each buyer
returned by `scanBuyers()`:

1. If `ledgerByUser` already contains the user, continue exactly as today.
2. Otherwise call `inspectReservationMembership(saleId, userId)` exactly once.
3. Resolve the inspection:
   - `BOTH`: insert the returned entry into `ledgerByUser`, call
     `ensureLiveReservationQueued(entry, byUser.get(userId))`, and retain the existing collision
     incident semantics. Do not degrade merely because the entry arrived after HSCAN.
   - `RESERVATION_ONLY`: perform the same coverage action, then call
     `reconcileBuyerMembership()`; it must return `PRESENT`. Add the entry to `ledgerByUser`.
   - `NEITHER`: the SSCAN result became stale because a valid atomic transition completed. Do
     nothing and do not degrade readiness.
   - `BUYER_ONLY`: do not mutate Redis yet. Run the bounded fresh-source adjudication below.

Fresh-source adjudication for `BUYER_ONLY` is identity-specific and bounded; it never repeats a
global scan:

1. call `repository.getByUser(userId)` once;
2. call `queue.getJob(buildOrdersJobId(saleId, userId))` once and, if present, validate it with the
   existing `classifyQueueEntry` rules and actual state;
3. accept a PG row only when `row.saleId === saleId`; accept a queue recovery identity only when
   its validated payload has the same `saleId` and `userId` and its actual state is
   `waiting|active|delayed|failed`;
4. precedence is same-sale `persisted` PG, then a valid live queue identity. Restore the selected
   identity only through existing `applyRecoveryCandidate`; never synthesize a reservation ID;
5. a same-sale `compensated` PG row with no accepted live identity is caller-proven terminal stale
   membership, so and only so may `reconcileBuyerMembership()` take its existing `ABSENT` branch;
6. after any accepted recovery or compensated cleanup, call
   `inspectReservationMembership()` exactly one final time and resolve `BOTH`,
   `RESERVATION_ONLY`, or `NEITHER` as above;
7. if no safe source exists, the targeted queue entry is malformed/colliding, or the final result
   remains `BUYER_ONLY`, throw exactly
   `Error('unrecoverable buyer-only identity for <userId>')`. Do not SREM, compensate, invent an
   identity, or mark the pass healthy.

At most two atomic inspections, one targeted PG query, and one targeted job lookup occur for one
apparent buyer-only identity. There is no sleep, busy retry, unbounded loop, whole-pass retry, or
full rescan. Normal buyers already present in `ledgerByUser` incur no added Redis command.

If a late `BOTH` entry has no queue coverage, the existing deterministic `jobId=saleId:userId`
repair is safe to race with the API enqueue. Existing payload-identity collision handling remains
binding. A `RETAINED_COLLISION` makes the pass degraded exactly as before.

### 21.5 Readiness and invariant effect

- **I1:** the inspection is read-only. Reconciliation still derives stock from reservation HLEN
  only after identity repair and still fails on overcommit. No stock/threshold change.
- **I2:** purchase continues to create buyer+reservation atomically. `RESERVATION_ONLY` repair uses
  the existing atomic membership primitive; true unexplained `BUYER_ONLY` is retained and fails
  closed rather than being deleted.
- **I3:** no reservation is created by a caller and no window decision changes. Recovery transports
  an already-confirmed identity only.
- **I4:** a reservation committed between the two scans is now discovered by exact identity and
  receives idempotent queue coverage. A stable identity loss is still never silently dropped or
  compensated without proof.

Readiness semantics do not change: a completed clean pass sets `reconciliationHealthy=true`; a
true unrecoverable identity, malformed data, datastore error, or retained collision keeps it false
and `/ready` returns 503. The correction removes only the false failure caused by stale cross-scan
observation. It must not special-case warmup, suppress `reconciliation.failed`, ignore a 503 in the
sampler/audit, or declare healthy while a pass has failed.

### 21.6 Required regressions

#### A4-L test

Add this named case to `load/audit.spec.ts`:

1. `A4 — runner invokes the package audit script through pnpm run with the exact argument boundary`

The injected command executor must capture the full argv and assert the prefix is exactly:

```js
['--filter', '@flash/load', 'run', 'audit', '--', '--run-id']
```

The test must also reject/assert-absent the obsolete adjacent prefix
`['--filter', '@flash/load', 'audit']`. A string/grep-only test is insufficient.

#### A4-R tests

Add these named cases in the owned Redis tests:

1. `A4 — inspection classifies BOTH from one read-only Redis serialization point`;
2. `A4 — inspection classifies NEITHER without mutating either key`;
3. `A4 — inspection distinguishes BUYER_ONLY from RESERVATION_ONLY without repair`;
4. `A4 — inspection strictly parses reservation identity and rejects malformed values`;
5. `A4 — inspection rejects invalid userId before Redis execution`;
6. `A4 — registry pins inspect-reservation-membership name, sha1, key count, and membership`.

For the first three, snapshot `SCARD`, `HLEN`, membership, and field value before/after and prove
they are byte/count identical. This is a read-only primitive, not a hidden reconciliation write.

#### A4-W unit tests

Add these named cases to the owned worker unit spec:

1. `A4 — late BOTH identity is queued and does not degrade a clean pass`;
2. `A4 — stale buyer scan classified NEITHER is ignored without repair or failure`;
3. `A4 — RESERVATION_ONLY identity restores membership and queue coverage`;
4. `A4 — fresh persisted or live-queue identity recovers BUYER_ONLY then re-inspects once`;
5. `A4 — same-sale compensated identity permits only atomic stale-membership cleanup`;
6. `A4 — stable BUYER_ONLY remains present, fails the pass, and keeps readiness 503`;
7. `A4 — cross-sale PG row and malformed or mismatched targeted job are not recovery authority`;
8. `A4 — apparent buyer-only work is bounded to two inspections and one PG/job lookup`.

The pre-existing Phase 3 unrecoverable-buyer-only negative control remains and must still pass.

#### A4-I real concurrent regression

Add exactly one named real-datastore case:

1. `A4 — purchases committed between reservation HSCAN and buyer SSCAN remain healthy and durable`

Use the existing integration harness and real Redis/Postgres/BullMQ. Install a test-local one-shot
barrier around the existing store's final `scanReservations()` page: after the real HSCAN returns
cursor `0` but before the service receives that page, commit at least 32 valid, unique-user
`store.purchase()` calls through the real purchase Lua script, then release the page so the same
`runDiff()` proceeds to real SSCAN. Do not mock purchase, Redis contents, inspection results, PG,
or queue behavior.

The test must prove:

- all confirmed late identities are returned by real inspection as reservation-bearing identities;
- `triggerPass()` resolves and `reconciliationHealthy` remains true;
- readiness is HTTP 200 throughout the completed pass observation, with no accepted 503;
- every confirmed identity reaches the same persisted PG identity or has the matching live queue
  coverage before the test completes, then converges to persisted with no failed job;
- final stock/reservation/order counts satisfy I1, user uniqueness satisfies I2, timestamps remain
  in the sale window for I3, and no confirmation is lost for I4;
- the existing deliberate stable buyer-only fixture still returns 503 and remains in the Set.

The barrier must restore the spied method in `finally`, have a finite test timeout, and release on
failure so teardown cannot hang or leave an unhandled rejection.

### 21.7 Verification and dispatch sequence

Dispatch A4-L and A4-R in parallel only if path ownership remains exact. Then sequence A4-W after
A4-R, and A4-I after A4-W. Each slice returns actual output and exit status.

Focused commands:

```bash
# A4-L
pnpm --filter @flash/load test
pnpm --filter @flash/load typecheck
node scripts/stress.mjs --help
rg -n "'run',|'audit'|--run-id" scripts/stress.mjs load/audit.spec.ts

# A4-R
pnpm --filter @flash/redis test
pnpm --filter @flash/redis typecheck
pnpm --filter @flash/redis build

# A4-W
pnpm --filter @flash/worker test
pnpm --filter @flash/worker typecheck
pnpm --filter @flash/worker build

# A4-I, with Phase 5 isolated Redis/Postgres available as required by the existing suite
pnpm --filter @flash/worker test:integration -- --runInBand
```

If the package integration script does not accept `--runInBand`, use its existing unmodified
script with no invented flag and record that exact command. Do not edit package scripts for A4-I.

After focused verification, root—not an implementer—runs the canonical uncached graph from §14.3,
the A2/A3 focused checks, and the existing Phase 3 failure-mode integration suite. Phase 2 and
Phase 6 security-review requirements are unchanged; A4 requires an adversarial-reviewer after all
verification is green because it touches I2/I4 reconciliation and Redis Lua. The reviewer must
attempt to break scan-window edges, purchase/compensation transitions, queue-enqueue races,
cross-sale identity, malformed tuples, true buyer-only retention, retry bounds, and shutdown/test
resource cleanup.

No A4 work is a T1 tuning candidate. A4 must be green before the untuned baseline is rerun, and
its before/after evidence is correctness evidence, not a latency optimization.

### 21.8 Baseline disposition and gate

`baseline-20260723-a3` remains immutable and excluded from tracked aggregates/final manifest:

- do not rerun its audit manually with the corrected command;
- do not backfill, edit, merge, or rename any file in its raw directory;
- do not use its HTTP metrics as a tuning baseline or an I1–I4 verdict;
- preserve the command error, two worker 503 samples, reconciliation logs, and cleanup evidence as
  the diagnostic chain that motivated A4.

Only after A4-L/R/W/I, focused evidence, root uncached graph, and adversarial review are green may
root select a wholly new valid `STRESS_RUN_ID` and run the complete **untuned** baseline: one
audited warmup plus one repetition of all four full scenarios. That run keeps all A1–A3 audit,
readiness, permission, isolation, cleanup, and raw-artifact rules.

Any worker readiness 503 after initial readiness remains an operational baseline failure. If it
recurs, preserve evidence and diagnose the exact cause; do not relax the sampler or thresholds.
Only a completed audit may make I1–I4 claims. T1 remains dormant until this new untuned baseline
completes and satisfies the original §13.1 entry condition.

### 21.9 Copy-ready correction briefs

**A4-L**

> You are not alone in the repository; preserve unrelated edits and do not revert another agent.
> Read `.claude/contracts/phase-5.md` §21.1, §21.2 A4-L, §21.6 A4-L, and §21.7. Load `k6`,
> `turborepo-monorepo`, and `vitest`. Own only `scripts/stress.mjs` and `load/audit.spec.ts`.
> Change the audit child argv to exactly `pnpm --filter @flash/load run audit -- --run-id ...` and
> add the captured-argv regression. Preserve every A1–A3 behavior. Do not touch audit semantics,
> thresholds, results, dependencies, or application paths.

**A4-R**

> You are not alone in the repository; preserve unrelated edits and do not revert another agent.
> Read `.claude/contracts/phase-5.md` §21.2 A4-R, §21.3, §21.5–§21.7. Load `redis-core`,
> `redis-connections`, and `vitest`. Own only the seven A4-R paths. Add the frozen read-only atomic
> reservation-membership inspection, strict decoding/validation, exports, registry entry, and all
> six tests. Do not change purchase, compensation, existing key formats, membership repair, stock,
> dependencies, or any worker/load path.

**A4-W**

> You are not alone in the repository; preserve unrelated edits and do not revert another agent.
> Start only after A4-R is green. Read `.claude/contracts/phase-5.md` §21.2 A4-W and §21.4–§21.7.
> Load `bullmq-specialist`, `redis-core`, `redis-connections`, `postgresql-table-design`, and
> `vitest`. Own only the reconciliation service and unit spec. Implement the exact bounded
> inspection/fresh-source algorithm and eight unit controls. Preserve true buyer-only fail-closed,
> readiness, queue collision, pass order, shutdown, and I1–I4 semantics. Do not tune intervals,
> suppress errors/503s, or touch integration/support/Redis-package paths.

**A4-I**

> You are not alone in the repository; preserve unrelated edits and do not revert another agent.
> Start only after A4-W is green. Read `.claude/contracts/phase-5.md` §21.2 A4-I and §21.5–§21.7.
> Load `bullmq-specialist`, `redis-core`, `redis-connections`, `postgresql-table-design`, and
> `vitest`. Own only `apps/worker/test/integration/failure-modes.integration.spec.ts`. Add the one
> deterministic real-datastore regression that commits 32+ real Lua purchases between the final
> reservation HSCAN page and buyer SSCAN, proves healthy durable convergence/I1–I4, and preserves
> the true buyer-only 503 control. Use a finite, finally-released barrier. Do not widen ownership,
> mock datastore truth, tune, or weaken existing cases.

### 21.10 ADR — decisions and rejected alternatives

| Decision | Alternative rejected | Why |
| --- | --- | --- |
| Invoke the existing package script through explicit `pnpm ... run audit -- ...` | Rename the script or call `tsx` directly | `run` disambiguates pnpm's built-in command while preserving the frozen package/CLI boundary and dependency resolution. |
| Add one read-only Lua inspection for an apparent missing identity | Trust the old HSCAN map or add only a later `HGET` | The map is known stale; a lone later HGET cannot distinguish a buyer that was concurrently removed with its reservation from a stable buyer-only incident. One Lua read observes both keys at a Redis serialization point. |
| Refresh only the affected PG row and deterministic queue job, then re-inspect once | Repeat all scans, sleep/retry indefinitely, or lower the reconcile frequency | Identity-targeted work is bounded and closes the stale-global-snapshot gap without retry storms or hiding the defect through timing. |
| Preserve fail-closed readiness for stable `BUYER_ONLY` | Automatically SREM, compensate, ignore the error, or let audit tolerate 503 | Buyer membership is evidence of a confirmation whose identity may be lost. Deleting or ignoring it would weaken I2/I4 and could silently drop a confirmation. |
| Treat A4 as correctness work outside T1 | Attribute the 503 to saturation and tune pools/concurrency/thresholds | Logs show empty active/failed queue counts and a deterministic scan-order misclassification. Tuning cannot repair the violated identity observation contract. |

---

## 22. AMENDMENT A5 — fail-closed convergence, readiness evidence, provenance, and child lifecycle

**Status:** FROZEN corrective amendment after the pre-baseline adversarial review rejected the
A4-ready harness.
**Amends:** §§7.3, 8.2, 8.4–8.5, 9, 10.2, 13.1, 14, 16, and Amendments A1–A4.
**Disposition:** no baseline may start until A5 is implemented, verified, and adversarially
approved. `baseline-20260723-a3` remains immutable failed diagnostic evidence; its missing audit,
readiness failures, and raw files are never backfilled.

### 22.1 Reproduced findings and decisions

#### Finding 1 — convergence can accept an old snapshot after collection failures

The current audit retains `snapshot`, `previous`, and `stableAt` when `collectSnapshot()` throws.
The catch discards the error, wall-clock age continues increasing, and the deadline check can
accept the old converged snapshot because it is older than 250 ms even though the live stores are
unavailable. The existing fingerprint also covers counts but not every identity/config field used
by the evaluator.

**Decision:** convergence requires a fresh streak of two complete, byte-matching successful
snapshots separated by at least 250 ms, followed by one successful matching final live collection.
Any collection error, incomplete/non-converged observation, or fingerprint change resets the
streak. The final live snapshot—not an older retained object—is the only evaluator input.

#### Finding 2 — sampled worker readiness is written but never adjudicated

The sampler writes `worker-readiness.jsonl`, but `runScenario()` never parses it. A worker may
return 503 after initial readiness, recover before the audit, and the run can pass despite §9's
binding rule that any worker readiness degradation fails the benchmark.

**Decision:** every sampler row is strictly parsed after sampling stops. Because sampling begins
only after initial worker/API readiness succeeds, every row is post-initial. Any worker status
other than 200—including 503 or transport status 0—malformed JSON, invalid readiness envelope, or
`reconciliationHealthy !== true` fails the repetition even if the terminal audit later passes.
Audit still runs when its prerequisites exist so the operational failure does not erase I1–I4
diagnostics.

#### Finding 3 — implementation digest is incomplete and read failures are ignored

The current digest selects only dirty L1 paths, omits A4 worker/Redis implementation and CI/T1
configuration surfaces, and catches missing/read errors. Two materially different benchmark
implementations can therefore report the same digest.

**Decision:** hash one frozen, deterministic, byte-sorted input manifest regardless of Git dirty
state. Missing, duplicate, unreadable, non-file, or out-of-order inputs fail before Compose starts.
Generated raw/tracked result outputs remain outside the implementation digest to avoid a circular
digest; their content is independently covered by the final SHA-256 integrity manifest.

#### Finding 4 — one global child pointer loses workload/audit ownership

Every `command()` overwrites `activeChild`. A one-second sampler `docker stats` can replace the
long-running k6 or audit child, so SIGINT/SIGTERM may kill only the stats process while workload or
audit survives. Fetches/timers can also continue until their local timeout.

**Decision:** register every spawned child by role and identity, abort asynchronous sampler work,
signal every live child promptly, await bounded termination, close streams, and then execute the
validated project-scoped cleanup exactly once. Cleanup has its own bounded role and is never
hidden by another child.

#### Finding 5 — observability commands ignore exit status and can write empty evidence

Redis INFO/SLOWLOG/LATENCY, Postgres stats, Docker stats/inspect/ps, and application-log commands
currently write stdout without requiring exit code 0 or validating content. `command-status.json`
then hard-codes sampler success.

**Decision:** every mandatory evidence command is checked, parsed, and recorded. Nonzero exit,
signal, timeout, empty required output, malformed structure, or absent required service evidence is
a repetition failure. Valid empty domain results such as “no slowlog entries” are represented by
an explicit nonempty marker; they are not confused with missing command output.

No finding authorizes threshold, rate, duration, resource, retry, readiness, or T1 changes.

### 22.2 Exclusive ownership and sequence

A5 begins only after A4-L/R/W/I are complete and their focused verification is green. Every agent
is told that other work is present, preserves unrelated edits, and never reverts another agent.

#### A5-C — audit convergence (`implementer`)

Mandatory skills, in order: `postgresql-table-design`, `redis-core`, `redis-connections`, then
`vitest`.

```text
load/contracts.ts                                    ~
load/audit.ts                                        ~
load/audit.spec.ts                                   ~
```

#### A5-H — harness provenance, readiness, observability, and lifecycle (`implementer`)

Mandatory skills, in order: `k6`, `redis-observability`, `redis-connections`,
`postgresql-table-design`, `multi-stage-dockerfile`, `turborepo-monorepo`, then `vitest`.

```text
scripts/stress.mjs                                   ~
load/stress.spec.ts                                  +
```

This amendment explicitly authorizes the new test path. It does not authorize another source,
config, package, or helper path.

A5-C lands and verifies before A5-H begins. A5-H consumes the frozen audit report shape below; it
does not edit A5-C paths. Root performs integration verification only after both slices are green.

**Forbidden to both slices:** all application, worker, Redis-package, shared, schema, production
Compose, CI, k6 workload, threshold, result Markdown/manifest, `.env.example`, `.gitignore`, root
package/lock/workspace, T1, `STATE.md`, `.codex/`, commit, and tag paths. A5-H reads digest inputs
but never edits them.

### 22.3 Exact convergence algorithm

Export a testable audit helper with this frozen interface from `load/audit.ts`:

```ts
export interface ConvergenceEvidence {
  snapshot: Snapshot;
  elapsedMs: number;
  matchingSnapshots: 2;
  stableIntervalMs: number;
  finalLiveCollection: true;
  successfulCollections: number;
  collectionFailures: number;
}

export async function waitForConvergence(
  collect: () => Promise<Snapshot>,
  options: {
    deadlineMs: number;
    now?: () => number;
    delay?: (milliseconds: number) => Promise<void>;
  },
): Promise<ConvergenceEvidence>;
```

`Snapshot` may remain module-private at runtime but must be exported as a TypeScript interface so
the helper is testable without opening real datastores. Production passes `collectSnapshot()` and
the CLI deadline. Test seams default to `Date.now` and an abort-aware real delay.

The algorithm is exact:

1. Start backoff at 100 ms, multiply by 1.5 after each unsuccessful loop, round up, cap at 2 s,
   and never sleep beyond the remaining deadline.
2. One collection is **complete** only if every HTTP, PG, and Redis read in `collectSnapshot()`
   succeeds and its values pass existing structural/numeric parsing. A caught error increments
   `collectionFailures`, stores only its redacted message for deadline evidence, clears the
   candidate fingerprint/snapshot/time, and resets `matchingSnapshots` to 0.
3. A complete but non-converged snapshot also clears the candidate and resets the streak. It may
   be retained only as the last diagnostic summary, never as success.
4. Compute a canonical fingerprint from every field consumed by `evaluateAudit`: API/worker ready
   flags, all queue counts, runner/PG/API/Redis sale configuration, all PG counts, every order
   identity/status/timestamp in deterministic order, Redis stock/count/metric values, sorted buyer
   identities, sorted reservation identity/timestamp tuples, and ledger errors. Do not use object
   insertion order, Sets, or Maps directly.
5. The first converged complete snapshot establishes candidate fingerprint and `candidateAt` and
   sets the streak to 1.
6. A subsequent converged complete snapshot with a different fingerprint replaces the candidate,
   resets `candidateAt` to its collection-completion time, and sets the streak to 1.
7. A matching converged complete snapshot collected at least 250 ms after `candidateAt` establishes
   exactly two matching snapshots. A match before 250 ms does not establish success; retain the
   original candidate/time and continue bounded polling.
8. Immediately perform one additional **final live collection**. It must succeed, be converged,
   and have the same canonical fingerprint. It is not satisfied by the second object or a cached
   promise. On error, non-convergence, or mismatch, count/reset as above and continue while the
   same original deadline remains.
9. Return the final live snapshot only. Require `matchingSnapshots: 2`,
   `stableIntervalMs >= 250`, `finalLiveCollection: true`, and accurate cumulative successful/error
   counts.
10. At deadline, throw `Convergence deadline expired` with the last complete diagnostic summary
    and last redacted collection error. Never return an old snapshot because its age increased.

The final collection does not extend the deadline. Collection promises and delays use the CLI's
bounded operation timeouts and stop at deadline; no detached retry continues after CLI failure.

Add these fields to `AuditReport.convergence` in `load/contracts.ts` while retaining
`schemaVersion: 1`:

```ts
matchingSnapshots: 2;
stableIntervalMs: number;
finalLiveCollection: true;
successfulCollections: number;
collectionFailures: number;
```

`evaluateAudit()` requires the literal 2/true values and `stableIntervalMs >= 250` for I4. The CLI
copies values only from `waitForConvergence()` and evaluates the returned final snapshot.

### 22.4 Exact post-initial readiness evidence gate

A5-H exports from `scripts/stress.mjs`:

```js
export async function validateSamplerEvidence(scenarioDir, samplerStartedAt) {
  // returns the frozen summary below or throws
}
```

Return:

```ts
{
  apiSamples: number;
  workerSamples: number;
  metricSamples: number;
  statsSamples: number;
  workerDegradedSamples: 0;
}
```

Rules:

- `runtime.json` records `samplerStartedAt` immediately before the first tick is scheduled.
- Each of `api-readiness.jsonl`, `worker-readiness.jsonl`, and `sale-metrics.jsonl` must be a
  nonempty UTF-8 file ending in newline. Every nonempty line must parse as exactly one JSON object;
  blank, truncated, array/scalar, duplicate/non-monotonic timestamp, pre-start timestamp, invalid
  ISO timestamp, negative/non-finite latency, or fields of the wrong type fail.
- A successful HTTP row has integer `status`, nonnegative integer `latencyMs`, and object `body`,
  with no `error`. A transport-failure row has `status: 0`, nonempty string `error`, and no `body`;
  it is valid evidence syntax but fails the corresponding availability gate.
- Every worker row must have status 200 and body fields `status:'ok'`, `service:'worker'`, plus
  `checks.bootstrapReconciled === true`, `checks.consumerReady === true`, and
  `checks.reconciliationHealthy === true`. `activeJobs`/`failedJobs`, when present, are finite
  nonnegative integers; they need not be zero during load. Any 503, status 0, other status,
  malformed envelope, or false/missing required check fails with timestamp/status in the error.
- API readiness rows must have status 200, `body.status === 'ok'`, and `body.service === 'api'`.
  Queue counts, when present, are finite nonnegative integers; temporary queue depth is allowed.
- Sale metrics rows must have status 200 and a JSON object body for the exact current sale. Metrics
  counters remain diagnostic and may lag; transport/status/schema/sale mismatch is evidence
  failure, but counter lag is not.
- `container-stats.csv` must be nonempty, end in newline, have the exact frozen header, and contain
  at least one valid data row per second while workload sampling was active subject to scheduler
  jitter of one interval. Every row has a valid ISO timestamp and parsed stats for Redis,
  Postgres, API, worker, and the active k6 container. Missing required service, malformed JSON,
  or a sampler-command failure fails.

Call `validateSamplerEvidence()` after `stopSamplers()` and preserve its result in
`runtime.json.samplerEvidence`. Run the terminal audit when its summary/datastore prerequisites
exist even if this evidence gate fails; aggregate the readiness/evidence failure with audit/k6 and
still capture diagnostics/cleanup. A later healthy audit can never clear a sampled worker 503.

### 22.5 Deterministic implementation digest

A5-H defines and exports exactly one frozen constant:

```js
export const PHASE5_IMPLEMENTATION_INPUTS = [/* exact sorted paths below */];
```

The array is bytewise sorted, contains no duplicates, and is exactly:

```text
.env.example
.github/workflows/ci.yml
.gitignore
apps/api/src/config/env.schema.ts
apps/api/src/config/env.spec.ts
apps/api/src/infra/postgres.providers.ts
apps/api/src/infra/redis.providers.ts
apps/api/src/queue/orders-queue.service.spec.ts
apps/api/src/queue/orders-queue.service.ts
apps/worker/src/config/env.schema.ts
apps/worker/src/config/env.spec.ts
apps/worker/src/infra/postgres.provider.ts
apps/worker/src/infra/redis.providers.ts
apps/worker/src/orders/orders.consumer.spec.ts
apps/worker/src/orders/orders.consumer.ts
apps/worker/src/reconciliation/reconciliation.service.spec.ts
apps/worker/src/reconciliation/reconciliation.service.ts
apps/worker/test/integration/failure-modes.integration.spec.ts
infra/docker-compose.yml
load/README.md
load/audit.spec.ts
load/audit.ts
load/contracts.ts
load/docker-compose.yml
load/eslint.config.mjs
load/k6/common.js
load/k6/duplicate-storm.js
load/k6/smoke.js
load/k6/sold-out.js
load/k6/surge.js
load/k6/warmup.js
load/k6/window-edge.js
load/package.json
load/stress.spec.ts
load/tsconfig.json
package.json
packages/redis/src/index.ts
packages/redis/src/sale-store.reconcile.spec.ts
packages/redis/src/sale-store.ts
packages/redis/src/scripts/inspect-reservation-membership.lua.ts
packages/redis/src/scripts/registry.spec.ts
packages/redis/src/scripts/registry.ts
packages/redis/src/types.ts
pnpm-lock.yaml
pnpm-workspace.yaml
scripts/stress.mjs
turbo.json
```

These include all Phase 5 load/CI/config/result-generation inputs, A4 Redis/worker work, and every
dormant T1 whitelist source so any retained tuning changes the digest. They are hashed whether
clean, dirty, tracked, or newly created.

Digest framing is exact for each listed path in order:

```text
UTF8(path) + NUL + UInt64BE(contentByteLength) + NUL + rawContentBytes + NUL
```

Hash the concatenated frames with SHA-256 lowercase hex. Before hashing, require the exported list
already equals a separately bytewise-sorted copy and has unique entries; resolve each path under
the repository root, reject traversal/symlink escape, require a regular file, and read it fully.
Never catch and skip an input failure.

`implementationState()` still records the full `git status --porcelain` dirty-path list, but it no
longer chooses digest inputs from that list. Every scenario `runtime.json` adds
`implementationInputs: PHASE5_IMPLEMENTATION_INPUTS` and the same run-level digest. Recompute once
immediately before each scenario starts and require it equals the preflight digest; any source
change during a run fails before recreating that scenario.

Excluded by design: `.claude/**`, `.codex/**`, `STATE.md`, `load/results/**`, raw evidence, tracked
generated result Markdown/SHA, `.git/**`, and dependencies/build outputs. Generated final inputs
remain protected by §10.2's sorted SHA-256 manifest; including them here would make the runtime
digest circular.

### 22.6 Child registry, interruption, and sampler shutdown

Replace the singleton `activeChild` with a registry keyed by child identity and frozen role:

```js
const CHILD_ROLES = [
  'control',
  'workload',
  'audit',
  'sampler',
  'observability',
  'cleanup',
];
const activeChildren = new Map(); // ChildProcess -> role
```

`command()` requires a role option at every call site, registers immediately after spawn, and
removes only that exact child on `error` or `close`. One child completing cannot clear another.
Spawn error settles once and removes the child. Workload is the k6 Compose run; audit is pnpm;
Docker stats is sampler; evidence commands are observability; setup/readiness Compose commands are
control; the final scoped `down -v --remove-orphans` is cleanup.

Create one runner `AbortController`. On first SIGINT/SIGTERM:

1. set `interrupted=true` and abort the controller;
2. clear sampler timers and abort in-flight sampler fetches/delays;
3. send SIGTERM once to every registered live non-cleanup child, including simultaneous workload,
   audit, sampler, observability, and control children;
4. after 2 seconds, SIGKILL only those same children that remain live;
5. await all registered non-cleanup close/error settlements before leaving scenario cleanup;
6. close all four sampler streams and prove their `finish` events; then execute the validated
   Compose cleanup exactly once with a 60-second timeout;
7. if cleanup times out/fails, record and aggregate it. Do not silently detach cleanup.

All command timeouts use the same per-child TERM→2-second→KILL settlement. The runner abort signal
is combined with per-operation fetch timeout; `waitJson`, window-edge waits, sampler ticks, and
retry delays reject promptly on runner abort. No new child except the single cleanup command may
spawn after interruption. A second signal may expedite non-cleanup termination but does not create
another cleanup or broaden its project target.

`stopSamplers()` is idempotent. It clears the interval, aborts its local controller, awaits the
single in-flight tick promise, verifies the sampler child registry is empty, ends streams, and
returns a real sampler status. It never polls a mutable `busy` flag indefinitely.

### 22.7 Mandatory observability command validation

Every required command must return exit code 0, no signal, and `timedOut !== true`. Validation is:

- Each Redis INFO command is nonempty and begins with/contains its requested section marker
  (`# Memory`, `# Stats`, `# Clients`, `# Persistence`, `# CPU`) with parseable key/value rows.
- Postgres stdout is exactly one non-array JSON object containing finite nonnegative
  `total_connections`, `active_connections`, `commits`, `rollbacks`, `inserted`, `deadlocks`,
  `temp_files`, and `temp_bytes`.
- `SLOWLOG LEN` is one nonnegative integer. Empty `SLOWLOG GET 128` is valid only when LEN is zero
  and is written as the explicit text `(no slowlog entries)`. Empty `LATENCY LATEST` is valid and
  written as `(no latency events)`. Their combined file is always labeled and nonempty.
- Each Docker stats output is nonempty JSON-lines; every line parses as an object with service/
  container identity plus CPU, memory use/limit, network, and block-I/O fields. The frozen CSV
  stores normalized fields, not an opaque raw JSON cell.
- Compose `ps -q` succeeds and returns IDs for Redis, Postgres, API, and worker. `docker inspect`
  succeeds, parses as a nonempty array, and covers exactly those IDs plus the workload container
  when it is still present. Missing required IDs, duplicates, invalid states, OOM, or restarts fail.
- API and worker log commands succeed and produce nonempty timestamped text. An application that
  emits no log line is missing required observability, not an empty success.
- All required evidence files exist as regular non-symlink files under the scenario directory,
  are nonempty, and pass their format parser before the scenario may return success.

Expand `command-status.json` to exactly these nullable integer fields, initialized before workload
and updated atomically as each stage settles:

```json
{
  "permissionProbe": null,
  "k6": null,
  "audit": null,
  "sampler": null,
  "observabilityBefore": null,
  "observabilityAfter": null,
  "containerPs": null,
  "containerInspect": null,
  "apiLogs": null,
  "workerLogs": null,
  "readinessEvidence": null,
  "cleanup": null
}
```

Use the real exit code, or `128 + signalNumber` for signaled children; an internal parse/write
failure uses 1. A field stays null only when an earlier failure made that stage impossible. No
hard-coded sampler 0 is permitted. Any nonzero or required null field fails the repetition; only
`cleanup` may remain null until the root `finally`, after which it must be an integer.

Evidence collection is best-effort after a primary workload/audit failure, but no evidence failure
is downgraded to a warning. Aggregate distinct failures, preserve redacted stderr/stdout, and run
cleanup. Never fabricate `{}`, `[]`, empty files, or success status to keep the runner moving.

### 22.8 Required tests and negative controls

#### A5-C tests in `load/audit.spec.ts`

1. `A5 — collection failure resets the convergence streak and old snapshot age cannot pass`;
2. `A5 — two matching snapshots less than 250ms apart do not converge`;
3. `A5 — changed full identity fingerprint resets the candidate even when counts match`;
4. `A5 — non-converged complete observation resets the candidate`;
5. `A5 — final live collection failure resets the streak and cannot emit a report`;
6. `A5 — final live mismatch resets and requires a new two-snapshot streak`;
7. `A5 — two spaced matches plus matching final live collection return only the final snapshot`;
8. `A5 — deadline reports redacted last collection error and never returns retained success`;
9. `A5 — I4 requires two matches, minimum interval, and final live availability evidence`.

Use injected monotonic time/delay; no real sleeps. Include an error containing a datastore password
and assert it is absent from the thrown message.

#### A5-H tests in `load/stress.spec.ts`

1. `A5 — post-initial worker 503 fails even when terminal audit is healthy`;
2. `A5 — worker transport failure and malformed readiness envelope fail closed`;
3. `A5 — healthy worker samples permit transient nonzero active jobs during load`;
4. `A5 — empty truncated nonmonotonic or pre-start readiness evidence is rejected`;
5. `A5 — API and sale-metrics availability/schema are parsed without treating metric lag as failure`;
6. `A5 — deterministic digest manifest is exact sorted unique and covers L1 L2 A4 and T1 inputs`;
7. `A5 — digest includes clean and untracked static inputs and changes when any input byte changes`;
8. `A5 — missing unreadable symlink-escaping or non-file digest input fails before Compose`;
9. `A5 — simultaneous workload audit sampler and observability children retain independent roles`;
10. `A5 — child completion removes only itself and spawn error settles once`;
11. `A5 — SIGTERM aborts waits and signals every live non-cleanup child then force-kills survivors`;
12. `A5 — interruption allows exactly one bounded validated cleanup and no other new child`;
13. `A5 — sampler stop aborts its tick awaits settlement closes streams and leaves no child`;
14. `A5 — sampler command failure records nonzero status and aborts workload promptly`;
15. `A5 — nonzero timeout signal empty or malformed mandatory observability output fails closed`;
16. `A5 — valid empty slowlog and latency results produce explicit nonempty evidence`;
17. `A5 — command status preserves real stage codes null skipped stages and final cleanup code`;
18. `A5 — required evidence inventory rejects missing empty symlink or structurally invalid files`.

Tests inject spawn/fetch/clock/timer/filesystem seams. Production defaults remain real Node spawn,
fetch, time, signals, and filesystem. Source-grep assertions alone do not satisfy lifecycle,
digest, readiness, or observability controls. Every fake child must expose TERM/KILL/close behavior
and the tests must prove no pending timer, promise, stream, or child remains.

### 22.9 Focused verification, review, and baseline sequence

Run sequentially and return actual output/status:

```bash
# A5-C
pnpm --filter @flash/load lint
pnpm --filter @flash/load typecheck
pnpm --filter @flash/load exec vitest run load/audit.spec.ts

# A5-H, after A5-C
pnpm --filter @flash/load lint
pnpm --filter @flash/load typecheck
pnpm --filter @flash/load exec vitest run load/stress.spec.ts

# Combined load package
pnpm --filter @flash/load test
node scripts/stress.mjs --help
```

`@flash/load` intentionally has no package-local build script; typecheck plus the root Turbo build
is its compile evidence. Do not add a build script or edit package scripts for A5.

Root then runs:

```bash
pnpm install --frozen-lockfile
pnpm format:check
pnpm exec turbo run lint typecheck test build test:integration --force
pnpm audit --audit-level high
node scripts/assert-build-output.mjs apps/api/dist/main.js apps/worker/dist/main.js
PHASE5_K6_UID="$(id -u)" PHASE5_K6_GID="$(id -g)" RAW_RESULT_DIR=/tmp/phase5-contract-results docker compose -p flash-load-contract -f load/docker-compose.yml config -q
docker compose -f infra/docker-compose.yml config -q
git diff --check
```

Root also performs a real interruption smoke against an isolated disposable project: interrupt
while k6 and stats are simultaneously live, prove both PIDs exit, prove all streams settle, and
prove exactly the validated project is removed with no remaining container/network/volume. Use a
throwaway run ID; it is interruption evidence, not a baseline or tracked result.

After all commands are green, invoke `adversarial-reviewer`. It must attempt to break stale
snapshot reuse, fingerprint collisions/order, final collection availability, JSONL truncation,
worker 503 recovery masking, digest omissions/symlink traversal, simultaneous child replacement,
signal races, sampler rejection/stream leaks, evidence-command failure, and cleanup multiplicity.
Any critical finding returns to the owning A5 slice; two repeats of the same issue escalate per
AGENTS.md §8.

Only after approval may root choose a wholly new valid run ID and execute the complete untuned
baseline: one audited warmup plus one repetition of all four full scenarios. Any sampled
post-initial worker 503 or mandatory evidence failure makes that run fail even if its final audit
passes. A3 remains immutable. T1 remains dormant until the new baseline completes and original
§13.1 independently permits it.

### 22.10 Invariant and readiness effect

- **I1/I2/I3:** evaluator semantics and thresholds are unchanged; the final live snapshot must
  contain the exact stock/users/window evidence before those claims are emitted.
- **I4:** two stable complete observations plus a final live read prevent an unavailable datastore
  from being represented by stale durable/queue state. Digest provenance ensures the audited A4
  repair is part of the implementation actually exercised.
- **Readiness:** a sampled post-initial 503 is an operational failure forever for that repetition.
  Recovery remains useful diagnosis but never erases the failure or changes an I1–I4 result.
- **Lifecycle:** killing every workload/audit/sampler child and proving scoped cleanup prevents a
  detached producer from mutating Redis/PG after the audit or contaminating the next sale.

No A5 behavior relaxes a threshold, rate, resource limit, readiness condition, scenario, or gate.

### 22.11 Copy-ready dispatch briefs

**A5-C**

> You are not alone in the repository; preserve unrelated edits and do not revert another agent.
> Start only after all A4 slices are green. Read `.claude/contracts/phase-5.md` §22.1 findings 1,
> §22.2 A5-C, §22.3, §22.8 A5-C, §22.9, and §22.10 completely. Load skills in exact order:
> `postgresql-table-design`, `redis-core`, `redis-connections`, `vitest`. Own only
> `load/contracts.ts`, `load/audit.ts`, and `load/audit.spec.ts`. Implement the frozen full-state
> fingerprint, reset-on-any-failure/nonconvergence/change algorithm, two successful matching
> snapshots at least 250 ms apart, mandatory matching final live collection, additive convergence
> evidence, and nine named tests. Use injected time/delay without real sleeps. Preserve I1–I4,
> bounded backoff/deadline, strict datastore reads, redaction, and atomic report writing. Do not
> edit harness/application/Redis-package/config/results/dependencies or weaken any gate. Run the
> A5-C focused commands and return actual output/status.

**A5-H**

> You are not alone in the repository; preserve unrelated edits and do not revert another agent.
> Start only after A5-C is green. Read `.claude/contracts/phase-5.md` §22.1 findings 2–5,
> §22.2 A5-H, and §22.4–§22.10 completely. Load skills in exact order: `k6`,
> `redis-observability`, `redis-connections`, `postgresql-table-design`,
> `multi-stage-dockerfile`, `turborepo-monorepo`, `vitest`. Own only `scripts/stress.mjs` and new
> `load/stress.spec.ts`. Implement strict post-initial sampler/readiness adjudication, the exact
> deterministic implementation manifest/digest, independent role-based child tracking with prompt
> abort and single bounded cleanup, fail-closed mandatory observability parsing/status, atomic
> expanded command status, and all 18 named tests. A recovered audit never clears sampled worker
> 503. Preserve audit execution when prerequisites exist, A1–A4 permission/audit behavior,
> evidence aggregation, scoped cleanup, I1–I4, and all thresholds. Do not edit any read-only digest
> input or widen ownership. Run A5-H plus combined focused commands and return actual output/status.

---

## 23. AMENDMENT A6 — package-relative A5 focused Vitest paths

**Status:** FROZEN command-only correction after both A5 implementers reproduced the filtered-cwd
path failure.
**Amends:** §22.9 and §22.11 focused-command instructions only.
**Ownership:** unchanged. This amendment authorizes no implementation or test edit.

`pnpm --filter @flash/load exec ...` executes with the `load` package as its working directory.
Therefore `load/audit.spec.ts` and `load/stress.spec.ts` resolve incorrectly as
`load/load/audit.spec.ts` and `load/load/stress.spec.ts`. The package-relative paths are the only
authorized focused invocations.

### 23.1 Exact focused commands

For A5-C, supersede only the Vitest row in §22.9/§22.11:

```bash
pnpm --filter @flash/load lint
pnpm --filter @flash/load typecheck
pnpm --filter @flash/load exec vitest run audit.spec.ts
```

For A5-H, supersede only the Vitest row in §22.9/§22.11:

```bash
pnpm --filter @flash/load lint
pnpm --filter @flash/load typecheck
pnpm --filter @flash/load exec vitest run stress.spec.ts
pnpm --filter @flash/load test
node scripts/stress.mjs --help
```

Evidence must show the named A5 tests actually execute; a zero-test success, “No test files
found,” missing-file error, or run of only unrelated tests is a failed focused gate.

### 23.2 Root verification remains binding

After both corrected focused blocks pass, root runs the unchanged A5 root graph:

```bash
pnpm install --frozen-lockfile
pnpm format:check
pnpm exec turbo run lint typecheck test build test:integration --force
pnpm audit --audit-level high
node scripts/assert-build-output.mjs apps/api/dist/main.js apps/worker/dist/main.js
PHASE5_K6_UID="$(id -u)" PHASE5_K6_GID="$(id -g)" RAW_RESULT_DIR=/tmp/phase5-contract-results docker compose -p flash-load-contract -f load/docker-compose.yml config -q
docker compose -f infra/docker-compose.yml config -q
git diff --check
```

The real isolated interruption smoke and adversarial review from §22.9 remain mandatory after the
root graph. A6 changes no requirement, test name, ownership, skill order, invariant, threshold,
readiness rule, digest input, evidence format, baseline disposition, or dispatch sequence.

### 23.3 Copy-ready correction notices

**A5-C notice**

> Command-only Amendment A6 applies. Preserve all A5-C ownership, behavior, skills, and nine named
> tests. Replace the failing focused invocation with exactly
> `pnpm --filter @flash/load exec vitest run audit.spec.ts`, then return its actual output/status.
> Do not edit implementation merely to accommodate the obsolete `load/audit.spec.ts` argument.

**A5-H notice**

> Command-only Amendment A6 applies. Preserve all A5-H ownership, behavior, skills, and 18 named
> tests. Replace the failing focused invocation with exactly
> `pnpm --filter @flash/load exec vitest run stress.spec.ts`, then run the combined load test and
> runner help checks and return actual output/status. Do not edit implementation merely to
> accommodate the obsolete `load/stress.spec.ts` argument.

---

## 24. AMENDMENT A7 — pnpm 11 package-script argument forwarding without a literal separator

**Status:** FROZEN corrective amendment after the first A5 throwaway warmup reached the real audit
subprocess.
**Amends:** §21.1 finding 1, §21.6 A4-L, §21.7 A4-L, §21.9 A4-L, and the still-binding A5/A6
focused verification.
**Ownership:** reopens only the existing A4-L paths below after A5-C/H are complete and green.

### 24.1 Reproduced behavior and decision

Pinned pnpm `11.9.0` applies these distinct child argv shapes:

```text
pnpm --filter @flash/load run audit --run-id
  -> tsx audit.ts --run-id

pnpm --filter @flash/load run audit -- --run-id
  -> tsx audit.ts -- --run-id
```

The A4/A5 implementation used the second form. pnpm forwards the literal `--` to `tsx`, and `tsx`
then forwards it to `audit.ts`. `parseAuditCli()` correctly rejects that unexpected positional
token. The frozen invocation is therefore exactly:

```text
pnpm --filter @flash/load run audit --run-id <runId> --scenario <scenario> ...
```

There is no separator token between `audit` and `--run-id`. This is specific to the pinned pnpm 11
`run <command> [args...]` contract and does not authorize direct `tsx`, `pnpm exec`, a renamed
package script, shell joining, or audit-parser tolerance for positional `--`.

### 24.2 Exclusive ownership and required skills

#### A7-L — audit forwarding correction (`implementer`)

Mandatory skills, in order: `k6`, `turborepo-monorepo`, then `vitest`.

```text
scripts/stress.mjs                                   ~
load/audit.spec.ts                                   ~
```

A7-L starts only after A5-C/H focused checks, the A6 corrected commands, root graph, and the passed
A5 interruption smoke evidence have been preserved. It changes only `runPackageAudit()` argv and
the two regressions below.

**Forbidden:** every other path; audit parsing/evaluation/convergence; A5 child/readiness/
observability/digest behavior; package scripts; dependencies; load scenarios/thresholds; worker,
Redis, application, schema, shared, Compose, CI, result Markdown/manifest, `.env.example`,
`.gitignore`, root package/lock/workspace, T1, `STATE.md`, `.codex/`, commits, and tags.

### 24.3 Exact implementation and regressions

`runPackageAudit(args, execute)` must call:

```js
execute(
  'pnpm',
  ['--filter', '@flash/load', 'run', 'audit', ...args],
  { live: true, role: 'audit' },
);
```

The first production argument remains `--run-id`; `args` is still the complete frozen audit CLI
sequence. Do not filter caller arguments or add/remove anything else.

Update the existing named captured-executor regression:

```text
A4 — runner invokes the package audit script through pnpm run with the exact argument boundary
```

It now asserts the exact prefix:

```js
['--filter', '@flash/load', 'run', 'audit', '--run-id']
```

It also asserts:

- `capturedArgs[4] === '--run-id'`;
- there is no `'--'` element anywhere in `capturedArgs`;
- the obsolete built-in form `['--filter', '@flash/load', 'audit']` is absent;
- command name remains `pnpm`, `live:true`, and `role:'audit'` remain unchanged.

Add this exact named real-process regression to `load/audit.spec.ts`:

```text
A7 — real pnpm 11 subprocess forwards --run-id without a literal separator
```

Use Node `spawnSync`/`execFile` with an argv array—never a shell—and the repository root as cwd:

```text
pnpm --filter @flash/load run audit --run-id a7-forwarding-probe
```

The intentionally incomplete CLI must exit nonzero **before datastore construction** with the
existing missing-flags error. Combine stdout/stderr and require:

```text
tsx audit.ts --run-id a7-forwarding-probe
```

Require zero occurrence of:

```text
tsx audit.ts -- --run-id
```

Also require no Redis/Postgres connection error, timeout, or password text. A mocked executor,
source grep, or test of `pnpm exec` cannot satisfy this real-process regression. Pin the subprocess
timeout to 10 seconds, require `signal === null`, and fail with redacted captured output if the
process times out or the expected parse boundary is not observed.

### 24.4 Focused and root verification

Run and return actual output/status:

```bash
pnpm --filter @flash/load lint
pnpm --filter @flash/load typecheck
pnpm --filter @flash/load exec vitest run audit.spec.ts
pnpm --filter @flash/load test
node scripts/stress.mjs --help
rg -n "runPackageAudit|run', 'audit|--run-id" scripts/stress.mjs load/audit.spec.ts
```

Then run this real subprocess smoke independently of Vitest:

```bash
set +e
a7_forwarding_output="$(pnpm --filter @flash/load run audit --run-id a7-forwarding-probe 2>&1)"
a7_forwarding_status=$?
set -e
printf '%s\n' "$a7_forwarding_output"
test "$a7_forwarding_status" -ne 0
printf '%s\n' "$a7_forwarding_output" | grep -F "tsx audit.ts --run-id a7-forwarding-probe"
if printf '%s\n' "$a7_forwarding_output" | grep -F "tsx audit.ts -- --run-id"; then exit 1; fi
printf '%s\n' "$a7_forwarding_output" | grep -F "Invalid, unknown, missing, or duplicate audit flag"
if printf '%s\n' "$a7_forwarding_output" | grep -Ei "ECONN|Redis|Postgres|password|timeout"; then exit 1; fi
```

The expected nonzero status proves only that the deliberately incomplete CLI was rejected; the
child command line and absence checks prove the forwarding boundary.

Root then reruns the unchanged canonical graph:

```bash
pnpm install --frozen-lockfile
pnpm format:check
pnpm exec turbo run lint typecheck test build test:integration --force
pnpm audit --audit-level high
node scripts/assert-build-output.mjs apps/api/dist/main.js apps/worker/dist/main.js
PHASE5_K6_UID="$(id -u)" PHASE5_K6_GID="$(id -g)" RAW_RESULT_DIR=/tmp/phase5-contract-results docker compose -p flash-load-contract -f load/docker-compose.yml config -q
docker compose -f infra/docker-compose.yml config -q
git diff --check
```

Because A7 changes one digest input and its regression, root must confirm the deterministic A5
implementation digest changes and remains stable across two consecutive computations with no file
edit between them.

### 24.5 Evidence preservation and next run

Preserve these local raw/evidence trees exactly as diagnostics; do not backfill, merge, rename,
delete, or use them as baseline results:

```text
load/results/raw/a5int-20260723-9f4c2d/
/tmp/phase5-a5int-20260723-9f4c2d/
load/results/raw/a5int-20260723-b7e81a/
/tmp/phase5-a5int-20260723-b7e81a/
```

`a5int-20260723-9f4c2d` is the naturally completed warmup that exposed the real audit argv defect.
`a5int-20260723-b7e81a` is the passed A5 interruption smoke. Their cleanup/process evidence remains
valid and is not rerun merely because audit forwarding changed.

After A7 focused checks and root graph are green, invoke `adversarial-reviewer` on the two-path A7
diff. Review exact argv ordering, shell avoidance, subprocess timeout/resource cleanup, redaction,
and preservation of A5 roles/abort behavior. Only after approval may root select a wholly new
valid `STRESS_RUN_ID` not equal to any `baseline-*` or `a5int-*` ID and start the complete untuned
baseline. A7 authorizes no reuse/backfill and no threshold/tuning/readiness relaxation.

### 24.6 Invariants and copy-ready brief

- **I1–I3:** unchanged; A7 changes transport of CLI tokens only.
- **I4:** the audit can now execute against the intended run/sale and prove terminal convergence;
  the parser remains strict rather than accepting an unintended positional token.
- **Lifecycle/readiness:** A5 remains fully binding. The audit child retains role `audit`, remains
  registered/abortable, and a sampled worker 503 still fails forever for that repetition.

> **A7-L dispatch.** You are not alone in the repository; preserve unrelated edits and do not
> revert another agent. Start only after A5-C/H and A6 verification are green and the interruption
> evidence is preserved. Read `.claude/contracts/phase-5.md` §24 completely. Load skills in exact
> order: `k6`, `turborepo-monorepo`, `vitest`. Own only `scripts/stress.mjs` and
> `load/audit.spec.ts`. Remove the literal separator from `runPackageAudit()` so argv is exactly
> `['--filter','@flash/load','run','audit',...args]`; retain `live:true` and `role:'audit'`. Update
> the existing captured regression and add the named real pnpm 11 subprocess regression with a
> 10-second timeout and no datastore attempt. Run §24.4 focused commands and return actual output/
> status. Do not edit the audit parser, package scripts, A5 lifecycle/evidence logic, thresholds,
> results, dependencies, or any path outside ownership. Do not start or reuse a baseline.

---

## 25. AMENDMENT A8 — exact A7 incomplete-CLI diagnostic

**Status:** FROZEN command/test-expectation correction after executing A7's exact real subprocess
probe.
**Amends:** §24.3 and §24.4 diagnostic expectation only.
**Ownership:** unchanged. This amendment authorizes no implementation or parser edit.

The exact probe remains:

```text
pnpm --filter @flash/load run audit --run-id a7-forwarding-probe
```

pnpm 11 correctly launches:

```text
tsx audit.ts --run-id a7-forwarding-probe
```

`parseAuditCli()` receives one valid flag/value pair, then rejects the missing remainder through
its stable completeness check. The required diagnostic is therefore exactly:

```text
Every audit flag is required exactly once
```

It is not `Invalid, unknown, missing, or duplicate audit flag`, which belongs to malformed pair/
unknown/duplicate-token paths. Do not add another CLI token merely to trigger that alternative
message; doing so would weaken the proof of the exact forwarding boundary. Do not change
`parseAuditCli()` or its error taxonomy.

### 25.1 Corrected regression and standalone smoke

The A7 real-process Vitest regression keeps every §24.3 requirement but asserts the required-flags
message above. It still requires nonzero exit, `signal === null`, completion within 10 seconds,
the exact child command without a literal separator, and zero datastore connection/credential
evidence.

In §24.4's standalone subprocess block, replace only:

```bash
printf '%s\n' "$a7_forwarding_output" | grep -F "Invalid, unknown, missing, or duplicate audit flag"
```

with:

```bash
printf '%s\n' "$a7_forwarding_output" | grep -F "Every audit flag is required exactly once"
```

All A7 focused commands, root graph, digest stability evidence, evidence preservation, adversarial
review, ownership, skill order, parser prohibition, and new-baseline-ID requirement remain binding.

### 25.2 Copy-ready correction notice

> Command-only Amendment A8 applies to A7-L. Keep the exact real subprocess
> `pnpm --filter @flash/load run audit --run-id a7-forwarding-probe` and every forwarding,
> timeout, signal, and no-datastore assertion. Change only the expected parser diagnostic to
> `Every audit flag is required exactly once`. Do not add arguments and do not edit
> `parseAuditCli()` or any implementation solely to produce the obsolete diagnostic.

---

## 26. AMENDMENT A9 — multi-epoch child draining and terminal interruption

**Status:** FROZEN mandatory pass-2 lifecycle correction after the adversarial reviewer reproduced
a live-child escape across two termination calls.
**Amends:** §22.6, §22.8 A5-H tests 9–14, §22.9 interruption review, and all later lifecycle
amendments.
**Sequence:** A9 implementation begins only after A7-L/A8 are complete and green because both own
`scripts/stress.mjs`. No baseline may start before A9 verification and adversarial approval.

### 26.1 Reproduced defect and decision

`createChildRegistry()` currently memoizes one `terminationPromise` forever. This sequence is
therefore unsafe:

1. register workload;
2. sampler failure calls `terminateNonCleanup()` and workload terminates;
3. while `interrupted === false`, later diagnostic audit/observability or a later scenario registers
   new children;
4. SIGTERM calls `terminateNonCleanup()` again;
5. the already-settled first promise is returned without taking a new snapshot, so the audit/new
   child receives no signal and can outlive cleanup/audit boundaries.

**Decision:** use explicit multi-epoch draining with a terminal upgrade:

- a sampler failure starts one **nonterminal drain epoch**; new non-cleanup spawns are refused until
  that epoch completely settles, then the registry reopens deliberately for diagnostics/later
  scenarios;
- every later termination call after an epoch settles starts a fresh epoch over the children live
  at that time;
- SIGINT/SIGTERM requests **terminal** mode immediately, upgrades any active drain, and permanently
  refuses every future non-cleanup spawn;
- cleanup is never targeted by non-cleanup draining and may be claimed exactly once for the whole
  registry lifetime.

This preserves A5's “collect later diagnostics when prerequisites exist” policy without allowing
them to escape a later signal. It does not authorize continuing normal work while a drain is live.

### 26.2 Exclusive ownership and skills

#### A9-H — child-registry epochs and sampler-failure sequencing (`implementer`)

Mandatory skills, in order: `k6`, `turborepo-monorepo`, then `vitest`.

```text
scripts/stress.mjs                                   ~
load/stress.spec.ts                                  ~
```

**Forbidden:** every other path; A7 audit argv/tests; audit/convergence/parser; application,
worker, Redis-package, shared, schema, Compose, CI, k6 workloads, thresholds, results,
`.env.example`, `.gitignore`, root package/lock/workspace, T1, `STATE.md`, `.codex/`, commits, and
tags. Do not add a dependency or helper file.

### 26.3 Frozen registry state and public test surface

`createChildRegistry()` retains `children`, `register`, `remove`, `roles`, and
`terminateNonCleanup`, and adds these testable members:

```js
registry.claimSpawn(role); // synchronous; called immediately before spawn
registry.state();          // 'open' | 'draining' | 'terminal'
registry.epoch();          // nonnegative integer; increments once per initiated drain
```

Internal state is exactly:

```text
mode: open | draining | terminal
epoch: integer starting at 0
activeTermination: null | Promise<void>
activeTargets: immutable child/settlement snapshot, empty outside a drain
terminalRequested: boolean starting false
cleanupClaimed: boolean starting false
```

Rules:

1. `claimSpawn(role)` validates the frozen `CHILD_ROLES` union.
2. A non-cleanup role is allowed only in `open`. In `draining`, throw
   `Child registry is draining; non-cleanup spawn refused`; in `terminal`, throw
   `Child registry is terminal; non-cleanup spawn refused`.
3. Cleanup is allowed in any mode only when `cleanupClaimed === false`. The first cleanup claim
   atomically sets it true; every later claim throws `Cleanup child already claimed` before spawn.
4. `command()` calls `claimSpawn(role)` synchronously immediately before its real/injected
   `spawn()`, then registers the returned child synchronously. Node event dispatch cannot interleave
   those synchronous operations; `register()` repeats mode/role validation and rejects a duplicate
   child identity.
5. If `spawn()` throws synchronously, no child is registered. A claimed cleanup remains consumed
   and the failure is aggregated; the runner never starts a second automatic cleanup command.
6. `remove(child)` removes only the exact child and its settlement. It is idempotent for the same
   child and never changes mode, epoch, terminal intent, or cleanup claim.
7. `roles()` reports only currently registered children. Cleanup may coexist with no non-cleanup
   role; there is never more than one cleanup role.

The global `interrupted` check remains defense in depth, but registry mode—not that Boolean alone—
is the authoritative spawn gate.

### 26.4 Exact drain-epoch algorithm

`terminateNonCleanup` accepts:

```js
registry.terminateNonCleanup({
  terminal = false,
  forceDelayMs = 2000,
  delay = setTimeout,
} = {});
```

The algorithm is exact:

1. Validate `terminal` Boolean and a finite integer `forceDelayMs` in `0..10000`.
2. If `terminal === true`, synchronously set `terminalRequested=true` and `mode='terminal'` before
   reading children. This immediately closes future non-cleanup spawn.
3. If an `activeTermination` exists:
   - return that same promise;
   - a terminal call upgrades the active epoch permanently as in step 2;
   - if this call has `forceDelayMs === 0`, immediately send SIGKILL once to every still-live
     non-cleanup target already captured by that active epoch, preserving A5's second-signal
     expedite rule;
   - never send a second SIGTERM to an epoch target.
4. Otherwise, for nonterminal work set `mode='draining'`, increment `epoch` exactly once, and take
   one immutable snapshot of all currently registered non-cleanup children and their settlement
   promises. Cleanup is excluded.
5. Store the new drain promise in `activeTermination` before signaling any target. Send SIGTERM
   once to each target whose `exitCode === null`.
6. Await whichever happens first: all snapshotted settlement promises settle, or the bounded force
   delay elapses. Do not always sleep the full force delay when all children close promptly.
7. On force-delay expiry, send SIGKILL once to each snapshotted target still live. Then await
   `Promise.allSettled` for every snapshotted settlement. A rejected test settlement cannot prevent
   the rest from settling. Production registry settlements are resolution-only on both child
   `error` and `close`; the separate `command()` promise carries the actual child error/status into
   existing scenario failure aggregation.
8. In `finally`, clear `activeTermination` and `activeTargets` only if they belong to the exact
   epoch promise. If
   `terminalRequested`, leave `mode='terminal'`; otherwise restore `mode='open'`.
9. A later call after `activeTermination` clears always increments the epoch and snapshots the
   then-live non-cleanup children, even if an earlier epoch succeeded or had no targets. Never
   retain or return a settled promise across epochs.

No child registered before an epoch starts may be absent from its snapshot. Because non-cleanup
registration is refused while draining, no child can enter unnoticed during an active epoch.

### 26.5 Sampler-failure and signal sequencing

Within `runScenario()` keep one nullable promise:

```js
let samplerDrainPromise = null;
```

On the first sampler failure only:

```js
samplerFailure = error;
samplerDrainPromise ??= childRegistry.terminateNonCleanup({ terminal: false });
```

Rules:

- repeated sampler failures reuse the active nonterminal epoch and do not double-signal;
- after `workloadPromise` and `stopSamplers()` settle, await `samplerDrainPromise` before spawning
  audit, post-run observability, logs, inspect, or beginning another scenario;
- a drain rejection/settlement anomaly is added to the scenario's aggregated failures and does not
  disappear behind the original sampler error;
- once the nonterminal drain settles and no signal occurred, the registry is open and diagnostic
  audit/observability may run in a new epoch; a later scenario may also run under the existing
  profile policy;
- if SIGINT/SIGTERM occurs before/during/after that drain, call
  `terminateNonCleanup({ terminal:true })`. This upgrades/coalesces an active epoch or starts a
  fresh terminal epoch over current diagnostic/new-scenario children;
- after terminal intent, no audit, observability, control, sampler, workload, or later-scenario
  child may spawn. Already-built failure evidence remains; root `finally` claims the sole cleanup;
- the signal handler's second-signal path calls
  `terminateNonCleanup({ terminal:true, forceDelayMs:0 })` to expedite the current epoch without a
  second SIGTERM or cleanup.

The main `finally` retains one cleanup call. Its `command(... role:'cleanup')` uses the same registry
claim and 60-second timeout. Cleanup failure is aggregated exactly once. No sampler failure,
scenario failure, repeated signal, or drain `finally` calls cleanup directly.

### 26.6 Required tests and real-process regression

Add these exact named tests to `load/stress.spec.ts`:

1. `A9 — settled drain does not memoize across workload then audit termination epochs`;
2. `A9 — concurrent nonterminal termination calls coalesce and signal epoch targets once`;
3. `A9 — non-cleanup spawn is refused during drain before spawn executes`;
4. `A9 — completed nonterminal drain reopens registry for a deliberate diagnostic epoch`;
5. `A9 — terminal request permanently refuses future non-cleanup spawn but permits one cleanup`;
6. `A9 — terminal request upgrades an active nonterminal drain and second signal force-kills survivors`;
7. `A9 — sampler failure drain settles before audit observability or later scenario spawn`;
8. `A9 — later SIGTERM snapshots and terminates post-sampler audit and observability children`;
9. `A9 — repeated failures and signals still claim exactly one cleanup child`;
10. `A9 — drain waits for all snapshotted settlements and leaves no registry child or timer leak`;
11. `A9 — real child processes terminate across nonterminal and terminal epochs`.

The first regression reproduces the escalation exactly: terminate a workload, resolve/clear epoch
1, register audit, terminate epoch 2, and require the audit receives SIGTERM and settles. It must
fail against the forever-memoized implementation.

The real-process regression uses the real `process.execPath` and argv-based `command()` to spawn a
long-lived Node workload child. Nonterminal drain must terminate it. Then spawn a distinct
long-lived Node audit child, terminal drain must terminate it, future non-cleanup spawn must be
rejected before the injected spawn counter increments, and one short cleanup-role Node child may
run exactly once. Use a 10-second test timeout, unique PID/start-time evidence, and `finally`
TERM/KILL fallback for only those exact children. Assert no child, timer, or promise remains.

Fake-child tests must model `exitCode`, SIGTERM/SIGKILL, `close`, error settlement, and controllable
force delay. Assert exact signal arrays, epoch/state transitions, spawn-call counts, and cleanup
claim count. Source grep alone is insufficient.

### 26.7 Focused/root verification and review

Run and return actual output/status:

```bash
pnpm --filter @flash/load lint
pnpm --filter @flash/load typecheck
pnpm --filter @flash/load exec vitest run stress.spec.ts
pnpm --filter @flash/load exec vitest run stress.spec.ts -t "A9 — real child processes terminate across nonterminal and terminal epochs"
pnpm --filter @flash/load test
node scripts/stress.mjs --help
rg -n "terminationPromise|activeTermination|terminalRequested|samplerDrainPromise|claimSpawn|terminateNonCleanup" scripts/stress.mjs load/stress.spec.ts
```

The `terminationPromise` grep may match only a named negative-control fixture/description proving
the old forever-memoized behavior fails; production registry source must contain zero such
singleton. A test passing without executing all 11 named A9 cases is not focused evidence.

Root reruns the unchanged canonical graph from §24.4 and proves the deterministic implementation
digest changed once for A9 and is stable across two unchanged computations. Preserve the passed
A5 interruption-smoke evidence; it proves the terminal first epoch. A9's real child test supplies
the missing two-epoch proof, so no destructive Docker interruption rerun is required unless review
finds the production signal integration diverges from the tested registry.

Then invoke `adversarial-reviewer`. It must reproduce workload→drain→audit→SIGTERM, sampler-failure/
signal overlap, child registration at drain boundaries, terminal upgrade, second-signal force,
spawn throw, settlement rejection, cleanup duplication, and timer/process leakage. Any critical
finding returns to A9-H; repeated underlying failure escalates per AGENTS.md §8.

Only after approval may root choose a wholly new baseline ID. A3, A5 natural-warmup, and A5
interruption evidence remain immutable diagnostics. No A9 path changes workload rates, thresholds,
resource limits, audit/readiness semantics, or T1 eligibility.

### 26.8 Invariants and copy-ready brief

- **I1–I3:** no business-decision, stock, buyer, or window behavior changes.
- **I4:** every producer/observer child is terminated in the applicable epoch before cleanup or a
  later audit can claim stable terminal state; no detached workload can mutate confirmed state
  after evidence capture.
- **Operational gate:** sampler failure stays aggregated. Diagnostics may run only after the failed
  epoch fully drains; terminal interruption forbids them and allows only the single cleanup.

> **A9-H dispatch.** You are not alone in the repository; preserve unrelated edits and do not
> revert another agent. Start only after A7-L/A8 are green. Read `.claude/contracts/phase-5.md`
> §26 completely. Load skills in exact order: `k6`, `turborepo-monorepo`, `vitest`. Own only
> `scripts/stress.mjs` and `load/stress.spec.ts`. Replace the forever-memoized termination promise
> with the frozen open/draining/terminal multi-epoch registry, synchronous spawn claims, terminal
> upgrade/second-signal expedite, awaited sampler-failure drain, and exactly-one-cleanup rule.
> Implement all 11 named tests including the real two-epoch Node child regression. Preserve A5
> failure aggregation/evidence, A7 argv, all thresholds/readiness/I1–I4, and scoped cleanup. Run
> §26.7 focused commands and return actual output/status. Do not edit any path outside ownership,
> start a baseline, or tune anything.

---

## 27. AMENDMENT A10 — module-rooted audit output and lifecycle-aware observability evidence

**Status:** FROZEN corrective amendment after immutable baseline
`baseline-20260723-a4` stopped after its warmup.
**Amends:** §§8.1, 9, 10.2, 14, 16 and Amendments A5–A9.
**Sequence:** implementation begins only after A9 is green and approved. T1 remains forbidden.

### 27.1 Immutable evidence and classification

Preserve without edit, backfill, merge, rename, or deletion:

```text
load/results/raw/baseline-20260723-a4/
```

The warmup k6 evidence is diagnostic only:

```text
confirmed=200
http_req_failed.rate=0
dropped_iterations.count=0
unexpected responses=0
purchase p95=4.4404 ms
```

Cleanup is recorded `0` with no project-scoped residual resource. Audit exited `1` before any
datastore collection, so this run has **no I1–I4 verdict**. `audit.json`, `api.log`, and
`worker.log` must not be created after the fact.

Three independent harness defects caused the failure:

1. Runner passed absolute `/repo/load/results/raw/<runId>/.../audit.json`. The audit computed its
   allowed root with `resolve('load/results/raw', runId)` from pnpm's package cwd `/repo/load`,
   producing `/repo/load/load/results/raw/<runId>` and rejecting the valid path.
2. Sampling began while the k6 Compose one-off container was still being created. The first stats
   timestamp correctly contained Redis/Postgres/API/worker but not k6; five subsequent timestamps
   contained all five. The validator incorrectly demanded k6 at every timestamp and also inferred
   cadence from total sampler wall time instead of completed single-flight observations.
3. Healthy quiet API/worker containers emitted zero Compose log lines. The commands exited 0, but
   the validator treated empty stdout as command failure and wrote no deterministic capture
   evidence.

These are evidence-transport/validation defects, not saturation, invariant failure, or tuning
evidence. No workload, threshold, readiness, resource, application logging, or T1 change is
authorized.

### 27.2 Exclusive ownership and skills

No two slices own one path. They may run in parallel only after A9 has closed.

#### A10-A — root-independent audit output containment (`implementer`)

Mandatory skills, in order: `turborepo-monorepo`, then `vitest`.

```text
load/audit.ts                                        ~
load/audit.spec.ts                                   ~
```

#### A10-O — lifecycle-aware stats and deterministic log capture (`implementer`)

Mandatory skills, in order: `k6`, `redis-observability`, `multi-stage-dockerfile`, then `vitest`.

```text
scripts/stress.mjs                                   ~
load/stress.spec.ts                                  ~
```

**Forbidden to both:** every other path; package scripts/dependencies; application, worker,
Redis-package, shared, schema, Compose, CI, k6 workloads, thresholds, rates, durations, resource
limits, result Markdown/manifest, `.env.example`, `.gitignore`, root package/lock/workspace,
`turbo.json`, T1, `STATE.md`, `.codex/`, commits, and tags. A10-O must preserve A7–A9 argv,
child-registry, sampler-failure, interruption, and cleanup semantics.

### 27.3 Module-rooted audit output containment

`load/audit.ts` exports this frozen constant:

```ts
export const AUDIT_RAW_RESULTS_ROOT = fileURLToPath(
  new URL('./results/raw/', import.meta.url),
);
```

Production containment is derived only from the audit module location. It never uses
`process.cwd()`, `resolve('load/results/raw')`, caller env, a new CLI flag, or the runner's claimed
root.

`parseAuditCli()` keeps the exact A1–A8 flag set and adds an optional test seam only:

```ts
export interface AuditPathSeams {
  rawResultsRoot?: string; // defaults to AUDIT_RAW_RESULTS_ROOT
  realpathSync?: typeof import('node:fs').realpathSync;
  lstatSync?: typeof import('node:fs').lstatSync;
}

export function parseAuditCli(
  argv: readonly string[],
  seams?: AuditPathSeams,
): CliOptions;
```

Exact validation order after existing flag/run/scenario/integer/loopback checks:

1. Read the original `--out` string. Require `isAbsolute(outArg) === true`; do not make a relative
   value absolute with `resolve()`.
2. Resolve/normalize `rawResultsRoot` and require its realpath is a directory.
3. Construct `lexicalRunRoot = join(normalizedRawRoot, runId)`. The already-frozen run-ID regex
   makes `runId` one path segment. Require the run directory exists and its realpath remains a
   strict descendant of the real raw root.
4. Normalize the absolute output. Use `relative(lexicalRunRoot, out)` and reject empty,
   `..`/`../...`, absolute, or sibling-prefix results. The output must be a descendant of the exact
   CLI run ID, not merely a similarly prefixed directory.
5. Require `basename(out) === 'audit.json'` and an existing parent directory. Resolve the parent's
   realpath and require it is a descendant of the real exact run root. This rejects an intermediate
   symlink that escapes after lexical validation.
6. If `lstatSync(out)` succeeds, reject with `Audit output already exists`; an immutable run is
   never overwritten/backfilled. Only `ENOENT` is the expected missing-output condition; propagate
   other filesystem errors.
7. Return the normalized absolute output. The runner's normalized absolute path remains unchanged.

Containment comparison is path-segment based via `relative`, never `startsWith`. The canonical raw
root and exact run root themselves may not resolve outside the module-owned `load/results/raw`
tree. Password redaction and the rule “fail before opening a datastore” remain binding.

No `--raw-root`, cwd fallback, environment override, relative-output acceptance, symlink follow,
or parser exception for tests is permitted.

### 27.4 Lifecycle-aware container-stats evidence

A10-O records these exact UTC ISO fields in each scenario `runtime.json`:

```text
workloadStartedAt   # immediately before invoking the workload command/spawn
workloadSettledAt   # immediately when the workload command promise settles, success or failure
```

Existing `samplerStartedAt` and `samplerStoppedAt` remain. All four must parse, satisfy:

```text
workloadStartedAt <= samplerStartedAt < samplerStoppedAt
workloadStartedAt < workloadSettledAt <= samplerStoppedAt
```

If a failure prevents a timestamp, sampler validation fails rather than inventing it.

Freeze:

```js
export const CORE_STATS_SERVICES = ['redis', 'postgres', 'api', 'worker'];
export const WORKLOAD_STATS_SERVICE = 'k6';
export const STATS_MAX_COMPLETION_GAP_MS = 3500;
export const K6_DISCOVERY_GRACE_MS = 10000;
```

`validateSamplerEvidence()` groups normalized CSV rows by timestamp and applies:

1. Every timestamp is unique/strictly increasing at the group level, lies within
   `[samplerStartedAt, samplerStoppedAt]`, and contains exactly one row for each core service.
2. Unknown service names, duplicate service rows, empty normalized fields, container names not
   scoped to the exact Compose project, malformed CSV/timestamp, or missing core service fail.
3. k6 is required at **at least two distinct timestamps**. No-k6 evidence fails.
4. The startup phase is `[samplerStartedAt, firstK6Timestamp)`. Core-only timestamps are valid
   there because Compose may not yet expose the one-off container. Discovery must occur no later
   than `min(workloadSettledAt, workloadStartedAt + K6_DISCOVERY_GRACE_MS)`.
5. The observed active interval is `[firstK6Timestamp, lastK6Timestamp]`. Every stats timestamp in
   that closed interval must contain all four core services and k6. Missing k6 between first and
   last is a hard evidence gap.
6. The settlement tail is `(lastK6Timestamp, samplerStoppedAt]`. Core-only timestamps are valid
   only after workload settlement; a pre-settlement timestamp after last observed k6 fails.
7. Every k6 timestamp must lie within `[workloadStartedAt, workloadSettledAt]`. The first stats
   completion occurs within `STATS_MAX_COMPLETION_GAP_MS` of `samplerStartedAt`; consecutive group
   completions differ by at most that value; and `workloadSettledAt - lastK6Timestamp` is within
   that value. Negative/out-of-order gaps fail.
8. Replace the old `floor(totalSamplerDuration/1000)-1` count formula. The scheduler still fires
   every 1 second and remains single-flight; evidence completeness is proven by the bounded
   completion gaps, two-or-more active k6 observations, and exact per-phase services rather than
   pretending a slow `docker stats` subprocess can overlap itself.

Return `statsSamples` as distinct timestamp groups and add:

```ts
statsPreWorkloadSamples: number;
statsActiveSamples: number;
statsPostWorkloadSamples: number;
firstK6ObservedAt: string;
lastK6ObservedAt: string;
maxStatsCompletionGapMs: number;
```

to `runtime.json.samplerEvidence`. A pre-k6 row is not discarded; it remains valid core-service
startup evidence. This amendment does not allow a missing core service, missing k6 over the active
interval, sparse/unbounded sampling, failed stats command, or empty stats file.

### 27.5 Deterministic nonempty Compose-log evidence

Keep the exact commands and argv:

```text
docker compose -p <project> -f load/docker-compose.yml logs --no-color --timestamps api
docker compose -p <project> -f load/docker-compose.yml logs --no-color --timestamps worker
```

For each service, validate command exit/signal/timeout **before** formatting. Nonzero exit, signal,
timeout, or spawn error remains failure, records the real command status, preserves redacted
stderr in aggregate diagnostics, and may not produce a success/empty marker.
For an exit-0 capture, stderr must also be empty; nonempty Compose stderr is aggregated as an
evidence-command failure rather than discarded or represented as an application log line.

Replace `validateTimestampedLogs` with the frozen formatter/parser pair:

```js
export function formatComposeLogEvidence(service, result, capturedAt);
export function validateComposeLogEvidence(service, artifactText);
```

Allowed service is exactly `api|worker`. `capturedAt` is a canonical UTC ISO timestamp recorded in
`runtime.json.logsCapturedAt`. A successful artifact is UTF-8, newline-terminated, and begins with
exactly:

```text
# phase5-compose-log-evidence-v1
# capturedAt=<canonical UTC ISO>
# service=<api|worker>
# commandExit=0
# sourceLineCount=<nonnegative integer>
# sourceEmpty=<true|false>
```

For `sourceLineCount=0`, append exactly:

```text
# no application log lines emitted
```

This is explicitly runner-generated capture metadata, not an application message. It proves the
correct Compose command succeeded and returned no source lines. It must never be included in fatal
application-log regex evaluation.

For `sourceLineCount>0`, `sourceEmpty=false` and the header is followed byte-for-byte by the
redacted source lines. Each source line must contain the Compose `--timestamps` timestamp after an
optional Compose service prefix (`<container> | `). Source timestamps use Compose's RFC3339 UTC
form `YYYY-MM-DDTHH:mm:ss[.1-9 fractional digits]Z` and must parse to a finite instant; unlike the
runner-owned `capturedAt`, they are not rewritten to millisecond precision. There is no empty
marker in this form. The parser returns only `sourceText` and count for fatal-log evaluation;
metadata comments cannot suppress or satisfy application-log checks.

The parser fails closed on wrong/missing/duplicate headers, invalid service/capture time/exit,
count mismatch, contradictory empty flag/marker, marker mixed with source, untimestamped source,
missing final newline, or extra metadata. `apiLogs`/`workerLogs` command status becomes 0 only after
both the real command and written artifact validate. `validateEvidenceInventory()` accepts a
canonical zero-source artifact as nonempty valid evidence; it never accepts a zero-byte/missing
file.

Do not add application log lines, change `LOG_LEVEL`, force startup chatter, treat stderr from a
failed command as application output, or fabricate a timestamped source line.

### 27.6 Exact tests and negative controls

#### A10-A tests in `load/audit.spec.ts`

1. `A10 — module-relative raw root accepts runner absolute output from repo root load cwd and unrelated cwd`;
2. `A10 — relative audit output is rejected instead of resolved from cwd`;
3. `A10 — traversal sibling-prefix and mismatched run-id output paths are rejected`;
4. `A10 — symlinked output parent escaping the exact run root is rejected`;
5. `A10 — existing audit output is rejected and never overwritten`;
6. `A10 — valid normalized audit path is returned unchanged before datastore construction`.

The cwd test saves/restores cwd in `finally` and runs serially. Use temporary real directories for
symlink/realpath cases; remove only those exact temporary fixtures. Assert no PG pool or Redis
client factory is invoked by parser tests. Existing invalid-run-ID and non-loopback controls remain.

#### A10-O tests in `load/stress.spec.ts`

1. `A10 — core-only startup stats followed by complete k6 interval are accepted`;
2. `A10 — no k6 observations or fewer than two active observations fail closed`;
3. `A10 — any timestamp missing a core service fails in every lifecycle phase`;
4. `A10 — missing k6 between first and last k6 timestamps fails the active interval`;
5. `A10 — late discovery sparse completion gap and stale final k6 observation fail`;
6. `A10 — k6 observation outside workload lifecycle fails`;
7. `A10 — duplicate unknown or wrong-project stats rows fail`;
8. `A10 — sampler evidence reports exact pre active post counts and bounded gaps`;
9. `A10 — successful empty API and worker log commands produce canonical nonempty metadata evidence`;
10. `A10 — timestamped source logs are preserved and fatal scan receives source lines only`;
11. `A10 — failed signaled or timed-out log command cannot produce successful empty evidence`;
12. `A10 — contradictory count marker header timestamp or source line fails log evidence validation`;
13. `A10 — evidence inventory accepts canonical empty-log artifacts but rejects missing or zero-byte logs`.

Use synthetic CSV/log fixtures for negative controls. Add one real Compose-log smoke after the
isolated API/worker are healthy: execute both exact log commands, accept either canonical
zero-source or timestamped-source form, validate both artifacts, and prove a deliberately failing
Compose project/command returns nonzero and cannot be formatted as success. This smoke uses the
existing disposable project only and performs no application/datastore mutation.

### 27.7 Focused, root, and review gates

Run and return actual output/status:

```bash
# A10-A
pnpm --filter @flash/load lint
pnpm --filter @flash/load typecheck
pnpm --filter @flash/load exec vitest run audit.spec.ts -t "A10"

# A10-O
pnpm --filter @flash/load lint
pnpm --filter @flash/load typecheck
pnpm --filter @flash/load exec vitest run stress.spec.ts -t "A10"

# Combined
pnpm --filter @flash/load test
node scripts/stress.mjs --help
rg -n "AUDIT_RAW_RESULTS_ROOT|workloadStartedAt|workloadSettledAt|CORE_STATS_SERVICES|phase5-compose-log-evidence-v1" load/audit.ts load/audit.spec.ts scripts/stress.mjs load/stress.spec.ts
```

Root reruns:

```bash
pnpm install --frozen-lockfile
pnpm format:check
pnpm exec turbo run lint typecheck test build test:integration --force
pnpm audit --audit-level high
node scripts/assert-build-output.mjs apps/api/dist/main.js apps/worker/dist/main.js
PHASE5_K6_UID="$(id -u)" PHASE5_K6_GID="$(id -g)" RAW_RESULT_DIR=/tmp/phase5-contract-results docker compose -p flash-load-contract -f load/docker-compose.yml config -q
docker compose -f infra/docker-compose.yml config -q
git diff --check
```

Root then runs the A10-O real Compose-log smoke against one uniquely named disposable Phase 5
project, records both validated artifacts and command statuses, and performs/validates exact
project-scoped cleanup. Do not use `baseline-20260723-a5` for this smoke.

After all verification is green, invoke `adversarial-reviewer`. It must attempt cwd changes,
relative/sibling/traversal/symlink paths, existing-output overwrite, k6 startup/exit edges, a single
k6 sample, missing middle k6/core rows, sparse timestamps, wrong project container names, empty
successful logs, failed empty logs, metadata/source confusion, fatal regex bypass, malformed
timestamps, command-status fabrication, sampler/child leaks, and cleanup scope. Critical findings
return to the owning A10 slice; repeated underlying failure escalates per AGENTS.md §8.

### 27.8 Next baseline and invariants

After both slices, focused/root gates, real log smoke, and adversarial review are green, the next
and only authorized untuned baseline ID is:

```text
baseline-20260723-a5
```

It must not exist before dispatch and may be used once. Run one audited warmup, then one repetition
of surge, duplicate-storm, sold-out, and window-edge. Any failure makes it immutable and requires a
new architect-declared ID; never backfill/reuse it. T1 remains dormant until this complete baseline
satisfies the original entry condition.

- **I1–I3:** no decision/window/stock/user semantics change. Audit must execute and evaluate fresh
  datastore evidence before any verdict.
- **I4:** module-rooted containment allows the intended atomic audit artifact without accepting
  traversal or overwrite; lifecycle stats/log evidence cannot convert command absence/failure into
  success or hide a detached workload.
- **Operational:** a healthy quiet service may have zero source log lines, but only a successful
  exact Compose command plus canonical metadata proves that fact. Missing/failed evidence remains
  failure.

### 27.9 Copy-ready briefs

> **A10-A dispatch.** You are not alone in the repository; preserve unrelated edits and do not
> revert another agent. Start only after A9 is green. Read `.claude/contracts/phase-5.md` §27.1–
> §27.3 and §27.6–§27.8. Load skills in exact order: `turborepo-monorepo`, `vitest`. Own only
> `load/audit.ts` and `load/audit.spec.ts`. Implement the module-relative
> `AUDIT_RAW_RESULTS_ROOT`, exact absolute/run-ID/realpath/symlink/non-overwrite containment, and
> all six named tests. Preserve CLI flags, A7/A8 forwarding, parser error taxonomy, loopback/run-ID
> validation, redaction, convergence, and I1–I4. Run A10-A focused commands and return actual
> output/status. Do not touch any other path or start a baseline.

> **A10-O dispatch.** You are not alone in the repository; preserve unrelated edits and do not
> revert another agent. Start only after A9 is green. Read `.claude/contracts/phase-5.md` §27.1–
> §27.2 and §27.4–§27.8. Load skills in exact order: `k6`, `redis-observability`,
> `multi-stage-dockerfile`, `vitest`. Own only `scripts/stress.mjs` and `load/stress.spec.ts`.
> Implement workload lifecycle timestamps, exact core/k6 phase and bounded-gap stats validation,
> canonical nonempty Compose-log evidence for successful zero-source capture, strict command/
> artifact validation, all 13 named tests, and the disposable real log smoke. Preserve A7–A9
> argv/registry/interruption/cleanup, readiness, digest, thresholds, and I1–I4. Run A10-O focused
> commands and return actual output/status. Do not touch any other path or start a baseline.

## 28. AMENDMENT A11 — inode-pinned, no-overwrite audit publication

**Status:** frozen correction to A10-A after adversarial rejection. This amendment supersedes only
the final audit-publication mechanism in §27.3. All A10 path parsing and containment requirements
remain mandatory. A10-O is approved and closed; A11 must not reopen or edit it.

### 28.1 Trigger, decision, and rejected alternatives

The A10-A implementation validates the output parent and output absence during
`parseAuditCli()`, but later publishes with unchecked `mkdir`/temporary write/`rename`. That leaves
two high-severity time-of-check/time-of-use races:

1. after parsing, an attacker can rename the validated parent and replace its pathname with a
   symlink to an outside directory, redirecting the report outside the raw-results root;
2. after parsing, another writer can create `audit.json`, and a later `rename(temp, audit.json)`
   silently replaces that intervening immutable content.

**Decision:** publication is Linux-only and fail-closed. Parsing captures the device/inode identity
of the raw-results root and every directory from that root to the output parent. Publication opens
and pins those directories one segment at a time with `O_DIRECTORY | O_NOFOLLOW` through
`/proc/self/fd`, revalidates every captured identity, creates an exclusive temporary regular file
inside the pinned parent, and atomically publishes it with a same-directory hard link. Hard-link
creation fails with `EEXIST`, so publication can never replace an existing `audit.json`.

**Rejected alternatives:**

| Alternative rejected | Why |
| --- | --- |
| Re-run `realpath`/`lstat`, then use normal pathname `rename` | It merely moves the race; an ancestor can change between the final check and rename, and rename still overwrites. |
| `rename(temp, output)` after checking output absence | POSIX rename replaces an intervening destination and violates report immutability. |
| `COPYFILE_EXCL`, stream copy, or direct exclusive write to `audit.json` | Copy/direct write exposes a partial report before all bytes and durability checks complete. |
| Random temporary name without `O_EXCL` | A colliding file or symlink can be followed or overwritten. |
| Native-addon-only `openat2`/`renameat2` | No such dependency is frozen for Phase 5. The Linux `/proc/self/fd` anchor provides a practical Node 22 implementation without expanding dependencies. |
| Best-effort fallback on non-Linux or without `/proc/self/fd` | A weaker fallback silently reintroduces the security property this amendment exists to enforce. |

This amendment requires no new dependency and no environment variable.

### 28.2 Ownership, sequencing, and skills

There is one implementation slice, **A11-A**, with exclusive ownership of exactly:

```text
load/audit.ts
load/audit.spec.ts
```

It loads these project-local skills in exact order before editing:

1. `turborepo-monorepo`
2. `vitest`

No other path is owned. In particular, do not edit `scripts/stress.mjs`,
`load/stress.spec.ts`, manifests, lockfiles, Compose files, application packages, or prior raw
results. A10-O remains approved. A11-A starts from the rejected A10-A implementation and preserves
all A1–A10 CLI flags, parser diagnostics, audit calculations, redaction, convergence, digest, and
evidence semantics except where this section explicitly replaces publication.

Do not run `baseline-20260723-a5` during implementation, verification, or review.

### 28.3 Frozen publication interfaces

`load/audit.ts` exports these structural contracts. An implementation may add private fields and
helpers, but must not rename or weaken these fields:

```ts
export interface AuditFileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

export interface AuditDirectoryIdentity extends AuditFileIdentity {
  /** One normalized, non-empty path segment; never ".", "..", or slash-containing. */
  readonly segment: string;
}

export interface AuditPublicationPlan {
  readonly rawRootPath: string;
  readonly rawRootIdentity: AuditFileIdentity;
  /** Ordered children below rawRootPath, including run directory and output parent. */
  readonly directoryChain: readonly AuditDirectoryIdentity[];
  readonly outputName: 'audit.json';
}

export interface AuditPublicationSeams {
  readonly platform?: NodeJS.Platform;
  readonly procFdRoot?: string;
  readonly randomBytes?: (size: number) => Buffer;
  /** Barrier after directory pin/revalidation but before output/temp publication. */
  readonly beforePublish?: () => void | Promise<void>;
}

export async function publishAuditReport(
  plan: AuditPublicationPlan,
  reportBytes: string | Uint8Array,
  seams?: AuditPublicationSeams,
): Promise<void>;
```

`parseAuditCli()` retains the A10 `AuditPathSeams` argument and returns its existing CLI options
plus an `AuditPublicationPlan` used by `runCli()`. The plan is internal CLI state and is never
serialized into the audit report. Parse-time identity reads use bigint stats and record:

- `AUDIT_RAW_RESULTS_ROOT` after resolving its real path and rejecting a symlink/non-directory;
- every real directory segment below that root through the exact output parent;
- `outputName` as the literal `audit.json`.

Every recorded child segment is one component only: non-empty, not `.` or `..`, and containing
neither `/` nor `\`. The chain begins with the exact validated run-ID directory and ends with the
output parent. Parsing still rejects a pre-existing output, but that check is advisory defense in
depth; publication independently enforces no-overwrite.

The production call from `runCli()` is exactly the full serialized report plus one trailing
newline:

```ts
await publishAuditReport(options.publication, `${JSON.stringify(report, null, 2)}\n`);
```

Production publication must not use `mkdir`, `rename`, copy-to-final, or write-to-final.

### 28.4 Fail-closed Linux directory pinning

`publishAuditReport()` performs these steps in order:

1. Require `platform === 'linux'` and an accessible `/proc/self/fd` (the production default).
   Unsupported platform, missing procfs, or inability to use descriptor anchors is a hard error
   before temporary or final output creation. There is no pathname fallback.
2. Open `plan.rawRootPath` read-only with `O_DIRECTORY | O_NOFOLLOW`; `fstat({ bigint: true })`
   must be a directory and match `rawRootIdentity.dev` and `.ino`.
3. For each `directoryChain` entry, open exactly
   `/proc/self/fd/<current-directory-fd>/<segment>` read-only with
   `O_DIRECTORY | O_NOFOLLOW`. Its bigint `fstat` must be a directory and match the recorded
   device/inode. Keep the parent handle open until publication and cleanup finish.
4. Any symlink, missing/replaced directory, identity mismatch, invalid segment, or descriptor
   failure aborts before publication. A renamed original directory does not authorize following
   an attacker-controlled replacement at the old pathname.
5. All later temporary/final operations use the pinned output parent through
   `/proc/self/fd/<parent-fd>/...`; the original absolute output pathname is never reused.

Node does not expose `openat(2)` directly. Using the pinned descriptor path is the frozen practical
Node 22 mechanism for this phase. The implementation uses numeric descriptors obtained from live
`FileHandle`s, never directory listings or a search for matching inodes.

### 28.5 Exclusive temporary file and atomic no-overwrite publication

After the final parent is pinned:

1. Invoke `beforePublish`, if supplied. This is the deterministic race barrier and is omitted by
   the production call.
2. `lstat` the anchored `audit.json`. `ENOENT` is required. Any object is
   `Audit output already exists`; no existing object is modified.
3. Generate a temporary basename `.audit.json.<pid>.<nonce>.tmp`, where `<nonce>` is exactly 32
   lowercase hexadecimal characters from 16 random bytes. Validate it as one path component.
4. Open the anchored temp with `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW`, mode `0o600`. On
   `EEXIST`, try a new nonce. The exact budget is three candidate names. Exhaustion throws
   `Audit temp name collision budget exhausted`. Never unlink a colliding foreign object.
5. Write all `reportBytes`, verify the written byte count/regular-file size, call the temp handle's
   `sync()`, and retain its bigint device/inode identity. Complete short writes correctly or fail.
6. Before linking, anchored `lstat` of the temp must show a regular file with the same device,
   inode, and byte size as the owned open handle. A mismatch or symlink swap aborts without
   touching the final name.
7. Atomically call `link(anchoredTemp, anchoredAuditJson)`. Both names are in the pinned directory,
   so it is same-filesystem and becomes visible as one complete inode. `EEXIST` throws
   `Audit output already exists`; it never triggers final-name unlink or retry.
8. Anchored `lstat` of `audit.json` must be a regular file with the owned temp's device, inode,
   size, and permission bits `0o600`. Then call the pinned parent handle's `sync()`.
9. Remove the temp name only after anchored `lstat` confirms it still names the owned device/inode.
   Sync the parent directory again after successful cleanup. The final hard link remains.

Success means exactly one complete `audit.json`, no owned temp name, no overwrite, and all handles
closed. The final report is never reopened for mutation.

### 28.6 Error, cleanup, and ownership rules

Cleanup is identity-scoped:

- Before a successful hard link, remove the owned temp only when anchored `lstat` still matches
  the recorded device/inode. If it differs or is absent, do not remove it.
- Never remove `audit.json`, including after a post-link validation, directory-sync, temp-cleanup,
  or handle-close error. Once the hard link succeeds, a complete immutable report exists and must
  survive the reported failure.
- Never remove any of the three foreign collision candidates.
- Close every opened file and directory handle in `finally`, in reverse acquisition order.
- Preserve the primary publication error. Cleanup/close errors are attached with `AggregateError`
  or an equivalent `cause` chain rather than replacing or hiding it.
- A cleanup error is not success. Report it while preserving any already-published final artifact.

No recursive cleanup, glob cleanup, run-directory deletion, or original-path cleanup is permitted.
Tests remove only their exact disposable fixtures.

### 28.7 Deterministic regression tests

Add these exact test cases to `load/audit.spec.ts`. They use finite promises/seams and real
temporary Linux directories where filesystem behavior is under test; no sleeps, polling races,
or wall-clock timing assertions:

1. `A11 — parent symlink swap after parse cannot publish outside the validated run`
   - after parse, rename the validated parent and replace its old path with a symlink to an outside
     directory; prove rejection and absence of `outside/audit.json`.
2. `A11 — intervening audit creation is never overwritten by atomic publication`
   - use `beforePublish` to create `audit.json` with sentinel bytes after parse/pinning; prove
     rejection, unchanged sentinel bytes, and absence of the owned temp.
3. `A11 — replacement real directory inode is rejected as an ancestor swap`
   - replace one validated ancestor with a different real directory; prove identity rejection
     before temporary/final output.
4. `A11 — three temp-name collisions exhaust bounded budget without removing foreign files`
   - inject three nonces, pre-create all candidates with distinct sentinel bytes, and prove the
     exact exhaustion error and unchanged files.
5. `A11 — temp write sync and link failures clean only the owned temp`
   - cover short/write, temp-sync, and hard-link failure; prove no final/owned temp and preservation
     of unrelated files.
6. `A11 — successful hard-link publication is atomic complete mode-0600 and leaves no temp`
   - prove exact bytes including trailing newline, regular-file mode, one final name, and no temp.
7. `A11 — post-link validation or directory-sync failure preserves published immutable output and reports failure`
   - inject failure after link; prove rejection, complete final bytes, and no later overwrite.
8. `A11 — unsupported platform or unavailable proc fd fails with no path fallback`
   - cover both failures and prove no temp/final creation.
9. `A11 — repeated publication rejects existing output and preserves first report bytes`
   - publish once, attempt different bytes, and prove the first bytes remain exact.
10. `A11 — every directory handle and temp handle closes on success and failure`
    - instrument handles and prove balanced acquisition/close on success, pre-link failure, and
      post-link failure.

The two reported reproductions (tests 1 and 2) execute their mutations after `parseAuditCli()` has
returned; test 2 mutates after publication has pinned/revalidated the parent. Existing A10 cwd,
relative, traversal, symlink-parent, existing-output, and valid-normalized-path tests remain green.

Filesystem wrappers for deterministic failures stay private except `AuditPublicationSeams`;
production defaults call `node:fs/promises` directly. A seam must not disable identity,
`O_NOFOLLOW`, `O_EXCL`, hard-link, mode, or cleanup checks.

### 28.8 Verification and review gate

A11-A returns actual output and status for:

```bash
pnpm --filter @flash/load lint
pnpm --filter @flash/load typecheck
pnpm --filter @flash/load exec vitest run audit.spec.ts -t "A11"
pnpm --filter @flash/load exec vitest run audit.spec.ts
pnpm --filter @flash/load test
rg -n "publishAuditReport|O_DIRECTORY|O_NOFOLLOW|O_EXCL|/proc/self/fd|link\\(" load/audit.ts load/audit.spec.ts
rg -n "rename\\(|mkdir\\(" load/audit.ts
git diff --check
```

The final `rg` is a manual negative inspection: production publication contains zero `rename(` or
`mkdir(` use. Test descriptions or explicit rejection assertions are identified separately.

Root then runs the uncached graph and Phase 5 static checks:

```bash
pnpm install --frozen-lockfile
pnpm format:check
pnpm exec turbo run lint typecheck test build test:integration --force
pnpm audit --audit-level high
node scripts/assert-build-output.mjs apps/api/dist/main.js apps/worker/dist/main.js
PHASE5_K6_UID="$(id -u)" PHASE5_K6_GID="$(id -g)" RAW_RESULT_DIR=/tmp/phase5-contract-results docker compose -p flash-load-contract -f load/docker-compose.yml config -q
docker compose -f infra/docker-compose.yml config -q
git diff --check
```

Because `load/audit.ts` and `load/audit.spec.ts` are manifest inputs, root proves the source digest
changes once from the rejected A10-A tree and is stable across two consecutive unchanged
computations. Do not edit a raw result or backfill its digest.

After focused and root verification are green, invoke `adversarial-reviewer`. It explicitly
attempts:

- both reported races, including an outside symlink and an intervening final;
- symlink/different-directory substitution at every directory-chain depth;
- final `EEXIST` immediately before hard link;
- colliding temp names, a temp symlink, and a temp inode/name swap;
- short write plus write, temp-sync, link, post-link-stat, parent-sync, unlink, and close errors;
- interruption/crash visibility at pre-write, post-write/pre-link, and post-link points;
- deletion of foreign collisions, unrelated files, or an already-published final;
- descriptor leaks, pathname fallback, output mutation, and error masking.

A critical finding returns only to A11-A. Two consecutive failures on the same design issue
escalate to the architect per AGENTS.md §8. Approval states that the reviewer reproduced both
former exploits and observed fail-closed behavior.

### 28.9 Scope, invariants, and next baseline

A11 changes only audit artifact publication. It does not tune workloads, thresholds, Redis,
Postgres, queue behavior, API behavior, reconciliation, workload child lifecycle, or Compose-log
evidence. No benchmark is authorized by this amendment.

- **I1 — no oversell:** unchanged. The report is a read-only evaluator of fresh Redis/Postgres
  evidence; publication cannot alter purchase state.
- **I2 — one per user:** unchanged. Durable/hot-path uniqueness and audit queries are untouched.
- **I3 — window enforcement:** unchanged. Purchase-window semantics/evidence are untouched.
- **I4 — no lost confirmations:** strengthened at the evidence boundary. A complete report is
  atomically visible only inside the validated run, cannot replace a prior immutable verdict, and
  cannot be redirected by an ancestor swap. Persistence/compensation semantics are unchanged.

`baseline-20260723-a5` remains the next and only authorized untuned baseline ID, but it remains
absent and must not run until A11-A focused/root gates and adversarial review are green. After
approval, its one-use matrix and entry conditions remain exactly §27.8.

### 28.10 Copy-ready dispatch

> **A11-A dispatch.** You are not alone in the repository; preserve unrelated edits and do not
> revert another agent. Read `.claude/contracts/phase-5.md` §28 in full. Load skills in exact
> order: `turborepo-monorepo`, `vitest`. Own only `load/audit.ts` and `load/audit.spec.ts`.
> Replace A10-A's TOCTOU-prone publication with the frozen Linux `/proc/self/fd` directory-pinning,
> identity-revalidation, exclusive-temp, hard-link no-overwrite, identity-scoped cleanup protocol.
> Implement all ten exact A11 tests, including both reported races after parse. Preserve A1–A10
> CLI/audit semantics and approved A10-O paths. Run §28.8 focused commands and return actual
> output/status. Do not touch any other path, run a baseline, or weaken publication on unsupported
> platforms.

## 29. AMENDMENT A12 — validation-to-publication directory capability

**Status:** mandatory architect escalation after a second consecutive adversarial rejection in the
same audit-publication TOCTOU family. This amendment supersedes A11 §§28.3–28.7 wherever they
conflict. A10-O remains approved and closed.

### 29.1 Trigger and corrected security model

The live rejection proved that `(dev, ino)` is an observation, not a capability. On tmpfs, the
validated output parent was removed and recreated at the same pathname with the same device and
reused inode number. A11 later reopened that pathname, accepted the equal tuple, and published into
the replacement directory. A11 cleanup also performed `lstat(tempPath)` followed by
`unlink(tempPath)`, allowing a foreign object to replace that name between the check and deletion.

**Decision:** validation synchronously opens the actual output-parent directory and returns an
opaque capability that owns that live descriptor. The descriptor remains open across all audit
queries, convergence waits, report construction, publication, and failure handling. Publication
uses only `/proc/self/fd/<held-fd>/...`; it never reopens the raw root, an ancestor, or the output
parent by its original pathname and never authorizes an object from a later `(dev, ino)` match.

The capability pins the original inode, which prevents that inode from being recycled while the
capability is live. A deleted/replaced path is therefore distinct even on aggressive tmpfs inode
reuse. The descriptor's `/proc/self/fd` link is also checked against the canonical parent path
before and after publication for operational reachability. That string check may reject a rename,
but never authorizes a directory: all writes remain anchored to the held capability.

**Cleanup decision:** production never unlinks a temporary publication name. Node 22 exposes
neither `unlinkat` with an inode precondition nor another atomic “unlink this name only if it still
refers to this open file” operation. A check-then-unlink would recreate the reported race.
Temporary files are instead made non-writable through their open descriptor and retained as
harmless, bounded artifacts. Safety takes precedence over tidiness.

### 29.2 Linux/Node publication primitive ADR

Node 22's `fs.link()` accepts pathnames only. Linking
`/proc/self/fd/<open-temp-fd>` directly does not work: the kernel returns `EXDEV` because the source
is a procfs symlink unless it is logically dereferenced. Node exposes neither
`linkat(AT_EMPTY_PATH)` nor `renameat2(RENAME_NOREPLACE)`.

The frozen practical primitive is GNU coreutils `/usr/bin/ln`, executed by an already-open helper
descriptor:

```text
/proc/self/fd/5 -L -T -- /proc/self/fd/3 /proc/self/fd/4/audit.json
```

Child descriptor mapping is exact:

| Child fd | Capability |
| --- | --- |
| `3` | open temporary regular file |
| `4` | open validated output-parent directory |
| `5` | open validated `/usr/bin/ln` regular executable |

`-L` dereferences the child temp descriptor to the owned open inode. If its name was unlinked and
replaced, the proc descriptor resolves as deleted and linking fails rather than linking the foreign
replacement. `-T` makes `audit.json` the exact destination, so an intervening symlink-to-directory
cannot be treated as a target directory. No `-f`, `--force`, backup, or removal option is allowed;
an existing final causes failure without overwrite. The destination remains relative in effect to
the held directory descriptor.

Before spawning, production opens `/usr/bin/ln` with `O_RDONLY | O_NOFOLLOW` and requires a regular
file owned by uid 0 with no group/world write bit. The child executable is
`/proc/self/fd/5`, not a fresh `/usr/bin/ln` lookup. Spawn uses:

- exact argv above;
- `stdio` mappings 3–5 and no other inherited application descriptors;
- environment exactly `LC_ALL=C`, `LANG=C`;
- timeout 5,000 ms, `SIGKILL`, and combined stdout/stderr cap 65,536 bytes;
- status `0` as the only success.

After the helper, anchored final-file identity and contents are verified independently. Helper
failure never triggers retry with a weaker primitive.

**Alternatives rejected:**

| Alternative | Why rejected |
| --- | --- |
| Reopen pathname and compare device/inode | Inode reuse is the demonstrated exploit. |
| Keep A11 `lstat` then unlink | Deletion is not conditional and can remove a swapped foreign name. |
| Direct `O_EXCL` write to `audit.json` | Readers can observe partial evidence; atomic visibility is lost. |
| Named-temp `fs.link()` | The source name can be swapped between identity check and link. |
| Native addon or new FFI package | Expands the Phase 5 build/dependency surface for one syscall. |
| Silently leave A11 behavior on missing coreutils | Reintroduces the rejected race. Missing/invalid helper is a hard prerequisite failure. |

### 29.3 Exclusive ownership, skills, and boundaries

There is one slice, **A12-A**, with exclusive ownership of exactly:

```text
load/audit.ts
load/audit.spec.ts
```

Load project-local skills in exact order:

1. `turborepo-monorepo`
2. `vitest`

Do not edit manifests, lockfiles, `scripts/stress.mjs`, `load/stress.spec.ts`, Compose files,
application packages, raw results, or A10-O code. No dependency or environment variable is added.
GNU coreutils `/usr/bin/ln` is a Linux host prerequisite checked at runtime. Do not run or create
`baseline-20260723-a5`.

### 29.4 Frozen capability and lifecycle interfaces

A12 replaces `AuditPublicationPlan` with an opaque live capability:

```ts
export type AuditCapabilityState = 'open' | 'publishing' | 'closed';

export interface AuditPublicationCapability {
  readonly outputName: 'audit.json';
  readonly canonicalParentPath: string;
  readonly state: AuditCapabilityState;
  /** Idempotent. Closes the held directory descriptor and changes state to closed. */
  close(): void;
}

export interface AuditLinkHelperInvocation {
  readonly tempFd: number;
  readonly parentFd: number;
  readonly helperFd: number;
}

export interface AuditLinkHelperResult {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
}

export interface AuditPublicationSeams {
  readonly platform?: NodeJS.Platform;
  readonly procFdRoot?: string;
  readonly randomBytes?: (size: number) => Buffer;
  readonly beforePublish?: () => void | Promise<void>;
  readonly afterTempSync?: (tempName: string) => void | Promise<void>;
  readonly invokeLinkHelper?: (
    invocation: AuditLinkHelperInvocation,
  ) => AuditLinkHelperResult | Promise<AuditLinkHelperResult>;
}

export interface AuditPublicationReceipt {
  readonly outputName: 'audit.json';
  /** The implementation intentionally never deletes this read-only retained name. */
  readonly retainedTempName: string;
}

export async function publishAuditReport(
  capability: AuditPublicationCapability,
  reportBytes: string | Uint8Array,
  seams?: AuditPublicationSeams,
): Promise<AuditPublicationReceipt>;

export function closeAuditCliOptions(options: {
  readonly publication: AuditPublicationCapability;
}): void;
```

The concrete capability and its descriptor are module-private and branded (private class field,
private symbol, or `WeakMap`). Callers cannot forge a capability or obtain/mutate its fd through
the public interface. `state` is a read-only getter. `close()` is idempotent.

`parseAuditCli()` remains synchronous and returns the existing options with
`publication: AuditPublicationCapability`. Its validation algorithm is:

1. perform all A10 lexical, run-ID, canonical-root, symlink, output-name, and existing-output
   validation;
2. open the canonical raw root synchronously with `O_RDONLY | O_DIRECTORY | O_NOFOLLOW`;
3. traverse each validated child segment exactly once through the current
   `/proc/self/fd/<fd>/<segment>`, opening with `O_RDONLY | O_DIRECTORY | O_NOFOLLOW`;
4. retain the final output-parent descriptor as the capability and close every earlier descriptor;
5. check final absence through the retained descriptor and return the capability.

It does not store `(dev, ino)` as later authority and does not reopen any directory during
publication. Device/inode may be logged or asserted diagnostically but cannot grant access.

Any parse error closes every descriptor acquired before throwing. `closeAuditCliOptions()` delegates
to the idempotent capability close.

### 29.5 Mandatory ownership and closure semantics

Capability ownership follows these exact rules:

- `open` may transition once to `publishing`, then always to `closed`.
- `publishAuditReport()` atomically claims an open capability. A forged, already publishing, or
  closed capability rejects before filesystem mutation.
- `publishAuditReport()` closes the parent descriptor and transitions to `closed` in `finally` on
  every success and failure. The caller does not reuse it.
- `runCli()` declares parsed options outside its `try`, assigns after successful parse, and calls
  `closeAuditCliOptions(options)` in its outermost `finally`. This covers connection, query,
  convergence, serialization, publication, signal, and ordinary thrown failures; double close is
  harmless.
- If `parseAuditCli()` throws, it performs its own descriptor cleanup because no options object is
  returned.
- Programmatic callers that parse but do not publish must call
  `closeAuditCliOptions(options)` in `finally`. All existing parser tests and helpers are updated
  to obey this rule.
- Programmatic callers that publish may still call `closeAuditCliOptions()` in `finally`; it is
  idempotent.
- Graceful CLI termination uses the same `finally`. On `SIGKILL`, process crash, or abrupt runtime
  exit, the kernel closes descriptors; no exit hook attempts pathname deletion.

No global descriptor registry, finalizer, `beforeExit` cleanup, or signal-time unlink is allowed.

### 29.6 Capability-only publication and retained-temp protocol

Publication performs the following in exact order:

1. require Linux, valid procfs, branded open capability, and exact canonical descriptor
   `readlink(/proc/self/fd/<parentFd>) === canonicalParentPath`; `(deleted)` or any renamed path is
   a hard error;
2. transition to `publishing`, then invoke `beforePublish`;
3. repeat the descriptor-link canonical-path check; never inspect/reopen the original directory
   pathname;
4. anchored `lstat(audit.json)` must be `ENOENT`;
5. open a temp named `.audit.json.<pid>.<32-lowercase-hex>.retained` through the parent descriptor
   with `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW`, initially mode `0o600`; use the A11 exact
   three-candidate collision budget and never delete collisions;
6. write all bytes, verify size/regular-file identity through the open handle, `sync()`, change the
   owned inode through the handle to mode `0o400`, and `sync()` again;
7. invoke `afterTempSync`, then verify the descriptor still names a regular mode-`0400` file with
   exact size; do not trust the temp pathname;
8. open and validate `/usr/bin/ln`, invoke the exact descriptor-mapped helper from §29.2, and close
   the helper descriptor in `finally`;
9. on helper status 0, anchored `lstat(audit.json)` must match the open temp descriptor's
   device/inode, size, mode `0o400`, and link count at least 2; exact bytes read through the final
   must equal `reportBytes`;
10. sync the held parent directory, recheck its descriptor-link canonical path, close temp and
    parent descriptors, and return the retained temp basename.

There is no `unlink()` call in production publication or error handling.

On any failure after temp creation, use only the open temp handle to best-effort `chmod(0o000)` and
`sync()` before close unless the final link was already proven successful. Never touch the temp
name. If final publication was proven, keep both final and retained alias mode `0o400`; never
remove or mutate the final. Quarantine/close errors are aggregated with the primary error.

The retained artifact is bounded to at most one per publication attempt, contains only the already
redacted report bytes, and is either:

- mode `0400` and the same inode as a successful immutable final; or
- best-effort mode `0000` after a failed attempt.

An abrupt process exit can leave a mode-`0600` partial retained temp, but never a partial
`audit.json`. The next run ignores retained names, still requires final absence, and never cleans
old names automatically. This bounded residue is the explicit trade-off for race-free foreign-file
preservation with Node's API surface.

### 29.7 Deterministic A12 regression tests

Add these exact tests to `load/audit.spec.ts`; no sleeps or polling:

1. `A12 — live tmpfs inode reuse cannot replace the held output-directory capability`
   - use `/dev/shm` when available; first prove the former close/reopen pattern can recycle the
     same `(dev, ino)`, then parse a fresh fixture, remove/recreate its parent, prove publication
     rejects through the held/deleted capability, and prove the replacement has no final/temp.
   - if the host does not recycle within 256 create/remove iterations, the test records that
     platform fact and still runs the capability replacement assertion; it must not silently skip.
2. `A12 — ancestor rename and symlink replacement cannot redirect a held capability`
   - mutate after parse; prove descriptor-link mismatch/rejection and no artifact in the outside
     replacement.
3. `A12 — cleanup name swap never deletes the foreign replacement`
   - after temp sync, rename the owned temp, create foreign sentinel at its former name, inject
     helper failure, and prove both names/sentinel survive because production performs no unlink.
4. `A12 — helper links the open temp capability and refuses a swapped or deleted source name`
   - real GNU helper coverage: normal open temp succeeds; unlink-and-replace before helper fails
     without linking foreign bytes.
5. `A12 — final symlink directory and intervening final both fail without overwrite`
   - mutate after `beforePublish`; cover exact `-T` behavior and unchanged sentinel.
6. `A12 — parse failure closes every acquired descriptor`
   - inject failure at root, intermediate, parent, and final-absence check and prove balanced opens/
     closes.
7. `A12 — convergence and pre-publication CLI failures close the parsed capability`
   - exercise failures after successful parse but before publish and prove the descriptor is closed.
8. `A12 — programmatic parse users can close without publishing and close is idempotent`
   - cover every existing parse-only helper pattern and a double close.
9. `A12 — publication consumes its capability on success and every failure`
   - cover write, chmod, sync, helper, final validation, parent sync, and post-link reachability;
     state is `closed` and fd use returns `EBADF`.
10. `A12 — forged stale closed and concurrently publishing capabilities fail before mutation`
    - include repeat publish of one capability and a second call while the first waits at a seam.
11. `A12 — two valid parses race safely and only one immutable final wins`
    - both descriptors target the original directory; one helper wins, the other sees/fails on
      final existence; exact first bytes and both closed states remain.
12. `A12 — temp collisions and failures retain only bounded non-writable artifacts`
    - three foreign collisions remain unchanged; successful retained alias is `0400`; ordinary
      failure is best-effort `0000`; no final is partial.
13. `A12 — GNU helper validation spawn timeout signal and oversized output fail closed`
    - cover invalid owner/mode/type through seams, nonzero status, timeout, signal, output cap, and
      exact fd/argv/environment mapping.
14. `A12 — abrupt child exit closes capabilities and never exposes a partial final`
    - deterministic child modes exit before temp, after partial temp, and after helper success;
      prove no descriptor remains usable and only the frozen retained-artifact outcomes occur.
15. `A12 — successful publication is complete atomic mode-0400 and pathname-free after parse`
    - exact bytes/trailing newline, final/temp same inode, final mode `0400`, parent sync, receipt,
      no post-parse `open` of raw root/ancestors/parent, and no production `unlink`.

Existing A10 parser and A11 race tests remain, but their expected lifecycle is amended:

- parser tests close returned capabilities;
- A11 mode-`0600` success becomes A12 mode-`0400`;
- A11 “leaves no temp” becomes the intentional retained alias;
- A11 cleanup assertions require preservation/quarantine, never deletion;
- A11 pathname-reopen plan/identity authorization is removed.

Tests clean only their exact disposable fixtures after the production call and all assertions.
Test teardown may use unlink/rm; production code may not.

### 29.8 Verification and adversarial gate

A12-A returns actual output/status for:

```bash
pnpm --filter @flash/load lint
pnpm --filter @flash/load typecheck
pnpm --filter @flash/load exec vitest run audit.spec.ts -t "A12"
pnpm --filter @flash/load exec vitest run audit.spec.ts
pnpm --filter @flash/load test
rg -n "AuditPublicationCapability|closeAuditCliOptions|/proc/self/fd/5|-L.*-T|retained" load/audit.ts load/audit.spec.ts
rg -n "unlink\\(|rename\\(|AuditPublicationPlan|rawRootIdentity|directoryChain" load/audit.ts
git diff --check
```

The second `rg` is a negative production inspection: expected output is zero production matches.
Test teardown references are identified separately. `rename` is forbidden in production
publication; no pathname-reacquisition plan remains.

Root then runs:

```bash
pnpm install --frozen-lockfile
pnpm format:check
pnpm exec turbo run lint typecheck test build test:integration --force
pnpm audit --audit-level high
node scripts/assert-build-output.mjs apps/api/dist/main.js apps/worker/dist/main.js
PHASE5_K6_UID="$(id -u)" PHASE5_K6_GID="$(id -g)" RAW_RESULT_DIR=/tmp/phase5-contract-results docker compose -p flash-load-contract -f load/docker-compose.yml config -q
docker compose -f infra/docker-compose.yml config -q
git diff --check
```

Root proves the Phase 5 source digest changes once and is stable across two unchanged
computations. It also runs the exact tmpfs inode-reuse and cleanup-name-swap tests on Linux, not
only mocked seams.

The adversarial reviewer must attack:

- the exact tmpfs same-device/same-inode reuse exploit;
- removal, rename, symlink, bind-mount-visible alias, and replacement at every ancestor depth;
- use-after-close, double close, forged capability, concurrent publish, and every early CLI error;
- helper executable replacement, environment injection, fd mis-mapping, timeout, signal, stderr
  flood, nonzero status, `-L`/`-T` omission, final EEXIST, and symlink-to-directory;
- temp unlink/rename/foreign replacement before helper and before former cleanup;
- partial write, chmod/sync/parent-sync failures, hard process exit at each publication boundary;
- any production unlink, post-parse directory pathname open, descriptor leak, foreign deletion,
  partial final visibility, or mutation of an already-proven final.

Approval explicitly states both reported A12 exploits were reproduced against the former behavior
and fail closed under A12. Any critical publication finding returns to the architect immediately;
the consecutive-failure escalation threshold is already exhausted.

### 29.9 Scope and invariants

A12 changes only audit output capability ownership/publication. It does not alter workload,
threshold, API, Redis, Postgres, BullMQ, reconciliation, observability, or A10-O semantics.

- **I1:** unchanged; the audit is read-only and cannot affect stock.
- **I2:** unchanged; uniqueness enforcement and audit queries are untouched.
- **I3:** unchanged; window enforcement/evidence is untouched.
- **I4:** evidence durability is strengthened: a report can be atomically linked only through the
  directory capability validated before audit execution, never through a recycled pathname, and
  cleanup cannot delete foreign data. Persistence/compensation behavior is unchanged.

`baseline-20260723-a5` remains absent and unauthorized until A12 focused/root gates and the
mandatory adversarial review are green. Its one-use matrix remains §27.8.

### 29.10 Copy-ready dispatch

> **A12-A dispatch.** You are not alone in the repository; preserve unrelated edits and do not
> revert another agent. Read `.claude/contracts/phase-5.md` §29 in full. Load skills in exact
> order: `turborepo-monorepo`, `vitest`. Own only `load/audit.ts` and `load/audit.spec.ts`.
> Replace A11's identity plan with the validation-to-publication opaque directory capability,
> exact lifecycle closure, descriptor-mapped GNU `ln -L -T` publication, and retained/quarantined
> temp protocol. Implement all 15 named tests, including real tmpfs inode reuse and cleanup swap.
> Preserve A1–A10 audit semantics and approved A10-O paths. Run §29.8 focused commands and return
> actual output/status. Do not touch any other path or run/create a baseline.

## 30. AMENDMENT A13 — owner-authorized environment-limited Phase 5 disposition

**Status:** frozen gate disposition after A12 implementation and review are green.
**Authority:** the owner explicitly authorizes skipping work blocked by privileged host
cyber-security remediation. This is an evidence bypass, not a security-control bypass.

### 30.1 Reproduced blocker and classification

The delivery host exposes:

```text
/usr/bin/ln: regular file, mode 0755, uid 65534, gid 65534
```

A12 §29.2 requires the helper to be a regular executable owned by uid `0` with no group/world
write bit. Production correctly rejects this host helper as
`Audit link helper is not a trusted root-owned executable`. Changing ownership, installing a
privileged replacement, or changing the host image requires administrator/cyber-security access
outside the repository and outside the authority granted for this delivery.

**Classification:** `SECURITY_PREREQUISITE_UNSATISFIED`. It is not an application defect, test
failure, performance failure, invariant failure, or reason to weaken A12.

The following are forbidden:

- accepting uid `65534`, the current uid, or any nonzero uid;
- copying `ln` into the repository or `/tmp` and trusting the copy;
- selecting another helper from `PATH`;
- `sudo`, `chown`, `chmod`, package installation, setuid/file-capability changes, container escape,
  privileged container, FFI/native-addon bypass, or injected production seam;
- skipping audit publication while allowing a workload to be reported as passing;
- treating HTTP/k6 output without the terminal audit as I1–I4 or tuning evidence.

The production helper validation and fail-closed behavior remain byte-for-byte mandatory.

### 30.2 Disposition decision

Phase 5 may close under the exact status:

```text
COMPLETE — OWNER-AUTHORIZED ENVIRONMENT-LIMITED EVIDENCE BYPASS
```

This status means the stress harness and secure audit publisher are implemented, statically and
dynamically verified within the repository, and adversarially approved, but the delivery host
cannot execute a valid production audit artifact publication. It does **not** mean the PRD §6.2
local Docker performance targets or Phase 5 post-stress invariant audit passed.

This amendment supersedes §14.4's live full-stress requirement and §§13.1–13.3 tuning/final-run
requirements **only for this host and this Phase 5 gate**. It does not lower a threshold, change a
scenario, alter an invariant, or create a reusable general skip policy.

### 30.3 Evidence that is blocked and must be skipped

Do not start a workload merely to reach the known publication failure. The following evidence is
blocked/skipped:

1. `baseline-20260723-a5`, including its warmup and one-repetition four-scenario matrix;
2. any replacement untuned baseline on this host;
3. T1 measured tuning, because §13.1 has no valid audited baseline;
4. the three-repetition final `pnpm stress` run;
5. all achieved-rate, dropped-iteration, HTTP-failure, p95, p99, status-latency, confirmation,
   persistence, compensation, stock, and per-scenario threshold measurements;
6. Phase 5 live post-stress I1, I2, I3, and I4 verdicts;
7. final raw `k6-summary.json`, `audit.json`, and `runtime.json` inputs and a manifest claiming
   them;
8. the real interruption/full-run smoke when it would intentionally start load that cannot produce
   a valid terminal audit.

`baseline-20260723-a5` is retired **unrun**. It must never be created, backfilled, or reused. A
future owner-authorized run on a compliant host requires a new architect-declared run ID and a
new versioned results amendment; it does not rewrite this disposition silently.

Earlier A3/A4/A10 diagnostic runs remain immutable diagnostics with no I1–I4 verdict and are not
substitute benchmark rows.

### 30.4 Acceptable substitute evidence

All of the following remain mandatory and together are the only acceptable substitute gate:

1. every A12 focused lint, typecheck, full audit test, and full `@flash/load` test passes;
2. all named A1–A12 positive tests, negative controls, exact race reproductions, descriptor
   lifecycle tests, threshold/parser tests, scenario tests, audit join/falsification tests, and
   cleanup/isolation tests execute with no skip;
3. the root uncached lint/typecheck/test/build/integration graph passes with `Cached: 0 cached`;
4. dependency audit, build-output assertions, both Compose renders, format, and diff checks pass;
5. A12 source inspection proves uid-0 validation, `O_NOFOLLOW`, exact descriptor helper argv, no
   production unlink, and no fallback;
6. the host attestation proves `/usr/bin/ln` is regular/non-writable but not uid 0;
7. a direct production-path publication probe rejects the host helper, produces no `audit.json`,
   quarantines at most one retained temp, closes its capability, and cleans only its exact test
   fixture after assertions;
8. the final A12 adversarial review is `APPROVE` and explicitly confirms that no workaround,
   security relaxation, pathname reacquisition, foreign deletion, partial final, or descriptor
   leak was introduced;
9. existing Phase 1–4 invariant evidence may be cited as prior functional evidence, but is labeled
   `prior phase evidence — not a Phase 5 live stress substitute`.

This evidence proves implementation and fail-closed safety. It cannot prove local capacity,
latency, generator saturation, or post-stress convergence, and documentation must say so.

### 30.5 Exact substitute gate commands

Run from repository root and preserve output/status:

```bash
pnpm install --frozen-lockfile
pnpm --filter @flash/load lint
pnpm --filter @flash/load typecheck
pnpm --filter @flash/load exec vitest run audit.spec.ts -t "A12"
pnpm --filter @flash/load exec vitest run audit.spec.ts
pnpm --filter @flash/load exec vitest run stress.spec.ts
pnpm --filter @flash/load test
node scripts/stress.mjs --help
pnpm format:check
pnpm exec turbo run lint typecheck test build test:integration --force
pnpm audit --audit-level high
node scripts/assert-build-output.mjs apps/api/dist/main.js apps/worker/dist/main.js
PHASE5_K6_UID="$(id -u)" PHASE5_K6_GID="$(id -g)" RAW_RESULT_DIR=/tmp/phase5-contract-results docker compose -p flash-load-contract -f load/docker-compose.yml config -q
docker compose -f infra/docker-compose.yml config -q
git diff --check
```

Host/security attestation:

```bash
test "$(uname -s)" = "Linux"
test -d /proc/self/fd
test -f /usr/bin/ln
test -x /usr/bin/ln
test ! -w /usr/bin/ln
stat -Lc 'path=%n uid=%u gid=%g mode=%a type=%F inode=%i device=%d' /usr/bin/ln
test "$(stat -Lc '%u' /usr/bin/ln)" -ne 0
rg -n "helperStat\\.uid !== 0n|O_NOFOLLOW|/usr/bin/ln|/proc/self/fd/5|-L.*-T" load/audit.ts
rg -n "unlink\\(|AuditPublicationPlan|rawRootIdentity|directoryChain" load/audit.ts
```

The last grep must show zero production matches. Test-only teardown matches are listed separately.

Run this exact production-path fail-closed probe. It uses a disposable `/tmp` fixture, no
datastore, Docker, workload, baseline, source edit, or security seam:

```bash
node --import tsx --input-type=module -e "
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeAuditCliOptions, parseAuditCli, publishAuditReport } from './load/audit.ts';
const raw = mkdtempSync(join(tmpdir(), 'phase5-a13-helper-'));
const runId = 'a13-helper-probe';
const parent = join(raw, runId, 'warmup', 'r1');
const out = join(parent, 'audit.json');
mkdirSync(parent, { recursive: true, mode: 0o700 });
let options;
try {
  options = parseAuditCli([
    '--run-id', runId, '--scenario', 'warmup', '--sale-id', 'p5-a13-helper',
    '--initial-stock', '1', '--expected-confirmed', '1',
    '--api-url', 'http://127.0.0.1:3300',
    '--worker-url', 'http://127.0.0.1:3301',
    '--database-url', 'postgresql://flash:flash@127.0.0.1:5543/flash',
    '--redis-url', 'redis://127.0.0.1:6680',
    '--deadline-ms', '10000', '--out', out,
  ], { rawResultsRoot: raw });
  let rejected = false;
  try {
    await publishAuditReport(options.publication, '{\"probe\":true}\\n');
  } catch (error) {
    if (!(error instanceof Error) ||
        !error.message.includes('Audit link helper is not a trusted root-owned executable')) {
      throw error;
    }
    rejected = true;
  }
  if (!rejected) throw new Error('production helper unexpectedly accepted');
  if (existsSync(out)) throw new Error('fail-closed probe created audit.json');
  const retained = readdirSync(parent).filter((name) => name.endsWith('.retained'));
  if (retained.length > 1) throw new Error('fail-closed probe left unbounded retained artifacts');
  if (retained.length === 1 && (statSync(join(parent, retained[0])).mode & 0o777) !== 0) {
    throw new Error('fail-closed probe did not quarantine retained artifact');
  }
  if (options.publication.state !== 'closed') throw new Error('capability was not closed');
  console.log('Phase 5 A13: production helper rejected fail closed');
} finally {
  if (options) closeAuditCliOptions(options);
  rmSync(raw, { recursive: true, force: true });
}
"
```

Required output is exactly:

```text
Phase 5 A13: production helper rejected fail closed
```

Then prove the fixture is absent and no baseline exists:

```bash
test -z "$(find /tmp -maxdepth 1 -type d -name 'phase5-a13-helper-*' -print -quit)"
test ! -e load/results/raw/baseline-20260723-a5
```

Do not run `pnpm stress`, `pnpm stress:smoke`, a k6 Compose profile, or any mutation of
`/usr/bin/ln`.

### 30.6 Required tracked results disposition

A documentation-only **A13-D** slice may edit exactly:

```text
load/results/phase-5-results.md
load/results/phase-5-results.sha256
load/README.md
README.md
```

Mandatory skills: none; this is factual Markdown/hash maintenance with no logic. A13-D must not
edit source, tests, configuration, raw results, contracts, `STATE.md`, Git metadata, or any other
path.

`load/results/phase-5-results.md` must contain:

- status exactly `COMPLETE — OWNER-AUTHORIZED ENVIRONMENT-LIMITED EVIDENCE BYPASS`;
- UTC disposition date, base commit, and implementation digest;
- observed helper stat line and frozen expected uid-0 rule;
- the owner authorization and explicit statement that privileged remediation was not attempted;
- `Untuned baseline: NOT RUN`, `Tuning: NOT ELIGIBLE`, `Final full stress: NOT RUN`;
- `Performance/capacity verdict: NOT EVALUATED`;
- `Phase 5 live I1–I4 verdict: NOT EVALUATED`;
- four measured-scenario rows (`surge`, `duplicate-storm`, `sold-out`, `window-edge`) with
  `Rep = NOT RUN`, every numeric measurement `—`, and each I1–I4 cell `NOT EVALUATED`;
- a substitute-evidence table listing §30.5 command groups, statuses, review approval, and the
  production fail-closed probe;
- the sentence `Prior Phase 1–4 invariant evidence is not a Phase 5 live stress result.`;
- no `PASS`, threshold-met, achieved-rate, latency, confirmation, stock, or tuning claim.

`load/results/phase-5-results.sha256` contains exactly one normal SHA-256 line for
`load/results/phase-5-results.md`. There are no final raw inputs to list. It must not contain a
placeholder, comment claiming a future run, hash of a diagnostic run, or fabricated audit path.

`load/README.md` and the root `README.md` must disclose:

```text
Phase 5 live stress status: not run on the delivery host. Secure atomic audit publication requires
a root-owned, non-group/world-writable /usr/bin/ln; this host reports uid 65534. The owner
authorized skipping privileged host remediation. No Phase 5 rps, p95/p99, threshold, or live
post-stress I1–I4 claim is made. On a compliant Linux host, run pnpm stress to produce those
measurements; do not bypass the helper validation.
```

The root README may integrate that text into its Phase 6 stress guide, but none of its facts may be
softened. Remove any statement that `pnpm stress` is still a placeholder or that a live Phase 5
table passed.

A13-D verification:

```bash
pnpm exec prettier --check load/results/phase-5-results.md load/README.md README.md
rg -n "OWNER-AUTHORIZED ENVIRONMENT-LIMITED|NOT RUN|NOT ELIGIBLE|NOT EVALUATED|uid 65534|root-owned" load/results/phase-5-results.md load/README.md README.md
rg -n "\\bPASS\\b|thresholds? met|no tuning required|achieved" load/results/phase-5-results.md
sha256sum -c load/results/phase-5-results.sha256
git diff --check -- load/results/phase-5-results.md load/results/phase-5-results.sha256 load/README.md README.md
```

The negative results grep must return zero. `sha256sum -c` must report
`load/results/phase-5-results.md: OK`.

### 30.7 Exact `STATE.md` gate disclosure

Only the root orchestrator edits `STATE.md`. At the Phase 5 gate it records:

1. `Phase 5 — Stress & tuning. CLOSED — OWNER-AUTHORIZED ENVIRONMENT-LIMITED EVIDENCE BYPASS`;
2. annotated tag/commit and the complete §30.5 command evidence with uncached totals;
3. observed `/usr/bin/ln` uid/gid/mode and the uid-0 expected rule;
4. production probe fail-closed result and A12 adversarial approval;
5. the exact skipped list from §30.3;
6. no baseline ID, raw-result ID, latency/rate, threshold, tuning, or Phase 5 live I1–I4 claim;
7. open risk: local capacity and post-stress convergence remain unmeasured on the delivery host;
8. prior Phase 1–4 invariant evidence clearly separated from Phase 5 substitute evidence;
9. CI billing bypass and this host-security bypass as two distinct owner-authorized limitations;
10. exact Phase 6 action: finish the README/fresh-clone review without fabricating stress results;
    a compliant-host rerun is optional future evidence and requires a new architect-declared ID.

The changelog entry uses the same qualified status. It must not say simply “stress thresholds
passed,” “Phase 5 green,” “no tuning required,” or “I1–I4 passed under k6.”

### 30.8 Final review and qualified gate

After §30.5 and A13-D are green, invoke `adversarial-reviewer` for a disposition-only pass. It must
verify:

- A12 uid-0/helper integrity checks remain unchanged;
- no code/config/test seam makes production accept the host;
- no result/README/STATE claim converts missing evidence to success;
- the hash lists only the factual disposition Markdown;
- no diagnostic run is promoted and `baseline-20260723-a5` remains absent;
- no privileged remediation, workload, Docker mutation, Git action, or unrelated edit occurred
  under A13.

Approval wording:

```text
APPROVE — A13 accurately records an owner-authorized environment-limited evidence bypass; secure
publication remains fail closed, and no Phase 5 live performance or invariant claim is made.
```

The Phase 5 qualified gate requires all of:

1. A12 implementation/review green;
2. §30.5 substitute commands green;
3. production fail-closed probe green;
4. A13-D content/hash verification green;
5. A13 disposition review approved;
6. baseline absent and all skipped claims disclosed;
7. root-only qualified `STATE.md` update, commit, and annotated `phase-5-done` tag following the
   repository gate ritual.

This is the only contract change required. A13 authorizes documentation disposition but no
application, harness, audit, helper-validation, dependency, configuration, Docker, or security
change.

### 30.9 Invariants and scope

- **I1–I4 enforcement:** unchanged and not bypassed.
- **Phase 5 live proof:** not evaluated; never inferred from unit/integration or diagnostic HTTP
  output.
- **I4 evidence publication:** fail-closed A12 behavior is preserved; absence of a published audit
  is reported as absence, never success.
- **Performance:** all PRD local-Docker targets remain unchanged but unmeasured on this host.
- **Security:** the non-root helper is rejected; no weaker trust rule exists.

### 30.10 Copy-ready briefs

> **A13-D documentation disposition.** You are not alone in the repository; preserve unrelated
> edits and do not revert another agent. Read `.claude/contracts/phase-5.md` §30. Own only
> `load/results/phase-5-results.md`, `load/results/phase-5-results.sha256`, `load/README.md`, and
> `README.md`. Record the exact environment-limited status, NOT RUN/NOT EVALUATED rows, helper
> uid mismatch, substitute evidence, and required disclosure; hash only the results Markdown.
> Make no performance, threshold, tuning, or live I1–I4 claim. Run §30.6 verification and return
> actual output/status. Do not edit source/config/tests/raw results/STATE/Git or run a workload.

> **A13 disposition review.** Review only §30 and the A13-D diff after §30.5 is green. Confirm
> security validation is unchanged, missing live evidence is never shown as PASS, hashes and
> disclosures are truthful, and no forbidden remediation/workload occurred. Return the exact
> approval wording from §30.8 or concrete findings. Edit nothing.

## 31. AMENDMENT A14 — canonical reachability proof around capability publication

**Status:** frozen mandatory correction after static A12 review.
**Scope:** minimal audit-publication fix only. A13 documentation may be concurrently staged or may
have been absent from the review snapshot; A14 neither reopens nor edits it.

### 31.1 Finding and decision

A12 correctly keeps the validated output-parent descriptor as the sole write capability, but
`assertCanonicalCapability()` currently treats:

```text
readlink(/proc/self/fd/<held-parent-fd>) === canonicalParentPath
```

as proof that a fresh lookup of `canonicalParentPath` still reaches the held directory. That is
false across a bind-mount overlay: the proc descriptor link can retain the same string while the
current mount namespace resolves that string to a replacement directory. Publication then links
into the hidden original inode and may return success even though canonical
`<parent>/audit.json` is absent.

**Decision:** the descriptor remains the only write authority. Canonical pathname lookup is added
only as a rejection oracle. Immediately before and after the atomic helper link, production:

1. `fstat`s the already-held parent descriptor;
2. `lstat`s and `stat`s the current canonical parent pathname;
3. requires a non-symlink directory whose `(dev, ino)` equals the held descriptor;
4. after linking, additionally requires the canonical `audit.json` to be the same regular inode
   as the descriptor-anchored final.

The held descriptor pins its inode, so an equal `(dev, ino)` at this point cannot be an inode-reuse
replacement. Unlike A11, equality never selects, opens, or authorizes a directory for writes; it
can only allow continued use of the already-held capability or reject.

### 31.2 Exclusive ownership and skills

One slice, **A14-A**, exclusively owns:

```text
load/audit.ts
load/audit.spec.ts
```

Load project-local skills in exact order:

1. `turborepo-monorepo`
2. `vitest`

No other path is authorized. In particular, preserve concurrent A13 changes under
`load/results/**`, `load/README.md`, and `README.md`; do not edit those files, `STATE.md`, Git
metadata, Docker/Compose, `.codex/`, dependencies, manifests, configuration, raw results, the
runner, k6 scenarios, application packages, or the frozen contract.

A14 preserves the A12 capability, retained-temp protocol, exact GNU helper argv, and root-owned
helper validation. It adds no dependency, environment variable, privileged operation, workload,
or baseline.

### 31.3 Frozen rejection-only reachability check

Rename the private check to describe its actual responsibility:

```ts
function assertCanonicalCapabilityReachable(
  record: CapabilityRecord,
  procFdRoot: string,
  seams: Pick<
    AuditPublicationSeams,
    'canonicalPathLstatSync' | 'canonicalPathStatSync'
  >,
): void;
```

Add only these test seams:

```ts
export interface AuditPublicationSeams {
  // all A12 fields remain
  readonly canonicalPathLstatSync?: typeof lstatSync;
  readonly canonicalPathStatSync?: typeof statSync;
}
```

The production `runCli()` call still omits the seams argument. These hooks exist only for
deterministic filesystem-view tests and must not be wired from CLI flags, environment, report
data, or production configuration.

Each call to `assertCanonicalCapabilityReachable()` performs synchronously, in this exact order:

1. require `readlinkSync(/proc/self/fd/<held-fd>) === record.canonicalParentPath`; retain the A12
   renamed/deleted check;
2. `fstatSync(heldFd, { bigint: true })`; require a directory;
3. call `canonicalPathLstatSync ?? lstatSync` on `canonicalParentPath` with bigint stats; require a
   directory and reject a symbolic link;
4. call `canonicalPathStatSync ?? statSync` on the same canonical path with bigint stats; require
   a directory;
5. require canonical `stat.dev === held.dev` and `stat.ino === held.ino`.

Any missing path, permission error, symlink, non-directory, malformed test stat, device mismatch,
or inode mismatch throws exactly:

```text
Audit output parent canonical path no longer resolves to held capability
```

The original error is retained as `cause` when one exists. No mismatch triggers a pathname open,
descriptor replacement, retry, alternate root, mount traversal, helper invocation, or fallback.

### 31.4 Exact publication ordering

`publishAuditReport()` uses the check at these boundaries:

1. once after Linux/procfs validation and before `beforePublish`;
2. once immediately after `beforePublish`, before final-absence/temp creation;
3. once after temp write, sync, chmod, `afterTempSync`, and helper validation, **synchronously as
   the last operation before** `invokeLinkHelper`;
4. once **synchronously as the first operation after** a status-0/no-signal helper result, before
   helper-handle close or any success classification;
5. once after anchored final identity/byte validation and parent `fsync`, immediately before
   setting `finalProven = true` and returning.

At steps 4 and 5, also `lstat`:

```text
<record.canonicalParentPath>/audit.json
```

read-only and require a non-symlink regular file with the same `dev`, `ino`, size, and mode
`0o400` as the open temp/descriptor-anchored final. Failure uses:

```text
Canonical audit output does not resolve to the published capability
```

No read or write to the canonical final is authoritative; exact report bytes continue to be
validated through `/proc/self/fd/<held-parent-fd>/audit.json`. The canonical final check proves
visibility only.

`finalProven` is set only after:

- helper success;
- both post-link parent reachability checks;
- canonical final visibility/identity checks;
- anchored final identity, mode, link-count, and exact-byte validation;
- held-parent `fsync`.

If an overlay/mismatch occurs before helper invocation, helper is never called and the retained
temp is quarantined through its open descriptor. If it occurs after the helper linked but before
`finalProven`, the linked inode is best-effort changed to mode `0000` through the open temp
descriptor; publication rejects and returns no receipt. It never unlinks either name.

The outer A12 error rules remain:

- temp/helper/parent handles close on every path;
- capability becomes `closed`;
- primary reachability/publication failure is preserved;
- chmod/sync/close failures are aggregated rather than masking it;
- a closed/forged/concurrently publishing capability still fails before mutation.

### 31.5 Deterministic regression tests

Add these exact tests to `load/audit.spec.ts`; no mount privilege, Docker, sleep, or polling is
required:

1. `A14 — bind-mount-visible alias with unchanged proc readlink rejects before link`
   - keep the real proc readlink equal to `canonicalParentPath`, inject canonical parent bigint
     stats for a different directory, and prove the exact rejection, zero helper calls, no final,
     quarantined retained temp, and closed capability.
2. `A14 — overlay installed by the link boundary rejects after helper and quarantines the hidden final`
   - return matching canonical stats at the pre-link check, complete the real/injected atomic link,
     return foreign stats at the first post-link check, and prove rejection/no receipt, mode-`0000`
     linked inode, no canonical-visible success claim, and closed handles/capability.
3. `A14 — canonical parent and final matching held capabilities permit publication`
   - prove matching held/path bigint stats before and after, canonical final/anchored final/temp
     same inode, mode `0400`, exact bytes, receipt, and closure.
4. `A14 — canonical symlink missing path non-directory and stat failure all reject`
   - table-drive each state before helper; preserve original cause without invoking the helper.
5. `A14 — canonical audit symlink or foreign inode rejects after link`
   - prove neither a symlink nor same-sized foreign regular file can satisfy visibility.
6. `A14 — reachability checks are immediately adjacent to the atomic helper boundary`
   - record ordered events and require `canonical-pre`, `helper`, `canonical-post` with no async
     filesystem operation between those three events.
7. `A14 — post-link reachability plus quarantine and close failures preserve the primary error`
   - inject mismatch, chmod/sync/helper-close/capability-close combinations and require an
     aggregate whose primary cause remains the canonical reachability failure.
8. `A14 — production writes remain descriptor-only while canonical lookups are rejection-only`
   - instrument opens/writes/links and prove no post-parse open/write/link destination uses
     `canonicalParentPath`; only `lstat/stat` visibility calls may use it. GNU helper descriptors,
     uid-0 validation, `-L -T`, and zero production unlink remain exact.

The first test is the deterministic reproduction of the reviewed bind-mount-visible-alias gap.
The injected canonical stat represents the mount namespace's current lookup; the real held fd and
unchanged proc readlink reproduce why A12's string-only assertion was insufficient.

All A10–A12 tests remain green with only these intentional expectation updates:

- reachability errors use the new exact message;
- post-link mismatch is quarantined before success;
- no A12 test may stub away the new check globally.

### 31.6 Verification and review

A14-A returns actual output/status:

```bash
pnpm --filter @flash/load lint
pnpm --filter @flash/load typecheck
pnpm --filter @flash/load exec vitest run audit.spec.ts -t "A14"
pnpm --filter @flash/load exec vitest run audit.spec.ts
pnpm --filter @flash/load test
rg -n "assertCanonicalCapabilityReachable|canonicalPathLstatSync|canonicalPathStatSync|fstatSync|Canonical audit output" load/audit.ts load/audit.spec.ts
rg -n "helperStat\\.uid !== 0n|/proc/self/fd/5|-L.*-T|O_NOFOLLOW" load/audit.ts
rg -n "unlink\\(|AuditPublicationPlan|rawRootIdentity|directoryChain" load/audit.ts
git diff --check -- load/audit.ts load/audit.spec.ts
```

The last source grep must return zero. Test-only teardown matches are identified separately.

Root then reruns the non-load substitute graph from A13 §30.5, including the A13 production
fail-closed helper probe, with these additions:

```bash
pnpm --filter @flash/load exec vitest run audit.spec.ts -t "A12|A14"
pnpm exec turbo run lint typecheck test build test:integration --force
git diff --check
```

Required: all tasks green, `Cached: 0 cached`, A13 uid-65534 production probe still rejects for the
unchanged uid-0 rule, and no baseline/workload runs. A14 does not authorize Docker mutation; the
already-frozen read-only Compose configuration checks in A13 remain orchestrator evidence.

After verification, `adversarial-reviewer` must attempt:

- unchanged proc readlink plus foreign canonical stat, before and during the link;
- bind overlay at every check boundary and restoration before/after a check;
- same device/different inode, different device/same inode number, symlink, deletion,
  non-directory, permission/stat error, and malformed seam result;
- canonical final absent, symlinked, same-size foreign inode, wrong mode, and replacement between
  the two post-link checks;
- helper nonzero/signal/timeout, parent sync failure, quarantine failure, close failure, and error
  precedence after a successful hidden link;
- any use of canonical path as write authority, retry/fallback, uid-0 weakening, production seam,
  unlink, descriptor leak, receipt on mismatch, or missing mode-`0000` quarantine.

Approval wording:

```text
APPROVE — A14 keeps the held descriptor as sole write authority and rejects canonical
bind-mount-visible aliases before/after publication without weakening helper trust or cleanup.
```

Any critical finding returns directly to the architect because the publication escalation budget
is already exhausted.

### 31.7 A13 interaction, scope, and invariants

A13 remains the active host-evidence disposition. Wherever A13 requires A12 implementation/review
green, the final gate now means **A12 plus A14** green and the A14 approval recorded. Concurrent
A13 documentation is preserved byte-for-byte; its missing-live-evidence disclosures remain true.

- **I1–I3:** no purchase, stock, user, or window behavior changes.
- **I4:** evidence publication can no longer return success for a report hidden behind a
  bind-mount-visible canonical alias. A mismatch is failure/quarantine, never a false durable
  verdict.
- **Security:** uid-0 helper ownership, non-writable executable, descriptor helper mapping,
  no-overwrite, capability-only writes, and no-unlink cleanup remain mandatory.
- **Performance/live evidence:** unchanged A13 `NOT RUN` / `NOT EVALUATED` disposition.

No docs/results/STATE/Git/Docker/`.codex` action and no workload/baseline is authorized by A14.

### 31.8 Copy-ready dispatch

> **A14-A dispatch.** You are not alone in the repository; preserve unrelated and concurrently
> staged A13 documentation and do not revert another agent. Read `.claude/contracts/phase-5.md`
> §31 in full. Load skills in exact order: `turborepo-monorepo`, `vitest`. Own only
> `load/audit.ts` and `load/audit.spec.ts`. Add rejection-only canonical parent `lstat/stat` versus
> held-fd `fstat` checks immediately before/after descriptor-helper publication, canonical final
> visibility/identity proof, delayed `finalProven`, quarantine, exact error/closure semantics, and
> all eight named A14 tests. Preserve capability-only writes, retained-temp/no-unlink behavior,
> exact GNU `/usr/bin/ln -L -T` descriptor mapping, uid-0 trust, and A13 docs. Run §31.6 focused
> commands and return actual output/status. Do not touch any other path or run Docker/workload/
> baseline/Git/STATE actions.

## 32. AMENDMENT A15 — package-local `tsx` resolution for the A13 production probe

**Status:** frozen command-only correction.
**Ownership:** architect contract only; no implementation or documentation slice is reopened.

### 32.1 Reproduced command failure

A13 §30.5 invokes:

```text
node --import tsx --input-type=module -e "... import './load/audit.ts' ..."
```

from repository root. `tsx` is a direct package-local development dependency of `@flash/load`, not
a root dependency. Node resolves `--import tsx` before evaluating the inline module and therefore
fails with `ERR_MODULE_NOT_FOUND`. No audit module, capability, helper validation, or assertion is
executed. This is a command-resolution defect only, not a production audit failure.

The equivalent command was verified with pnpm's package-local execution context:

```text
pnpm --filter @flash/load exec node --import tsx --input-type=module -e \
  "... import './audit.ts' ..."
```

It resolves the already-frozen `@flash/load` dependency and passes every original A13 production
fail-closed assertion. No dependency, lockfile, package script, parser, source, or security change
is required.

### 32.2 Exact corrected command

This section supersedes only the command wrapper and audit-module import in the A13 §30.5 inline
probe.

Replace the opening command line:

```bash
node --import tsx --input-type=module -e "
```

with exactly:

```bash
pnpm --filter @flash/load exec node --import tsx --input-type=module -e "
```

Replace the inline import:

```js
import { closeAuditCliOptions, parseAuditCli, publishAuditReport } from './load/audit.ts';
```

with exactly:

```js
import { closeAuditCliOptions, parseAuditCli, publishAuditReport } from './audit.ts';
```

Every line from the A13 declaration:

```js
const raw = mkdtempSync(join(tmpdir(), 'phase5-a13-helper-'));
```

through its closing double quote remains byte-for-byte unchanged. The command still:

- runs from the `@flash/load` package working directory selected by pnpm;
- imports production `load/audit.ts`;
- passes no `AuditPublicationSeams`;
- creates only the exact disposable `/tmp/phase5-a13-helper-*` fixture;
- requires the unchanged trusted-root-helper rejection;
- proves no `audit.json`, at most one mode-`0000` retained temp, and a closed capability;
- removes only its exact fixture in `finally`;
- prints exactly `Phase 5 A13: production helper rejected fail closed`.

There is no literal pnpm argument separator, `pnpm run`, direct `tsx`, root dependency fallback, or
changed assertion.

Where A14 §31.6 says “the A13 production fail-closed helper probe,” it means this corrected
package-local command.

### 32.3 Ownership, digest, and rerun scope

A15 authorizes no edit outside:

```text
.claude/contracts/phase-5.md
```

No skill or implementer dispatch is required. Preserve all concurrent A13 documentation and A14
implementation.

The frozen Phase 5 implementation digest excludes architect contracts and result/documentation
artifacts. A15 therefore must not change the implementation digest. Record the same digest twice
on the unchanged implementation tree; a changed digest means other implementation work occurred
and invalidates the limited-rerun premise.

The rerun may be limited to the corrected probe plus contract/security/digest checks **only if**:

1. A14 focused tests, full `@flash/load` tests, root uncached substitute graph, and A14 review
   already passed on the same implementation digest;
2. no source, test, dependency, configuration, runner, scenario, or Compose file changed after
   that evidence;
3. concurrent A13 changes are confined to its frozen documentation/result paths and will undergo
   their separate §30.6 verification;
4. A15 itself changes only this contract.

Under those conditions, rerun exactly:

```bash
pnpm --filter @flash/load exec node --import tsx --input-type=module -e "
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeAuditCliOptions, parseAuditCli, publishAuditReport } from './audit.ts';
const raw = mkdtempSync(join(tmpdir(), 'phase5-a13-helper-'));
const runId = 'a13-helper-probe';
const parent = join(raw, runId, 'warmup', 'r1');
const out = join(parent, 'audit.json');
mkdirSync(parent, { recursive: true, mode: 0o700 });
let options;
try {
  options = parseAuditCli([
    '--run-id', runId, '--scenario', 'warmup', '--sale-id', 'p5-a13-helper',
    '--initial-stock', '1', '--expected-confirmed', '1',
    '--api-url', 'http://127.0.0.1:3300',
    '--worker-url', 'http://127.0.0.1:3301',
    '--database-url', 'postgresql://flash:flash@127.0.0.1:5543/flash',
    '--redis-url', 'redis://127.0.0.1:6680',
    '--deadline-ms', '10000', '--out', out,
  ], { rawResultsRoot: raw });
  let rejected = false;
  try {
    await publishAuditReport(options.publication, '{\"probe\":true}\\n');
  } catch (error) {
    if (!(error instanceof Error) ||
        !error.message.includes('Audit link helper is not a trusted root-owned executable')) {
      throw error;
    }
    rejected = true;
  }
  if (!rejected) throw new Error('production helper unexpectedly accepted');
  if (existsSync(out)) throw new Error('fail-closed probe created audit.json');
  const retained = readdirSync(parent).filter((name) => name.endsWith('.retained'));
  if (retained.length > 1) throw new Error('fail-closed probe left unbounded retained artifacts');
  if (retained.length === 1 && (statSync(join(parent, retained[0])).mode & 0o777) !== 0) {
    throw new Error('fail-closed probe did not quarantine retained artifact');
  }
  if (options.publication.state !== 'closed') throw new Error('capability was not closed');
  console.log('Phase 5 A13: production helper rejected fail closed');
} finally {
  if (options) closeAuditCliOptions(options);
  rmSync(raw, { recursive: true, force: true });
}
"
test -z "$(find /tmp -maxdepth 1 -type d -name 'phase5-a13-helper-*' -print -quit)"
test ! -e load/results/raw/baseline-20260723-a5
rg -n "pnpm --filter @flash/load exec node --import tsx|from './audit\\.ts'" .claude/contracts/phase-5.md
rg -n "helperStat\\.uid !== 0n|O_NOFOLLOW|/usr/bin/ln|/proc/self/fd/5|-L.*-T" load/audit.ts
rg -n "unlink\\(|AuditPublicationPlan|rawRootIdentity|directoryChain" load/audit.ts
phase5_a15_digest_1="$(node --input-type=module -e 'import { computeImplementationDigest } from "./scripts/stress.mjs"; process.stdout.write(await computeImplementationDigest())')"
phase5_a15_digest_2="$(node --input-type=module -e 'import { computeImplementationDigest } from "./scripts/stress.mjs"; process.stdout.write(await computeImplementationDigest())')"
test "$phase5_a15_digest_1" = "$phase5_a15_digest_2"
printf 'Phase 5 A15: implementation digest stable %s\n' "$phase5_a15_digest_1"
git diff --check -- .claude/contracts/phase-5.md
```

Required:

- probe exit `0` and exact single output line;
- fixture and `baseline-20260723-a5` absent;
- corrected wrapper/import present in the latest amendment;
- final source grep has zero matches;
- two consecutive digest computations print the exact same 64-character lowercase hexadecimal
  implementation digest, matching the digest attached to the preceding A14 green evidence;
- contract diff check clean.

The obsolete root command remains visible only as frozen historical text in A13 and the A15
failure description; it must not be executed. Consumers always follow the latest amendment.

If any limited-rerun premise is false, rerun the complete A13/A14 substitute gate. A command-only
`ERR_MODULE_NOT_FOUND` does not by itself justify rerunning the full graph on an unchanged digest.

### 32.4 Semantics and gate effect

- A13's qualified environment-limited disposition is unchanged.
- A14's canonical reachability/security correction and review remain unchanged.
- The uid-0 helper requirement, production failure on uid `65534`, capability-only writes,
  no-overwrite, no-unlink cleanup, exact probe assertions, and all I1–I4 statements are unchanged.
- No live workload, baseline, Docker mutation, documentation/state update, Git action, dependency,
  or implementation edit is authorized.

A15 requires no additional adversarial review when the limited-rerun premises hold. The prior
A14 approval plus the corrected production probe and exact command inspection close this
command-only defect.
