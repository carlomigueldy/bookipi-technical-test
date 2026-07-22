# Phase 1 — FROZEN CONTRACT (Domain Core)

**Authority:** ARCHITECT (Opus) · **Date:** 2026-07-22 · **Status:** FROZEN
**Above this doc:** `PRD.md`. Where this doc pins a detail the PRD left open, or deliberately
refines the PRD, **this doc wins** — every such refinement is called out explicitly in §0.3.
**Also binding:** `.claude/contracts/phase-0.md` (still frozen; this doc only makes the
*additive* amendments listed in §0.2).
**Consumers:** SLICE 1, 2, 3 implementation agents — who never talk to each other.

> **Every name, number, path, and line of Lua in this document is FINAL.** If an implementer
> finds something unspecified, they MUST stop and escalate to the orchestrator → architect.
> They must NEVER invent a name another slice could also need.

> **Process rule inherited from Phase 0 (non-negotiable).** Verification is command-evidence
> based, never self-attestation. **Never fix a finding by weakening, skipping, or deleting the
> check that caught it.** In this phase that has a specific, named form: *a Redis-dependent
> spec must never `describe.skip` / `it.skip` / early-return when Redis is unavailable.* It must
> fail. A skipped atomicity spec is indistinguishable from a deleted one.

---

## 0. Scope boundary (READ FIRST)

### 0.1 In / out

Phase 1 gate evidence (PRD §8): **"Unit suite green incl. Lua atomicity specs."**

**IN SCOPE:**
- `packages/shared`: sale state machine, Redis key builders, result/error taxonomy, DTO +
  validation schemas, constants.
- **New package `packages/redis` (`@flash/redis`)**: ioredis client factory, the four Lua
  scripts, the `SaleRedisStore` wrapper, EVALSHA→EVAL loading strategy.
- Unit tests for all of the above, **including atomicity specs executed against a real Redis 7.4**.
- The minimal wiring those require: `turbo.json` passthrough env, root `tsconfig.json`
  reference, `.env.example` row, CI `unit` job Redis service.

**OUT OF SCOPE — an agent that builds these has failed its slice:**

| Thing | Owning phase |
|---|---|
| NestJS modules/controllers/providers, DI wiring, `ZodValidationPipe`, rate limiting, HTTP status mapping *at the HTTP layer*, CORS, helmet, pino | 2 |
| Anything under `apps/api/**` or `apps/worker/**` or `apps/web/**` | 2 / 3 / 4 |
| BullMQ queue/worker/DLQ handler, `pg` driver, order persistence, boot reconciliation | 3 |
| Testcontainers **Postgres**, `*.integration.spec.ts`, `test/integration/**` | 2+ |
| k6, `load/audit.ts` | 5 |

Phase 1 writes **zero** application code. It produces two libraries and their tests.

### 0.2 Additive amendments to the Phase 0 frozen contract

These are the *only* changes to Phase 0's frozen decisions. Everything else stands.

| Phase-0 § | Amendment | Why |
|---|---|---|
| §1 package table | **ADD row:** `packages/redis` → `@flash/redis`, private, `0.0.0` | §1 of this doc |
| §3 directory tree | **ADD** the files in §2 of this doc | Phase 1 tree |
| §16 config hash fields | **ADD** `startsAtMs`, `endsAtMs` (epoch-millis integers, as decimal strings). `startsAt`/`endsAt` remain ISO-8601 UTC strings exactly as frozen. | Lua cannot parse ISO-8601 safely; §4.4 |
| §16 metrics hash fields | **ADD** field `not_initialized` to the frozen five | new outcome, §7 |
| §17 CI `unit` job | **ADD** a `redis:7.4-alpine` service container + `REDIS_TEST_URL` job env | §6.2 |
| §11 env table | **ADD** `REDIS_TEST_URL` (test-only, no production reader) | §6.2 |

Nothing in Phase 0 is deleted, renamed, or relaxed.

### 0.3 Deliberate refinements of the PRD

Called out so no reviewer mistakes them for drift.

| PRD | Refinement | Rationale |
|---|---|---|
| §3.2 Lua sketch (`KEYS[1]=stock, KEYS[2]=buyers`, returns 3 codes) | Rewritten: 3 KEYS (config, stock, buyers), window enforcement moved **into** the script, 6 return codes, structured return | §4.2, §4.3 |
| §4 `403 SALE_NOT_ACTIVE` | Split into `SALE_NOT_STARTED` and `SALE_ENDED`, **both → 403** | The SPA must render "starts in 4:12" vs "ended" without guessing; the HTTP contract is unchanged |
| §6.1 "Lua script logic (via ioredis-mock or embedded Redis)" | **ioredis-mock is banned.** All Lua specs run against real Redis 7.4 | §6.1 — a mock cannot prove atomicity; full defense there |
| §7 layout (`packages/shared`, `packages/tooling` only) | Adds `packages/redis` | §1 — full defense there |

---

## 1. Where the Redis service and Lua live — DECIDED

**Decision: a new workspace package `packages/redis`, published as `@flash/redis`.**
`packages/shared` stays a **zero-runtime-dependency-on-Redis** package.

Dependency direction (acyclic, enforced by review):

```
@flash/shared   (pure: types, constants, key builders, state machine, taxonomy, zod DTOs)
      ▲                        ▲                    ▲
      │                        │                    │
@flash/redis            apps/api (P2)         apps/web (P4, TYPES ONLY)
(ioredis + Lua)                ▲
      ▲────────────────────────┘
      └──────────── apps/worker (P3, DLQ compensation)
```

### Why not `packages/shared`

`apps/web` depends on `@flash/shared` and imports **values** from it today
(`SERVICE_NAMES` in `apps/web/src/App.tsx`). `@flash/shared` is CJS, consumed through Vite's
CommonJS interop with the fragile re-export shape already documented in
`packages/shared/src/index.ts`. Putting `ioredis` behind that barrel means a browser bundle
graph that must resolve `require('ioredis')` — `net`, `tls`, `dns`. Best case Vite externalises
it and the bundle grows; worst case the build breaks in Phase 4, far from the cause.

Second, and more important for this phase: **test-surface isolation.** The Lua specs need a live
Redis. If they live in `packages/shared`, `@flash/shared:test` — a task every developer and every
CI job runs — becomes Docker-dependent. With a separate package, exactly one turbo task
(`@flash/redis:test`) requires a container, failures attribute cleanly, and `@flash/shared`
remains provably pure (its `dependencies` are `zod` and nothing else).

### Why not `apps/api/src`

`apps/worker` needs the **identical** compensation script in Phase 3 (`INCR` stock + `SREM`
buyer). Two copies of a script that upholds I1 is a guaranteed divergence. Placing it in the API
would force the worker to either import across app boundaries (illegal) or reimplement it —
the exact "Phase 3 improvises it" failure this contract exists to prevent.

### Rejected alternative: subpath export `@flash/shared/redis`

Genuinely viable and keeps PRD §7's layout literal. Rejected because it does **not** solve the
test-surface problem (one `package.json`, one `vitest` run, one turbo task), and because a
single package whose dependency set is `{zod, ioredis}` cannot honestly be described as
"shared contracts". The cost of the rejection is one extra directory and one extra row in the
package table; the README documents this as a deliberate deviation from PRD §7.

---

## 2. File-level slice ownership — FROZEN

Exclusive ownership is at **file** granularity. A slice must not create, edit, or delete a path
owned by another slice. If slice X needs a change inside slice Y's path it escalates to the
orchestrator → architect; **never** agent-to-agent.

`~` = pre-existing Phase-0 file this slice extends. `+` = new file.

### SLICE 1 — Pure domain core (`implementer`, Sonnet)

```
packages/shared/src/constants.ts          ~   extend only; never remove a Phase-0 export
packages/shared/src/keys.ts               +
packages/shared/src/keys.spec.ts          +
packages/shared/src/sale-state.ts         +
packages/shared/src/sale-state.spec.ts    +
packages/shared/src/results.ts            +
packages/shared/src/results.spec.ts       +
packages/shared/src/index.ts              ~   barrel for the "." entry — S1 ONLY
packages/shared/src/index.spec.ts         ~
```

### SLICE 2 — DTOs & validation (`implementer`, Sonnet)

```
packages/shared/src/dto/user-id.ts             +
packages/shared/src/dto/user-id.spec.ts        +
packages/shared/src/dto/purchase.ts            +
packages/shared/src/dto/purchase.spec.ts       +
packages/shared/src/dto/sale-status.ts         +
packages/shared/src/dto/sale-status.spec.ts    +
packages/shared/src/dto/purchase-status.ts     +
packages/shared/src/dto/purchase-status.spec.ts+
packages/shared/src/schemas.ts                 +   barrel for the "./schemas" entry — S2 ONLY
packages/shared/package.json                   ~   S2 ONLY (zod dep + exports map + build script)
packages/shared/tsconfig.json                  ~   S2 ONLY
packages/shared/tsconfig.build.json            +   S2 ONLY
packages/shared/vitest.config.ts               +   S2 ONLY
```

### SLICE 3 — Redis service, Lua, wiring (`implementer`, Sonnet)

```
packages/redis/package.json               +
packages/redis/tsconfig.json              +
packages/redis/tsconfig.build.json        +
packages/redis/eslint.config.mjs          +
packages/redis/vitest.config.ts           +
packages/redis/src/index.ts               +
packages/redis/src/types.ts               +
packages/redis/src/client.ts              +
packages/redis/src/sale-store.ts          +
packages/redis/src/scripts/purchase.lua.ts    +
packages/redis/src/scripts/compensate.lua.ts  +
packages/redis/src/scripts/seed.lua.ts        +
packages/redis/src/scripts/status.lua.ts      +
packages/redis/src/scripts/registry.ts        +
packages/redis/src/scripts/run.ts             +
packages/redis/src/scripts/registry.spec.ts   +
packages/redis/src/scripts/run.spec.ts        +
packages/redis/src/sale-store.seed.spec.ts        +
packages/redis/src/sale-store.purchase.spec.ts    +
packages/redis/src/sale-store.window.spec.ts      +
packages/redis/src/sale-store.compensate.spec.ts  +
packages/redis/src/sale-store.concurrency.spec.ts +
packages/redis/test/global-setup.ts       +
packages/redis/test/harness.ts            +
packages/redis/test/vitest.d.ts           +
turbo.json                                ~   S3 ONLY (one line, §6.2)
tsconfig.json                             ~   S3 ONLY (one reference)
.env.example                              ~   S3 ONLY (one row)
.github/workflows/ci.yml                  ~   S3 ONLY (unit job service container)
```

> `.github/**` was SLICE D's in Phase 0. For Phase 1 it is SLICE 3's. Phase-0 slices no longer exist.

### Concurrency & merge order

| | authored | verified | merged |
|---|---|---|---|
| S1 | parallel | standalone (`@flash/shared` compiles with only S1 files + Phase 0) | **1st** |
| S2 | parallel | after S1 merges (imports `../results`, `../sale-state`, `../constants`) | **2nd** |
| S3 | parallel | after S2 merges (imports `@flash/shared` `.` entry) | **3rd** |

All three author simultaneously against this contract. Only *verification* is ordered. No two
agents ever hold the same file. S2's and S3's cross-slice needs are **imports of names frozen in
this document** (§3, §5, §7) — never edits.

**No slice touches:** `packages/shared/src/health.ts`, `apps/**`, `infra/**`, `prototype/**`,
`STATE.md`, `AGENTS.md`, `.claude/contracts/**`, `scripts/assert-build-output.mjs`.

---

## 3. Sale state machine — FROZEN (SLICE 1)

### 3.1 Derived, not stored — DECIDED

Sale state is a **pure function** of `(nowMs, startsAtMs, endsAtMs, stockRemaining)`. It is
**never** written to Redis, Postgres, or memory. There is no `state` field anywhere.

**Rejected alternative: a stored `state` field on `sale:{id}:config`, advanced by a scheduler.**
Rejected because the two transitions that matter (`upcoming→active`, `*→ended`) are
**time**-triggered, not event-triggered. A stored field needs a writer; a writer needs a leader
(N API pods); a late tick makes `/sale/status` lie about a sale that is actually open. And the
purchase path would then have to either trust the stale field — which breaks I3 — or re-derive
anyway, making the field dead weight that can only ever disagree with reality. Derivation is
O(1), has no failure mode, and is exhaustively testable at exact-millisecond boundaries.

**Scope of authority — critical:** `deriveSaleState` is **presentational and advisory only**.
It powers `/sale/status` and the API's cheap fast-path guard. **It is NOT the enforcement point
for I3.** I3 is enforced inside `purchase.lua` (§4.3). Any implementer or reviewer who treats
`deriveSaleState` as the window gate has misread this contract.

### 3.2 Exact signature and semantics

```ts
// packages/shared/src/sale-state.ts
export const SALE_STATES = ['upcoming', 'active', 'sold_out', 'ended'] as const;
export type SaleState = (typeof SALE_STATES)[number];

export interface SaleStateInput {
  /** Server clock, epoch millis. NEVER the client clock. */
  nowMs: number;
  /** Inclusive window start, epoch millis. */
  startsAtMs: number;
  /** Exclusive window end, epoch millis. */
  endsAtMs: number;
  /** Units left. Negative values are treated as 0. */
  stockRemaining: number;
}

export function deriveSaleState(input: SaleStateInput): SaleState;

/** True iff a purchase attempt is permitted by the window alone (ignores stock). */
export function isWithinSaleWindow(nowMs: number, startsAtMs: number, endsAtMs: number): boolean;

/** Millis until the next state transition, or null if none is pending (already 'ended'). */
export function msUntilNextTransition(input: SaleStateInput): number | null;
```

**Total, ordered precedence — implement exactly this, in this order:**

```
1. nowMs <  startsAtMs           -> 'upcoming'
2. nowMs >= endsAtMs             -> 'ended'
3. stockRemaining <= 0           -> 'sold_out'
4. otherwise                     -> 'active'
```

- `ended` beats `sold_out` (PRD §3.4: `sold_out --> ended : now ≥ endsAt`).
- `upcoming` beats `sold_out` (PRD §3.4 has **no** `upcoming --> sold_out` edge; a sale seeded
  with 0 stock reads `upcoming` until `startsAt`).
- `isWithinSaleWindow` is exactly `nowMs >= startsAtMs && nowMs < endsAtMs`.
- `msUntilNextTransition`: `upcoming` → `startsAtMs - nowMs`; `active`/`sold_out` →
  `endsAtMs - nowMs`; `ended` → `null`.
- Inputs are validated: if any of `nowMs`/`startsAtMs`/`endsAtMs` is not a finite number, or
  `endsAtMs <= startsAtMs`, **throw** `new RangeError(...)`. Do not return a default.

### 3.3 Half-open window `[startsAt, endsAt)` — exact boundary table

This table is normative. Phase 2's integration tests assert it verbatim; SLICE 1's unit spec
asserts it verbatim. `S` = `startsAtMs`, `E` = `endsAtMs`, stock = 5 unless stated.

| `nowMs` | `deriveSaleState` | `isWithinSaleWindow` | `purchase.lua` outcome |
|---|---|---|---|
| `S - 1` | `upcoming` | `false` | `SALE_NOT_STARTED` |
| `S` (exact) | `active` | **`true`** | `CONFIRMED` |
| `S + 1` | `active` | `true` | `CONFIRMED` |
| `E - 1` | `active` | **`true`** | `CONFIRMED` |
| `E` (exact) | `ended` | **`false`** | `SALE_ENDED` |
| `E + 1` | `ended` | `false` | `SALE_ENDED` |
| `S` (exact), stock 0 | `upcoming` | `true` | `SOLD_OUT` |
| `E - 1`, stock 0 | `sold_out` | `true` | `SOLD_OUT` |
| `E`, stock 0 | `ended` | `false` | `SALE_ENDED` |

The last three rows are the ones that catch a naive implementation: at `S` with zero stock the
*state* is `upcoming` (rule 1 fires first) but the *purchase* is `SOLD_OUT` (the window is open,
so `purchase.lua` reaches the stock check). These are two different questions and must not be
collapsed.

---

## 4. Redis, Lua, and the atomic decision — FROZEN (SLICE 3)

### 4.1 Key scheme (Phase 0 §16, reconfirmed) and hash-tag correctness

`{` `}` are **literal characters in the key**. They are Redis Cluster hash tags: every key of one
sale hashes to the same slot, which is what makes a multi-key script legal under cluster mode.
On a single node they cost nothing and document the intent. **Do not strip them.**

```ts
// packages/shared/src/keys.ts  (SLICE 1)
export const SALE_ID_PATTERN: RegExp;   // /^[a-z0-9][a-z0-9._-]{0,63}$/

/** Throws TypeError if saleId would corrupt the key space or the hash tag. */
export function assertSaleId(saleId: string): void;

export function saleHashTag(saleId: string): string;   // `{${saleId}}`
export function saleConfigKey(saleId: string): string;  // `sale:{<id>}:config`
export function saleStockKey(saleId: string): string;   // `sale:{<id>}:stock`
export function saleBuyersKey(saleId: string): string;  // `sale:{<id>}:buyers`
export function saleMetricsKey(saleId: string): string; // `sale:{<id>}:metrics`

export interface SaleKeys { config: string; stock: string; buyers: string; metrics: string; }
export function saleKeys(saleId: string): SaleKeys;
```

Every builder calls `assertSaleId` first. `SALE_ID_PATTERN` forbids `{`, `}`, `:`, whitespace and
uppercase — a saleId containing a brace would silently split the hash tag and scatter a sale's
keys across slots, which would make `purchase.lua` a CROSSSLOT error at best and a
non-atomic decision at worst. This is a correctness guard, not hygiene.

**Hash-tag confirmation for every script (required by the brief):**

| Script | KEYS | hash tag of each | shares a slot |
|---|---|---|---|
| `purchase` | config, stock, buyers | `{saleId}` | ✅ |
| `compensate` | config, stock, buyers | `{saleId}` | ✅ |
| `seed` | config, stock | `{saleId}` | ✅ |
| `status` | config, stock | `{saleId}` | ✅ |

`metrics` is never touched by a script (plain `HINCRBY`), but carries the same tag so a future
script may include it.

**`userId` is never interpolated into a key or into script source.** It travels only as `ARGV`,
which is binary-safe. There is no injection surface — this is a direct consequence of using
`EVALSHA` with parameters instead of building command strings, and it is worth stating in the
README.

### 4.2 Window enforcement: INSIDE the Lua script — DECIDED

**Decision: `purchase.lua` reads the window from `sale:{id}:config` and the current time from
`redis.call('TIME')`, and rejects out-of-window attempts itself. The API keeps a cheap
`deriveSaleState` fast-path guard, but that guard is an optimisation, not the enforcement point.**

**Defence:**

1. **TOCTOU is fatal to an API-only guard.** A guard that passes at `E - 1ms` and an `EVALSHA`
   that lands at `E + 4ms` has committed a purchase outside the window. At the PRD's target of
   2,000 req/s, milliseconds of guard→Redis latency are milliseconds of guaranteed violations,
   and PRD §6.2 explicitly load-tests exactly this (`window-edge.js`, load starting 5s before
   `startsAt`). With the check inside the script, window + duplicate + stock + decrement +
   record are **one indivisible unit** on single-threaded Redis: I3 acquires the same strength
   as I1 and I2 because it shares their serialization point.
2. **One clock beats N clocks.** With an API-side check, pod A at +200ms of NTP skew accepts a
   request pod B rejects. I3 becomes probabilistic and unauditable. Redis is already the
   authority for stock and buyers; making it the authority for time removes the last
   distributed variable from the decision.
3. **The stated objection no longer applies.** "Redis `TIME` is non-deterministic and has
   replication implications" was true under **verbatim** script replication (Redis ≤ 4), where a
   replica re-executed the script and could compute a different `now`, diverging from the master.
   From Redis 5 onward scripts replicate **by effects**: only the resulting `DECR`/`SADD` commands
   propagate, so a replica never evaluates `TIME`. Effects replication is the only mode in Redis
   7, and Phase 0 §12 pins `redis:7.4-alpine`. The same argument covers AOF: effects are what get
   appended, so replay is deterministic. This decision is therefore *safe on our pinned version
   and unsafe on Redis ≤ 4* — record that caveat in the README.
4. **Self-sufficiency.** A script that carries its own clock inherits I3 to every future caller
   for free. Nothing downstream can accidentally opt out.

**Rejected alternative A — API guard only.** Rejected on (1) and (2).

**Rejected alternative B — API passes `nowMs` as `ARGV`.** Deterministic, no `TIME` call, and
keeps the script replica-safe on any Redis version. Rejected because it reintroduces (2)
verbatim — the value is still N unsynchronised pod clocks — and it makes a hard invariant depend
on caller honesty rather than on the datastore. The determinism it buys is worthless to us: we
never replicate verbatim.

**Consequence, and it must be honoured:** the API's fast-path guard MUST map to the *same*
outcome codes the script would produce (`SALE_NOT_STARTED` / `SALE_ENDED`), so a request's
response does not depend on which of the two rejected it. The guard may **reject** early. The
guard must **never** be treated as authorisation: a guard-pass always proceeds to the script.

### 4.3 `purchase.lua` — verbatim

```lua
-- purchase.lua — the serialization point for I1, I2 and I3.
-- KEYS[1] = sale:{<saleId>}:config   (hash)
-- KEYS[2] = sale:{<saleId>}:stock    (string, integer)
-- KEYS[3] = sale:{<saleId>}:buyers   (set)
-- ARGV[1] = userId (binary-safe; never interpolated into the source)
-- RETURN  = { code:string, stockRemaining:integer, nowMs:integer }
local cfg        = redis.call('HMGET', KEYS[1], 'startsAtMs', 'endsAtMs')
local startsAtMs = tonumber(cfg[1])
local endsAtMs   = tonumber(cfg[2])
local t          = redis.call('TIME')
local nowMs      = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

if startsAtMs == nil or endsAtMs == nil then
  return { 'NOT_INITIALIZED', -1, nowMs }
end

local stock = tonumber(redis.call('GET', KEYS[2]) or '0')
if stock < 0 then stock = 0 end

if nowMs < startsAtMs then
  return { 'SALE_NOT_STARTED', stock, nowMs }
end
if nowMs >= endsAtMs then
  return { 'SALE_ENDED', stock, nowMs }
end
if redis.call('SISMEMBER', KEYS[3], ARGV[1]) == 1 then
  return { 'ALREADY_PURCHASED', stock, nowMs }
end
if stock <= 0 then
  return { 'SOLD_OUT', 0, nowMs }
end

local remaining = redis.call('DECR', KEYS[2])
redis.call('SADD', KEYS[3], ARGV[1])
return { 'CONFIRMED', remaining, nowMs }
```

**Every ordering choice below is deliberate. Do not reorder.**

- **`NOT_INITIALIZED` before everything.** If the config hash is gone (someone flushed Redis, a
  pod started before seeding), `GET stock` returns nil → 0 → the naive script answers
  `SOLD_OUT`. That reports a *correct-looking business outcome for an outage* and hides it from
  every dashboard. We **fail closed and loud** with a distinguishable code that maps to 503.
- **Window before duplicate/stock.** A closed sale rejects uniformly. Two reasons: (a) it makes
  I3 trivially auditable — "zero non-`SALE_*` outcomes outside the window" is a single SQL/log
  predicate; (b) it makes the API fast-path guard *semantically identical* to the script, which
  §4.2 requires. A user who already bought and retries after the sale ends gets `SALE_ENDED`,
  not `ALREADY_PURCHASED` — that is intended; their purchase status is served by
  `GET /purchase/:userId`, which is **not** window-gated.
- **`DECR` before `SADD`, and `DECR`'s return value is the reported `stockRemaining`.**
  Never recompute it. If `SADD` were to fail (OOM), the script aborts, the client sees an error
  (→ 500, nothing enqueued), and one unit of stock is stranded: an **undersell**, which is the
  safe direction for I1. The reverse order would leave a buyer recorded with no stock consumed,
  so the user's retry returns `ALREADY_PURCHASED` while no order exists — a user permanently
  blocked from a purchase they never got. Undersell-on-failure is the correct trade.
- Using `DECR`'s return is also what makes the concurrency spec's double-spend detector work
  (§6.3 T1): every `CONFIRMED` must report a **distinct** remaining value.

### 4.4 Config hash: why `startsAtMs` / `endsAtMs` exist

Phase 0 §16 froze `startsAt`/`endsAt` as ISO-8601 UTC strings. Those stay — they are what the API
returns and what a human reads with `HGETALL`. But Lua has no date parser, and lexicographic
comparison of ISO strings is only correct if *both* sides are byte-identical in format and
Z-normalised, which is a footgun for an invariant. So the seed script writes **both**
representations, and Lua reads only the `*Ms` fields. The store is responsible for keeping them
consistent (§5.2 derives the millis from the ISO string; they can never disagree).

Final `sale:{id}:config` field set:
`saleId`, `name`, `startsAt` (ISO), `endsAt` (ISO), `startsAtMs`, `endsAtMs`, `totalStock`.

### 4.5 Stock initialization: idempotent seeding — DECIDED

**The hazard:** two API pods boot together, both run `SET sale:{id}:stock 500`. If they boot
mid-sale (a rolling restart, a crash-loop), the second `SET` resets stock to 500 after 300 units
were sold → 800 confirmable orders against 500 units → **I1 broken**. A plain `SET` at boot is
unsafe, and `SETNX` alone is not enough because it leaves the config hash unguarded and gives no
way to detect a genuine misconfiguration.

**Decision: seeding is a Lua script (`seed.lua`) whose gate is `EXISTS config`.** Because the
whole check-and-write is one script, exactly one pod can win the race no matter how many boot
simultaneously; every other pod observes `ALREADY_SEEDED` and **writes nothing**. Stock is only
ever `SET` on the transition from "no config" to "config".

It also detects drift instead of silently applying it: if the config exists but `startsAtMs`,
`endsAtMs` or `totalStock` differ from what this pod was configured with, it returns
`CONFIG_DRIFT` **without touching anything**. Someone editing `SALE_TOTAL_STOCK` and restarting a
pod mid-sale gets a loud error, not a silent stock reset.

And it fails loud on a half-present keyspace: config present but the stock key missing means
something evicted or deleted it, so it returns `STOCK_MISSING` rather than letting the sale read
as sold out. (We rely on Redis's default `maxmemory-policy noeviction`; Phase 0 §12 sets no
`maxmemory`, so nothing can be evicted. Document that dependency in the README.)

`ARGV[8] = stockRemaining` is deliberately separate from `ARGV[7] = totalStock`: at normal boot
they are equal, but Phase 3's boot reconciliation (PRD §3.5, "if cold, rebuild stock/buyers from
Postgres") seeds with `totalStock - persistedOrderCount`. Phase 3 gets that for free.

```lua
-- seed.lua — idempotent sale initialization. The only writer of the stock key at boot.
-- KEYS[1] = sale:{<saleId>}:config
-- KEYS[2] = sale:{<saleId>}:stock
-- ARGV[1]=saleId ARGV[2]=name ARGV[3]=startsAt(ISO) ARGV[4]=endsAt(ISO)
-- ARGV[5]=startsAtMs ARGV[6]=endsAtMs ARGV[7]=totalStock ARGV[8]=stockRemaining
-- RETURN = { code, stockRemaining, totalStock, startsAtMs, endsAtMs }
if redis.call('EXISTS', KEYS[1]) == 1 then
  local cur = redis.call('HMGET', KEYS[1], 'startsAtMs', 'endsAtMs', 'totalStock')
  if redis.call('EXISTS', KEYS[2]) == 0 then
    return { 'STOCK_MISSING', -1, tonumber(cur[3]) or -1, tonumber(cur[1]) or -1, tonumber(cur[2]) or -1 }
  end
  local stock = tonumber(redis.call('GET', KEYS[2]))
  if cur[1] ~= ARGV[5] or cur[2] ~= ARGV[6] or cur[3] ~= ARGV[7] then
    return { 'CONFIG_DRIFT', stock, tonumber(cur[3]) or -1, tonumber(cur[1]) or -1, tonumber(cur[2]) or -1 }
  end
  return { 'ALREADY_SEEDED', stock, tonumber(cur[3]), tonumber(cur[1]), tonumber(cur[2]) }
end

redis.call('HSET', KEYS[1],
  'saleId',     ARGV[1],
  'name',       ARGV[2],
  'startsAt',   ARGV[3],
  'endsAt',     ARGV[4],
  'startsAtMs', ARGV[5],
  'endsAtMs',   ARGV[6],
  'totalStock', ARGV[7])
redis.call('SET', KEYS[2], ARGV[8])
return { 'SEEDED', tonumber(ARGV[8]), tonumber(ARGV[7]), tonumber(ARGV[5]), tonumber(ARGV[6]) }
```

`HMGET` returns bulk strings and `ARGV` elements are bulk strings, so the drift comparison is a
plain string compare — which is why §5.2 mandates **canonical decimal formatting** (no
exponent, no `+`, no leading zeros) when the store stringifies numbers.

### 4.6 `compensate.lua` — the DLQ path (specified now so Phase 3 cannot improvise)

Phase 3's DLQ handler must return stock and remove the buyer (PRD §3.5). It runs on an
at-least-once queue, so it **will** execute twice. Compensating twice must not push stock above
its initial value — that would break I1 by manufacturing inventory.

**The idempotency mechanism is `SREM`'s return value.** `SREM` returns 1 only on the *first*
removal of a member; every subsequent call returns 0. Inside a script that check-and-remove is
atomic, so it is a perfect single-use token: the `INCR` is gated on it. This is strictly better
than `SISMEMBER`-then-`SREM` (one fewer round trip, and no reliance on the caller getting the
pairing right).

A second, independent guard caps stock at `totalStock` even if the buyers set were somehow
inconsistent. Belt and braces on the invariant that matters most.

```lua
-- compensate.lua — DLQ compensation. Idempotent by construction. NO window check (deliberate).
-- KEYS[1] = sale:{<saleId>}:config
-- KEYS[2] = sale:{<saleId>}:stock
-- KEYS[3] = sale:{<saleId>}:buyers
-- ARGV[1] = userId
-- RETURN  = { code, stockRemaining }
local removed = redis.call('SREM', KEYS[3], ARGV[1])
local stock   = tonumber(redis.call('GET', KEYS[2]) or '0')

if removed == 0 then
  return { 'NOOP', stock }
end

local total = tonumber(redis.call('HGET', KEYS[1], 'totalStock'))
if total ~= nil and stock >= total then
  return { 'COMPENSATED_CAPPED', stock }
end

local remaining = redis.call('INCR', KEYS[2])
return { 'COMPENSATED', remaining }
```

- **No window check, deliberately.** Compensation must work after `endsAt` — that is when most
  DLQ traffic lands. Gating it on the window would strand stock and violate I4.
- `COMPENSATED_CAPPED` means the buyer was removed but stock was *not* returned because it was
  already at `totalStock`. That is an undersell by one — safe for I1 — but it signals real state
  corruption, so it gets its own code and Phase 3 must log it at `error`. It must never be
  silently folded into `COMPENSATED`.
- If the config hash is missing, `total` is nil and the cap is skipped; `SREM` remains the
  primary guard. Phase 3 logs a warning in that branch.

### 4.7 `status.lua` — consistent snapshot for `/sale/status`

Specified now for one reason: the countdown the SPA renders must be judged by the *same clock*
that will judge the purchase. If `/sale/status` returned `serverTime = Date.now()` from the API
pod while `purchase.lua` uses Redis `TIME`, the client's "0.4s left" would be a different 0.4s.
One round trip, one snapshot, one clock.

```lua
-- status.lua — read-only snapshot. No writes, no side effects.
-- KEYS[1] = sale:{<saleId>}:config
-- KEYS[2] = sale:{<saleId>}:stock
-- RETURN = { nowMs, initialized, stockRemaining, totalStock, startsAtMs, endsAtMs, name, startsAt, endsAt }
local t     = redis.call('TIME')
local nowMs = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local cfg   = redis.call('HMGET', KEYS[1],
  'totalStock', 'startsAtMs', 'endsAtMs', 'name', 'startsAt', 'endsAt')

if cfg[1] == false then
  return { nowMs, 0, -1, -1, -1, -1, '', '', '' }
end

local stock = tonumber(redis.call('GET', KEYS[2]) or '-1')
return { nowMs, 1, stock,
  tonumber(cfg[1]), tonumber(cfg[2]), tonumber(cfg[3]),
  cfg[4], cfg[5], cfg[6] }
```

`HMGET` on a missing field yields Lua `false`, which is the correct nil test here.

### 4.8 Loading strategy: EVALSHA with NOSCRIPT → EVAL fallback — FROZEN

```ts
// packages/redis/src/scripts/registry.ts
export interface LuaScript {
  readonly name: 'purchase' | 'compensate' | 'seed' | 'status';
  readonly src: string;
  readonly sha1: string;   // computed at module load from src
  readonly numKeys: number;
}
export const PURCHASE_SCRIPT: LuaScript;    // numKeys 3
export const COMPENSATE_SCRIPT: LuaScript;  // numKeys 3
export const SEED_SCRIPT: LuaScript;        // numKeys 2
export const STATUS_SCRIPT: LuaScript;      // numKeys 2
export const LUA_SCRIPTS: readonly LuaScript[];
```

- **`sha1` is computed client-side at module load**, `createHash('sha1').update(src, 'utf8').digest('hex')`.
  Not from `SCRIPT LOAD`. Two reasons: no boot round-trip and no boot ordering requirement, and
  the SHA becomes a pure function of the source that a unit test can cross-check against the
  server (§6.3 T5).
- **No `SCRIPT LOAD` at startup.** It is not needed — the `EVAL` fallback loads the script into
  the server cache as a side effect — and a boot-time load is exactly the thing that goes stale
  the moment Redis restarts.

```ts
// packages/redis/src/scripts/run.ts
export function isNoScriptError(err: unknown): boolean;   // /NOSCRIPT/.test(String((err as Error)?.message))

export async function runScript<T = unknown>(
  client: Redis, script: LuaScript, keys: string[], args: (string | number)[],
): Promise<T>;
```

`runScript` semantics, frozen:

1. `client.evalsha(script.sha1, script.numKeys, ...keys, ...args)`.
2. On error: if `isNoScriptError(err)` → `client.eval(script.src, script.numKeys, ...keys, ...args)` **once**. Otherwise rethrow.
3. **The fallback fires at most once per call.** No loop, no retry-on-retry: a persistently
   failing `NOSCRIPT` (a Redis rejecting the script) must surface, not spin.
4. `keys.length === script.numKeys` is asserted before the call; mismatch throws.

**Why the fallback is not optional:** `SCRIPT FLUSH`, a Redis restart without AOF script-cache
persistence, a failover to a replica that never saw the script, or `redis-cli DEBUG RELOAD` all
empty the script cache. Without the fallback every purchase after that returns `NOSCRIPT` — a
total outage of the hot path from an operation that is supposed to be harmless. §6.3 T4 proves
it by flushing mid-suite.

**Rejected alternative: ioredis `defineCommand`.** It is the idiomatic ioredis path and it
already implements EVALSHA→EVAL internally. Rejected for two reasons: it attaches
dynamically-named methods to the client that TypeScript cannot see without module augmentation
(so the hot path loses type safety at exactly the call that upholds I1–I3), and it hides the
fallback inside the library where our spec cannot observe it. We are required to *prove* the
fallback works; an explicit 12-line implementation is testable, the library's is not.

---

## 5. `@flash/redis` public surface — FROZEN (SLICE 3)

### 5.1 Client factory

```ts
// packages/redis/src/client.ts
import type { Redis, RedisOptions } from 'ioredis';

export interface CreateRedisClientOptions {
  url: string;                    // REDIS_URL
  /** Appears in logs / CLIENT LIST. Default 'flash'. */
  connectionName?: string;
  /** ioredis escape hatch. MUST NOT be used to set keyPrefix (throws). */
  overrides?: Partial<RedisOptions>;
}

export function createRedisClient(options: CreateRedisClientOptions): Redis;
export async function closeRedisClient(client: Redis): Promise<void>;   // quit(), falls back to disconnect()
```

Frozen ioredis options (per the `redis-connections` skill: multiplex, never per-request
connections, explicit timeouts):

| option | value | why |
|---|---|---|
| `connectTimeout` | `2000` | fail fast on a dead node |
| `commandTimeout` | `1000` | bounds hot-path damage; p99 target is 500ms |
| `maxRetriesPerRequest` | `2` | bounded; **not** `null` — see below |
| `enableReadyCheck` | `true` | don't issue commands to a loading Redis |
| `enableOfflineQueue` | `true` | brief reconnects buffer rather than erroring; `commandTimeout` is the fail-fast mechanism |
| `retryStrategy` | `(n) => Math.min(50 * 2 ** n, 2000)` | capped exponential |
| `keyPrefix` | **forbidden** | ioredis applies it to KEYS but not to `ARGV`, and it would sit *outside* our `{hash tag}` — silently breaking cluster co-location. `createRedisClient` throws if `overrides.keyPrefix` is set. |
| `lazyConnect` | `false` | connect eagerly at construction |

A single ioredis instance multiplexes all commands; **one client per process, never one per
request.** `SaleRedisStore` takes the client by injection and never constructs one.

**Phase 3 note (binding):** BullMQ requires `maxRetriesPerRequest: null` on *its* connection.
Phase 3 MUST create a **separate** client for BullMQ and MUST NOT reuse or mutate the store's
client. Mutating shared options is how the hot path silently acquires unbounded retries.

**Forbidden commands in `packages/redis/src/**` (review-enforced):** `KEYS`, `SMEMBERS`,
`FLUSHALL`, `FLUSHDB`, `SCRIPT FLUSH`. (`SCARD` and `SISMEMBER` are O(1) and fine. The test
harness may use `SCRIPT FLUSH` — production code may not.)

### 5.2 `SaleRedisStore`

```ts
// packages/redis/src/types.ts
import type { PurchaseOutcome, SaleState } from '@flash/shared';

export interface SaleConfigInput {
  saleId: string;
  name: string;
  startsAt: string;      // ISO-8601 UTC
  endsAt: string;        // ISO-8601 UTC
  totalStock: number;
  /** Defaults to totalStock. Phase 3 reconciliation passes totalStock - persistedOrders. */
  stockRemaining?: number;
}

export type SeedOutcome = 'SEEDED' | 'ALREADY_SEEDED' | 'CONFIG_DRIFT' | 'STOCK_MISSING';
export interface SeedResult {
  outcome: SeedOutcome;
  stockRemaining: number; totalStock: number; startsAtMs: number; endsAtMs: number;
}

export interface PurchaseResult {
  outcome: PurchaseOutcome;
  stockRemaining: number;   // post-decision; -1 only for NOT_INITIALIZED
  serverTimeMs: number;     // Redis TIME
}

export type CompensateOutcome = 'COMPENSATED' | 'COMPENSATED_CAPPED' | 'NOOP';
export interface CompensateResult { outcome: CompensateOutcome; stockRemaining: number; }

export interface SaleSnapshot {
  initialized: boolean;
  saleId: string; name: string;
  startsAt: string; endsAt: string;
  startsAtMs: number; endsAtMs: number;
  totalStock: number; stockRemaining: number;
  serverTimeMs: number;
  state: SaleState;         // deriveSaleState(...) applied to this snapshot
}
```

```ts
// packages/redis/src/sale-store.ts
export class SaleRedisStore {
  constructor(client: Redis);

  /** Idempotent. Safe to call from every pod on every boot. Never resets a live sale. */
  seed(config: SaleConfigInput): Promise<SeedResult>;

  /** The hot path. One round trip. Upholds I1, I2, I3. */
  purchase(saleId: string, userId: string): Promise<PurchaseResult>;

  /** Phase 3 DLQ path. Idempotent; compensating twice cannot inflate stock. */
  compensate(saleId: string, userId: string): Promise<CompensateResult>;

  /** One round trip, one clock. Backs GET /sale/status. */
  status(saleId: string): Promise<SaleSnapshot>;

  /** SISMEMBER. Backs GET /purchase/:userId's Redis half. */
  hasPurchased(saleId: string, userId: string): Promise<boolean>;

  /** HINCRBY on the metrics hash. Fire-and-forget; never throws to the caller. */
  bumpMetric(saleId: string, outcome: PurchaseOutcome | 'RATE_LIMITED' | 'INVALID_USER_ID'): Promise<void>;

  /** HGETALL — the hash has ≤ 7 fields, so this is O(1) in practice. */
  readMetrics(saleId: string): Promise<Record<string, number>>;

  ping(): Promise<boolean>;

  /**
   * TEST / OPS ONLY. DELs config, stock, buyers, metrics for one sale.
   * MUST NOT be exposed on any HTTP route in any phase.
   */
  reset(saleId: string): Promise<void>;
}
```

Store-level rules:

- `seed()` derives `startsAtMs`/`endsAtMs` from the ISO strings via `Date.parse`, and **throws
  `RangeError`** if either is `NaN` or `endsAtMs <= startsAtMs`. The two representations can
  therefore never disagree.
- All numeric `ARGV` are stringified with `String(Math.trunc(n))` — canonical decimal, no
  exponent, no sign padding. `seed.lua`'s drift comparison is a string compare and depends on it.
- `status()` calls `deriveSaleState` from `@flash/shared` on the snapshot it just read. It does
  not re-read the clock.
- `purchase()`/`compensate()` decode the RESP array positionally and **validate the code against
  the frozen union**; an unrecognised code throws rather than being passed through.
- The store never catches Redis errors to return a "safe" outcome. A Redis failure is an
  exception; Phase 2 maps it to 503. Swallowing it would fabricate `SOLD_OUT`.

---

## 6. Testing — FROZEN

### 6.1 ioredis-mock is BANNED for Lua specs — DECIDED

PRD §6.1 offers "ioredis-mock or embedded Redis". **This contract removes the first option.**

A mock cannot prove atomicity, and here is the precise reason, which belongs in the README:
atomicity is a property of *Redis's single-threaded command dispatcher*. `ioredis-mock` executes
in the Node event loop, where a `Promise.all` of 500 "purchases" is interleaved by the JS
scheduler, not by Redis. Any apparent serialization is an artefact of JS single-threading.

The consequence is fatal: **a green ioredis-mock atomicity test would also pass against an
implementation that did `GET` → check → `DECR` → `SADD` as four separate round trips** — the
exact non-atomic implementation the test exists to reject. The test would have zero
discriminating power while looking like coverage. That is the Phase 0 failure mode wearing a
different hat.

Therefore: **every spec that exercises Lua runs against a real Redis 7.4 server.** Non-negotiable.
`ioredis-mock` MUST NOT appear in any `package.json` in this repo.

Pure functions (`deriveSaleState`, key builders, zod schemas, `isNoScriptError`,
sha computation) need no Redis and MUST NOT start a container.

### 6.2 Test infrastructure

`packages/redis/test/global-setup.ts`:

```
if (process.env.REDIS_TEST_URL is set)  -> use it, start nothing, but PING it and
                                            THROW if unreachable.
else                                    -> start @testcontainers/redis RedisContainer
                                            with image 'redis:7.4-alpine' (same tag as
                                            infra/docker-compose.yml §12), use its URL,
                                            stop it in teardown.
```

- The URL is handed to workers with vitest's `provide('redisUrl', url)` / `inject('redisUrl')`.
  **Not** via `process.env` mutation — env propagation from `globalSetup` to worker processes is
  not contractual. `packages/redis/test/vitest.d.ts` declares
  `declare module 'vitest' { interface ProvidedContext { redisUrl: string } }`.
- **If neither path yields a reachable Redis, `globalSetup` throws and the whole suite fails.**
  There is no skip branch, no `it.skipIf`, no `try/catch` that downgrades to a warning. Adding
  one is a contract violation and an automatic slice rejection.
- **No spec may call `FLUSHDB`/`FLUSHALL`.** A developer may point `REDIS_TEST_URL` at their
  compose Redis on `:6380`; a flush would nuke their working sale. Isolation is instead by
  **unique sale id per spec/case**: `test/harness.ts` exports
  `uniqueSaleId(): string` → `t-${randomUUID().replace(/-/g, '').slice(0, 12)}` (matches
  `SALE_ID_PATTERN`). Because ids never collide, `fileParallelism` stays enabled.
- `test/harness.ts` also exports: `connect(): Redis` (a fresh client from the injected URL),
  `connectMany(n: number): Redis[]`, `seedActiveSale(store, { stock, ...})`,
  `seedFutureSale`, `seedEndedSale`, and `cleanup(saleId)` (calls `store.reset`, in `afterEach`).
- `packages/redis/vitest.config.ts`: `environment: 'node'`, `include: ['src/**/*.spec.ts']`,
  `globalSetup: ['./test/global-setup.ts']`, `testTimeout: 30_000`, `hookTimeout: 60_000`.

Wiring changes (SLICE 3):
- `turbo.json` → add `"REDIS_TEST_URL"` to `globalPassThroughEnv`. Nothing else in that file changes.
- `.env.example` → new `# test` section with
  `REDIS_TEST_URL=` and a comment: *"optional; when unset the redis package's unit tests start a
  throwaway container via testcontainers."*
- `.github/workflows/ci.yml` → the **`unit`** job gains a `redis:7.4-alpine` service container
  (`6379:6379`, healthcheck `redis-cli ping`, 5s/3s/10) and job env
  `REDIS_TEST_URL: redis://localhost:6379`. The service container is used *instead of*
  testcontainers in CI for determinism and image-pull cost; testcontainers remains the local path.
  No other job changes. **No job gains `continue-on-error`.**

### 6.3 Required specs — implementers may add, may not omit

Each `T` below is a hard requirement. A spec that asserts less than what is written has not
satisfied it.

**T1 — Concurrency / I1 (the money test).** `packages/redis/src/sale-store.concurrency.spec.ts`.
Stock `M = 10`, `N = 500` distinct userIds. All 500 `purchase()` calls fired with `Promise.all`,
**round-robined over ≥ 50 independent ioredis connections** — a single multiplexed client issues
commands in call order and would serialize the workload client-side, which is precisely the
weakness that lets a non-atomic implementation look correct. Assert:
- `count(CONFIRMED) === 10` exactly
- `count(SOLD_OUT) === 490`; no other outcome appears
- `GET stock === 0` — and separately assert it is **never negative**
- `SCARD buyers === 10`
- **the 10 `CONFIRMED` `stockRemaining` values are exactly the set `{9,8,7,6,5,4,3,2,1,0}` — all
  distinct.** This is the double-spend detector: two concurrent non-atomic decrements either
  report the same remaining value or skip one. Assert on the sorted array, not on the count.
- the 10 confirmed userIds are distinct and are exactly the members of the buyers set
- The whole scenario runs **≥ 5 times in a loop**, each with a fresh `uniqueSaleId()`, so a
  single lucky scheduling cannot produce a pass.

**T2 — Negative control (proves T1 can fail).** Same file. A deliberately non-atomic
`purchaseUnsafe()` defined **inside the spec file only** — `GET` → `await setImmediate` →
check → `DECR` → `SADD`, as four separate round trips over distinct connections. Run T1's exact
scenario against it and assert it **oversells**: `confirmedCount > 10` **or** final stock `< 0`.
If this test passes-as-in-does-not-oversell, the harness lacks the concurrency to detect
non-atomicity and the suite must fail. The `setImmediate` yield makes it deterministic, not flaky.
Without this control, T1 is unfalsifiable — it would go green against a harness that never
actually overlapped requests.

**T3 — I2 duplicate storm.** `sale-store.purchase.spec.ts`. **One** userId, `N = 200` concurrent
attempts, stock `= 100`, ≥ 20 connections. Assert exactly 1 `CONFIRMED`, 199
`ALREADY_PURCHASED`, `GET stock === 99`, `SCARD buyers === 1`.

**T4 — NOSCRIPT fallback.** `scripts/run.spec.ts`. (a) `SCRIPT EXISTS <sha>` → 0 on a cold
server; (b) run a `purchase()` → succeeds; (c) `SCRIPT EXISTS <sha>` → 1; (d) `SCRIPT FLUSH SYNC`;
(e) `SCRIPT EXISTS <sha>` → 0; (f) run `purchase()` again → **succeeds** with the correct outcome;
(g) `SCRIPT EXISTS <sha>` → 1, proving the `EVAL` fallback re-loaded it. Also assert a
**non**-NOSCRIPT error (e.g. wrong `numKeys`) is rethrown and does **not** trigger a second call.

**T5 — SHA correctness.** `scripts/registry.spec.ts`. For all four scripts: the client-computed
`sha1` equals what the server returns from `SCRIPT LOAD src`. Also assert `numKeys` matches the
KEYS actually referenced in the source (grep the source string for `KEYS[n]`).

**T6 — Window / I3 at exact millisecond boundaries.** `sale-store.window.spec.ts`. Uses the
**server's own clock**, so it is deterministic without fake timers:
- read `TIME` → `t0`; seed `startsAtMs = t0`, `endsAtMs = t0 + 3_600_000` → `purchase()` returns
  `CONFIRMED`. Proves the start boundary is **inclusive** (real time only moves forward, so
  `now >= t0` always holds).
- seed `startsAtMs = t0 - 1000`, `endsAtMs = t0` → `purchase()` returns `SALE_ENDED`. Proves the
  end boundary is **exclusive**.
- seed `startsAtMs = t0 + 60_000` → `SALE_NOT_STARTED`, and assert `GET stock` is **unchanged**
  and `SCARD buyers === 0` — a rejected attempt must have zero side effects.
- same assertion for the `SALE_ENDED` case.
- a `SALE_ENDED` attempt by a user who already bought returns `SALE_ENDED`, **not**
  `ALREADY_PURCHASED` (pins the §4.3 check order).

**T7 — Compensation idempotency / I4 without breaking I1.** `sale-store.compensate.spec.ts`.
- purchase (10 → 9) → `compensate()` → `COMPENSATED`, stock `10`, `SCARD buyers === 0`
- `compensate()` again → `NOOP`, stock still `10` (**not 11**)
- after one purchase, fire **100 concurrent** `compensate()` for that user over ≥ 20 connections
  → exactly 1 `COMPENSATED`, 99 `NOOP`, final stock exactly `10`
- compensate a user who never purchased → `NOOP`, stock unchanged
- set stock to `totalStock` with a buyer still present → `COMPENSATED_CAPPED`, stock unchanged
- compensation succeeds on a sale whose `endsAtMs` is in the past (proves no window gate)

**T8 — Seed idempotency.** `sale-store.seed.spec.ts`.
- 50 concurrent `seed()` with identical config over ≥ 20 connections → exactly 1 `SEEDED`,
  49 `ALREADY_SEEDED`, stock `=== totalStock`
- seed → purchase ×3 (stock 497) → seed again with the *same* config → `ALREADY_SEEDED` **and
  stock is still 497**. This is the I1 regression test for the double-boot hazard; assert the
  stock value, not just the outcome code.
- seed again with a different `totalStock` → `CONFIG_DRIFT`, and stock **unchanged**
- seed again with a different `endsAt` → `CONFIG_DRIFT`
- `DEL` the stock key, seed again → `STOCK_MISSING`
- `seed()` with `endsAt <= startsAt`, or an unparseable ISO string → throws `RangeError`

**T9 — Fail-closed on an uninitialized sale.** `sale-store.purchase.spec.ts`. `purchase()` against
a never-seeded `uniqueSaleId()` returns `NOT_INITIALIZED` with `stockRemaining === -1` — **and
explicitly assert it is not `SOLD_OUT`**. Guards the §4.3 ordering decision.

**T10 — Pure-function specs (no Redis).** SLICE 1 / SLICE 2:
- `sale-state.spec.ts` asserts **every row of the §3.3 boundary table**, plus the `RangeError`
  cases, plus `msUntilNextTransition`.
- `keys.spec.ts` asserts the literal key strings for `saleId = 'flash-2026'`, **and**
  programmatically extracts `/\{([^}]*)\}/` from all four keys of one sale and asserts every
  captured tag is identical and equals the saleId — the cluster-correctness proof. Plus
  `assertSaleId` rejects `''`, `'a b'`, `'has{brace'`, `'has}brace'`, `'has:colon'`, `'UPPER'`,
  and a 65-char id.
- `results.spec.ts` asserts `PURCHASE_OUTCOME_HTTP_STATUS` covers every member of
  `PURCHASE_OUTCOMES` with the exact §7 codes, and that `OUTCOME_METRIC_FIELD` covers every
  member with a field name present in `SALE_METRIC_FIELDS`.
- `dto/user-id.spec.ts` — table-driven, see §8.4.

### 6.4 What "green" means at the Phase 1 gate

Run by the **orchestrator**, not reported by an agent, with caching bypassed:

```bash
pnpm install --frozen-lockfile
pnpm exec turbo run typecheck lint build test --force     # expect "Cached: 0 cached"
```

Plus these independent confirmations, because "the suite passed" is a claim, not evidence:

1. `pnpm --filter @flash/redis test` prints a **non-zero** test count for each of
   `sale-store.concurrency`, `sale-store.window`, `sale-store.compensate`, `sale-store.seed`,
   `scripts/run` — i.e. no file silently contributed 0 tests.
2. `grep -rnE '\.(skip|todo|skipIf|runIf|only)\b' packages/redis/src packages/shared/src` returns
   **nothing**.
3. `grep -rn 'ioredis-mock' .` returns nothing outside this contract.
4. **Falsification check:** temporarily replace the `purchase.lua` body with the naive
   non-atomic form (`GET`/`DECR`/`SADD` issued as three separate `client.*` calls from
   `sale-store.ts`), confirm T1 **fails**, then revert. A suite that stays green under this
   mutation is not testing what it claims to test. Record the observed failure output in
   `STATE.md`.
5. Artifacts on disk: `packages/shared/dist/index.js`, `packages/shared/dist/schemas.js`,
   `packages/redis/dist/index.js` all exist and are non-trivial after a second consecutive
   `--force` build (the Phase 0 hollow-build regression).

---

## 7. Result & error taxonomy — FROZEN (SLICE 1, `packages/shared/src/results.ts`)

One vocabulary, shared by Redis, API, worker and web. **Phase 2 maps; it does not invent.**

```ts
export const PURCHASE_OUTCOMES = [
  'CONFIRMED', 'ALREADY_PURCHASED', 'SOLD_OUT',
  'SALE_NOT_STARTED', 'SALE_ENDED', 'NOT_INITIALIZED',
] as const;
export type PurchaseOutcome = (typeof PURCHASE_OUTCOMES)[number];

/** Outcomes produced above the Redis layer. Never returned by Lua. */
export const REQUEST_OUTCOMES = ['INVALID_USER_ID', 'RATE_LIMITED', 'UPSTREAM_UNAVAILABLE'] as const;
export type RequestOutcome = (typeof REQUEST_OUTCOMES)[number];

/** The full vocabulary. Used by z.enum(...) in §8.5 — must be a readonly string tuple. */
export const ATTEMPT_OUTCOMES = [...PURCHASE_OUTCOMES, ...REQUEST_OUTCOMES] as const;
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];

export const ORDER_STATUSES = ['reserved', 'persisted', 'compensated'] as const;  // == the PG enum
export type OrderStatus = (typeof ORDER_STATUSES)[number];
```

| Outcome | HTTP | Where decided | Meaning |
|---|---|---|---|
| `CONFIRMED` | **201** | `purchase.lua` | Reserved in Redis; enqueued for durable write |
| `ALREADY_PURCHASED` | **409** | `purchase.lua` | I2 — this user already holds a unit |
| `SOLD_OUT` | **410** | `purchase.lua` | I1 — stock exhausted, window still open |
| `SALE_NOT_STARTED` | **403** | `purchase.lua` (guard may pre-empt) | I3 — `now < startsAt` |
| `SALE_ENDED` | **403** | `purchase.lua` (guard may pre-empt) | I3 — `now >= endsAt` |
| `NOT_INITIALIZED` | **503** | `purchase.lua` | Redis has no config for this sale — an outage, not a business answer |
| `INVALID_USER_ID` | **422** | validation pipe | Failed the §8.4 schema |
| `RATE_LIMITED` | **429** | rate limiter | Per-IP or per-user cap |
| `UPSTREAM_UNAVAILABLE` | **503** | catch-all | Redis unreachable / command timeout |

`403` for both `SALE_NOT_STARTED` and `SALE_ENDED` keeps PRD §4's HTTP contract exactly while
giving the SPA the discriminator it needs.

```ts
export const PURCHASE_OUTCOME_HTTP_STATUS = { ... } as const satisfies Record<AttemptOutcome, number>;
export const SALE_NOT_ACTIVE_OUTCOMES = ['SALE_NOT_STARTED', 'SALE_ENDED'] as const;
export function isSuccessOutcome(o: AttemptOutcome): o is 'CONFIRMED';

export const SALE_METRIC_FIELDS = [
  'confirmed', 'already_purchased', 'sold_out',
  'sale_not_active', 'not_initialized', 'rate_limited', 'invalid_user_id',
] as const;
export const OUTCOME_METRIC_FIELD = { ... } as const satisfies Record<AttemptOutcome, SaleMetricField>;
```

`SALE_NOT_STARTED` and `SALE_ENDED` both map to the metric field `sale_not_active`, preserving
Phase 0 §16's frozen field names. `not_initialized` and `invalid_user_id` are the additive
fields from §0.2.

Both records use `satisfies Record<AttemptOutcome, …>`: adding an outcome without adding its
mapping is a **compile error**, not a runtime surprise.

---

## 8. DTOs & validation — FROZEN (SLICE 2)

### 8.1 Library choice: **Zod v4** (`zod@^4.4.3`) — DECIDED

The requirement is one schema that is simultaneously a runtime validator on the server and a
static type for the client. Zod is the only mainstream option where `z.infer<typeof S>` makes the
type a *derivation* of the validator, so they cannot drift.

**Rejected — `class-validator` + `class-transformer`** (the NestJS default). Decorator-based, so
the schema *is* a class: `apps/web` would have to import runtime classes and `reflect-metadata`
to get types, and the "one source of truth" property collapses because the TS type and the
decorators are maintained separately (`@IsString() name: string` — nothing checks they agree).

**Rejected — TypeBox + Fastify's native ajv.** The genuinely strong alternative: TypeBox emits
JSON Schema, Fastify compiles it to specialised JS, and validation becomes the fastest option
available — which matters at 2,000 req/s. Rejected on balance because (a) the purchase DTO is a
**single string field**, so validation cost is far below network and Lua time — this is not where
the p95 budget goes; (b) TypeBox's inferred types are noticeably worse to read and refine; and
(c) the migration path is cheap and mechanical if profiling ever contradicts (a): Zod 4 ships
`z.toJSONSchema()`, so the Fastify route schema can be *generated* from the same source of truth
without changing where that truth lives. We are not locked in. Say exactly this in the README.

`zod` is a **dependency of `@flash/shared`** and of nothing else.

### 8.2 Two entry points — keeping zod out of the browser bundle

`apps/web` imports **values** from `@flash/shared` today. If the `.` barrel re-exported zod
schemas, every browser bundle would carry zod for nothing.

```jsonc
// packages/shared/package.json — exports map (SLICE 2)
"exports": {
  ".":        { "types": "./dist/index.d.ts",   "default": "./dist/index.js" },
  "./schemas":{ "types": "./dist/schemas.d.ts", "default": "./dist/schemas.js" }
}
```

| Entry | Contains | Runtime deps | Imported by |
|---|---|---|---|
| `@flash/shared` | constants, health, key builders, state machine, result taxonomy | **none** | api, worker, **web (values OK)** |
| `@flash/shared/schemas` | zod schemas **and their inferred types** | `zod` | api (validation), worker; **web via `import type` only** |

**Rule:** the DTO *types* are exported from `./schemas` alongside the schemas — not re-exported
from `.`. `import type { PurchaseResponse } from '@flash/shared/schemas'` is fully erased by
TypeScript and emits no `require`, so web pays nothing. This is what removes the cross-slice
edit between S1's `index.ts` and S2's DTO files: neither barrel ever references the other slice.

`packages/shared/src/index.ts` (S1) keeps the Phase-0 import-then-export shape — the comment
there explaining Rollup's CJS interop is still load-bearing. `src/schemas.ts` (S2) uses the same
shape.

**Build guard extension (S2):** `packages/shared` gains `tsconfig.build.json`
(`exclude: ["**/*.spec.ts"]`, so specs stop shipping in `dist/`), and its build script becomes
`tsc -p tsconfig.build.json && node ../../scripts/assert-build-output.mjs dist/index.js dist/index.d.ts dist/schemas.js dist/schemas.d.ts`.
`typecheck` keeps using `tsconfig.json` so specs are still type-checked. `packages/redis` follows
the identical pattern.

### 8.3 Wire-format conventions

- Timestamps on the wire are **ISO-8601 UTC strings** (`startsAt`, `endsAt`, `serverTime`).
- Every timestamp field is accompanied by an epoch-millis twin (`serverTimeMs`, `startsAtMs`,
  `endsAtMs`) so the SPA's clock-drift countdown (PRD §5.2) never parses a date on the hot path.
- `status` on a purchase response is an `AttemptOutcome` literal — the same vocabulary as §7.
- **All `/purchase` responses share one envelope**, success and failure alike, so the SPA branches
  on one field instead of on HTTP status classes.

### 8.4 `userId` — the exact rule

**Trimmed, 3–64 characters, `/^[a-zA-Z0-9._@-]+$/`** (letters, digits, `.`, `_`, `@`, `-`).

```ts
// packages/shared/src/constants.ts  (SLICE 1 — single source of the regex)
export const USER_ID_MIN_LENGTH = 3;
export const USER_ID_MAX_LENGTH = 64;
export const USER_ID_PATTERN = /^[a-zA-Z0-9._@-]+$/;
```

```ts
// packages/shared/src/dto/user-id.ts  (SLICE 2)
export const userIdSchema = z
  .string()
  .trim()                                     // trim FIRST — length is measured after
  .min(USER_ID_MIN_LENGTH)
  .max(USER_ID_MAX_LENGTH)
  .regex(USER_ID_PATTERN);
export type UserId = z.infer<typeof userIdSchema>;
```

The `.trim()` must precede the length checks and the parsed **output must be the trimmed value** —
the same string that goes into `SADD`. If trimming happened after validation, `'  bob  '` and
`'bob'` would be different set members and I2 would be defeated by whitespace.

`user-id.spec.ts` is table-driven and MUST include:

| input | verdict | proves |
|---|---|---|
| `'abc'` | accept → `'abc'` | floor |
| `'a'.repeat(64)` | accept | ceiling |
| `'a'.repeat(65)` | reject | ceiling is exclusive above |
| `'  bob  '` | accept → **`'bob'`** | trim applied *and* output trimmed |
| `'  ab  '` | **reject** | length measured **after** trim — pins ordering |
| `'ab'` | reject | floor is exclusive below |
| `''`, `'   '` | reject | empty / whitespace-only |
| `'a.b_c-d@e'` | accept | full charset |
| `'a b'`, `'a/b'`, `'a+b'`, `'a,b'`, `'user\n'`, `'us er'` | reject | charset is a whitelist |
| `'usér'`, `'用户名'` | reject | non-ASCII rejected |
| `'ab*'` (regex-ish), `'{tag}'` | reject | no key/hash-tag injection surface |
| `123`, `null`, `undefined`, `{}` | reject | non-string input |

### 8.5 Frozen DTO shapes

```ts
// dto/purchase.ts
export const purchaseRequestSchema = z.object({ userId: userIdSchema }).strict();
export type PurchaseRequest = z.infer<typeof purchaseRequestSchema>;

export const purchaseResponseSchema = z.object({
  status: z.enum(ATTEMPT_OUTCOMES),        // §7 vocabulary
  userId: z.string(),
  saleId: z.string(),
  stockRemaining: z.number().int().nullable(),   // null when unknown (422/429/503)
  serverTime: z.iso.datetime(),
  serverTimeMs: z.number().int(),
  message: z.string().optional(),          // human-readable; never parsed by the client
});
export type PurchaseResponse = z.infer<typeof purchaseResponseSchema>;
```

`.strict()` on the request: an unknown key is a rejected request, not a silently ignored one.

```ts
// dto/sale-status.ts   — GET /api/sale/status
export const saleStatusResponseSchema = z.object({
  saleId: z.string(),
  name: z.string(),
  status: z.enum(SALE_STATES),
  startsAt: z.iso.datetime(), endsAt: z.iso.datetime(),
  startsAtMs: z.number().int(), endsAtMs: z.number().int(),
  totalStock: z.number().int().nonnegative(),
  stockRemaining: z.number().int().nonnegative(),
  serverTime: z.iso.datetime(), serverTimeMs: z.number().int(),
});
export type SaleStatusResponse = z.infer<typeof saleStatusResponseSchema>;
```

Additive vs PRD §4 (`saleId`, `name`, `totalStock`, the `*Ms` twins): the SPA's stock meter needs
a denominator and its countdown needs millis. The PRD's five fields are all present, unrenamed.

```ts
// dto/purchase-status.ts  — GET /api/purchase/:userId
export const purchaseStatusParamsSchema = z.object({ userId: userIdSchema }).strict();

export const purchaseStatusResponseSchema = z.object({
  userId: z.string(),
  saleId: z.string(),
  purchased: z.boolean(),
  order: z.object({
    status: z.enum(ORDER_STATUSES),        // reserved | persisted | compensated
    createdAt: z.iso.datetime().nullable(),
  }).nullable(),
  serverTime: z.iso.datetime(), serverTimeMs: z.number().int(),
});
export type PurchaseStatusResponse = z.infer<typeof purchaseStatusResponseSchema>;
```

`order` is `null` (not absent) when `purchased === false` — one shape, no optionality branch in
the SPA. `'reserved'` means Redis has the buyer but Postgres has no row yet.

**No response schema is used to *validate* an outbound response at runtime in Phase 2** — that
would burn CPU on the hot path. They exist to derive the types and to let integration tests
assert `schema.parse(body)` on the *client* side of a request. State that so nobody wires them
into a serializer.

---

## 9. Package definitions — FROZEN

### `packages/shared` (SLICE 2 owns the manifest)

Adds `"dependencies": { "zod": "^4.4.3" }` and the §8.2 `exports` map. Scripts change only as
described in §8.2. `type` stays absent (CJS). devDeps unchanged.

### `packages/redis` (SLICE 3)

```jsonc
{
  "name": "@flash/redis", "version": "0.0.0", "private": true,
  "main": "./dist/index.js", "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.build.json && node ../../scripts/assert-build-output.mjs dist/index.js dist/index.d.ts",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "lint": "eslint .",
    "test": "vitest run",
    "clean": "rm -rf dist .turbo *.tsbuildinfo"
  },
  "dependencies": { "@flash/shared": "workspace:*", "ioredis": "^5.11.1" },
  "devDependencies": {
    "@flash/tooling": "workspace:*", "@testcontainers/redis": "^12.0.4",
    "@types/node": "^22.10.2", "eslint": "^9.17.0",
    "typescript": "^5.7.2", "vitest": "^3.2.6"
  }
}
```

- `type` **absent** (CJS), matching Phase 0 §9.2. `tsconfig.json` extends
  `@flash/tooling/tsconfig/node.json` with `outDir: "dist"`, `rootDir: "src"`,
  `include: ["src/**/*", "test/**/*", "vitest.config.ts"]`; `tsconfig.build.json` extends it with
  `exclude: ["**/*.spec.ts", "test", "vitest.config.ts", "dist", "node_modules"]`.
- `eslint.config.mjs`: `import base from '@flash/tooling/eslint/base'; export default base;`
- **Do not add `"incremental": true`** anywhere. Phase 0's hollow build came from exactly that.
- **Do not remove or weaken** `scripts/assert-build-output.mjs` from any build script.
- No new dependency beyond this list without an architect escalation. In particular: no
  `ioredis-mock`, no `redis-mock`, no `lodash`, no `date-fns`, no `luxon`.

---

## 10. Definition of done — Phase 1 gate

From a clean tree, orchestrator-run, caching bypassed:

```bash
pnpm install --frozen-lockfile
pnpm format:check && pnpm lint
pnpm exec turbo run typecheck lint build test --force     # "Cached: 0 cached"
```

Plus, all five confirmations of §6.4 — including the **falsification check (§6.4.4)**, whose
observed failure output must be pasted into `STATE.md` as the evidence that the atomicity specs
have discriminating power.

Plus, by review:
- `packages/shared`'s `.` entry has **zero** runtime dependencies (`require`s only Node builtins,
  nothing) — verify with `node -e "require('./packages/shared/dist/index.js')"` from a directory
  where `zod` is not resolvable, or by inspecting `dist/index.js` for `require(`.
- The four `.lua.ts` sources match §4.3, §4.5, §4.6, §4.7 **verbatim** (whitespace may differ;
  semantics and statement order may not).
- No file exists outside the §2 tree.
- No `apps/**` file was modified.

Then, and only then: commit → `git tag -a phase-1-done -m "Phase 1: domain core"` → update
`STATE.md`. **Subagents do not tag and do not edit `STATE.md`** (Phase 0 process note).

---

## 11. POST-FREEZE REMEDIATION ADDENDUM — Phase 1 review findings 1–3

**Authority:** remediation pass responding to a Phase 1 review, run against this frozen
contract's own implementation. **Status:** applied. This section amends §4.3, §4.6, §5.1,
§5.2 and §6.3 — it does not re-litigate any other decision in this document, and every
change below is additive (new key, new script, new store methods, new/widened method
signatures) rather than a removal.

**Why this exists as an addendum rather than a rewrite of §4/§5:** the review surfaced two
CRITICAL and one MAJOR defect that are properties of the *design*, not the implementation —
i.e. an implementer following §4.3/§4.6 verbatim would reproduce them. The findings' own fix
text said as much ("Requires an architect escalation to unfreeze §4.3/§4.6/§5.2"). No
architect agent was reachable synchronously in the remediation session; the review findings
themselves carried complete, concrete fix designs (schema, script bodies, method
signatures) commissioned by the orchestrator, and the standing process rule — "an honest
'unresolved' is worth far more than a false green," "never fix a finding by suppressing the
check that caught it" — leaves no honest path that ships I1/I2/I4 defects covered by a gate
that says "Unit suite green." The fix designs below are implemented as specified in the
findings, verified against real Redis, and recorded here for exactly the reason §0.2 exists:
so no later reader mistakes an undocumented deviation for drift.

### 11.1 Finding 1 (CRITICAL, I1/I2/I4) — reservation identity replaces Set-membership as the compensation idempotency token

**The defect.** §4.6's `compensate.lua` used `SREM`'s return value against the buyers Set as
its idempotency token — 1 on first removal, 0 ever after. That token is per-*membership*,
not per-*reservation*. Contract §4.6 itself assumed "it runs on an at-least-once queue, so it
WILL execute twice" and treated `SREM`'s return as "a perfect single-use token" against that
redelivery — true only if the member is never re-added, which the purchase path does by
design on every legitimate re-purchase. Sequence: purchase(U) → CONFIRMED (R1) → durable
write fails → DLQ compensates R1 → COMPENSATED, stock restored, U removed → U retries →
purchase(U) → CONFIRMED (R2), persists successfully → the at-least-once queue redelivers the
STALE R1 compensation job → `SREM` finds U a member again (from R2) → returns 1, not 0 →
COMPENSATED again: stock inflated one unit above what's truly outstanding (I1), U's buyer-set
guard erased so a third purchase succeeds (I2), and R2 — genuinely persisted in Postgres —
silently vanishes from Redis's point of view (I4). Reproduced verbatim against
`redis:7.4-alpine` with the frozen scripts.

**The fix.** A 4th key, `sale:{<id>}:reservations` (hash: `userId -> "<reservationId>:<reservedAtMs>"`),
added via `packages/shared/src/keys.ts`'s `saleReservationsKey` / `saleKeys().reservations`.

- `purchase.lua` (§4.3) gains `KEYS[4]` and `ARGV[2] = reservationId` (a UUID generated
  client-side by `SaleRedisStore.purchase`, no extra round trip). On `CONFIRMED`, in the SAME
  atomic step as `DECR`/`SADD`, it now also `HSET`s the reservation. The RETURN tuple gains a
  4th element, `reservationId` (empty string for every non-CONFIRMED outcome). Every check and
  its order from the original §4.3 body is unchanged; only the CONFIRMED branch grew one write.
- `compensate.lua` (§4.6) gains `KEYS[4]` and `ARGV[2] = reservationId`. It now `HGET`s the
  reservations hash for the user, compares the stored reservation id (the token before the
  literal `:`) against `ARGV[2]`, and is unconditionally `NOOP` on any mismatch — including a
  missing entry — before it ever touches `SREM`/`INCR`. On a match it `HDEL`s the entry in the
  same atomic step as the `SREM`, preserving single-use-token semantics for *correctly*
  redelivered jobs (same reservationId, at-least-once redelivery of the same job) while closing
  the hole for *stale* ones (redelivery of a job for a reservation the user has since replaced).
- `SaleRedisStore.compensate` (§5.2) signature widens to
  `compensate(saleId, userId, reservationId): Promise<CompensateResult>`. Phase 3 MUST carry
  the `reservationId` `purchase()` returned on the BullMQ job payload and pass it back
  unchanged on both the persist-success path (nothing to do) and the DLQ compensation path.
- `LuaScript.numKeys` for both `purchase` and `compensate` is now 4 (`packages/redis/src/scripts/registry.ts`).
  `SaleRedisStore.reset` now also `DEL`s the reservations key.

**Proof.** `packages/redis/src/sale-store.compensate.spec.ts` gained the regression case
"FINDING 1 REGRESSION" reproducing the exact timeline above end-to-end against real Redis and
asserting the stale R1 redelivery is a NOOP that leaves R2's stock/buyer/reservation state
untouched, plus a case for an unrecognised reservationId against a real purchase. All
pre-existing T7 cases were updated to thread `reservationId` through (some needed their
manually-constructed "corrupted state" fixtures extended to also write a matching
reservations-hash entry, since that hash is now load-bearing for the idempotency check they
exercise). `sale-store.concurrency.spec.ts` (T1) gained an assertion that every `CONFIRMED`
result carries a distinct, non-empty `reservationId` and that the reservations hash has
exactly `STOCK` entries — an atomic-uniqueness proof independent of the pre-existing
stockRemaining one. `sale-store.window.spec.ts` (T6) gained assertions that a rejected
purchase leaves the reservations hash empty (zero side effects, matching the existing buyers/
stock assertions). All specs pass against real Redis 7.4 (§6.1); see the gate evidence for
counts.

### 11.2 Finding 2 (CRITICAL, I1/I4) — a reconciliation primitive and a scan/restore path for the reservations ledger

**The defect.** §4.5's `seed.lua` gate is `EXISTS config`. That is correct for cold boot but
makes WARM recovery unimplementable: an AOF `everysec` partial replay after a Redis restart
can lose up to ~1s of writes while leaving `config` (rarely mutated) untouched. `seed()` then
observes all three drift fields matching and returns `ALREADY_SEEDED`, writing nothing — the
one recovery lever PRD §3.5 names for this case (re-seed from Postgres truth) is a no-op by
construction. Compounding this, prior to §11.1 there was no primitive to enumerate the buyers
set at all (`SMEMBERS` is banned by §5.1; no `SSCAN`/`HSCAN` alternative existed), so even a
successful stock correction could not be paired with restoring the I2 guard for the specific
users whose `SADD` was lost.

**The fix.** Three additions, none of which relax §5.1's forbidden-command list (SSCAN/HSCAN
were never on it — only `SMEMBERS`/`HGETALL` block-reads are banned):

- **`reconcile.lua`** (new script, `packages/redis/src/scripts/reconcile.lua.ts`, `numKeys: 2`,
  registered as `RECONCILE_SCRIPT`). Explicit-intent stock correction: `NOT_INITIALIZED` if the
  sale was never seeded (it never creates one), otherwise unconditionally `SET`s the stock key
  and returns `{ 'RECONCILED', previousStock, newStock }`. Exposed as
  `SaleRedisStore.reconcileStock(saleId, stockRemaining)`. This is a single-caller, Phase-3-only
  primitive — the value MUST be derived from Postgres (`totalStock - persistedOrderCount`),
  never from client input; nothing in Phase 1 calls it.
- **`SaleRedisStore.scanReservations(saleId, cursor, count)`** — cursor-paged `HSCAN` over the
  reservations hash, returning `{ userId, reservationId, reservedAtMs }` entries. Supersedes a
  standalone buyers-only scan: the reservations hash already carries the buyers Set's
  membership information plus the identity and timestamp the sweep needs, in one structure.
- **`SaleRedisStore.restoreReservations(saleId, entries)`** — chunked (500/batch), pipelined
  `SADD` (buyers) + `HSET` (reservations) from an authoritative snapshot (Postgres). Not
  Lua-atomic by design: it runs once, offline, against a caller-verified snapshot, not
  concurrently with live traffic, so cross-user atomicity buys nothing here.

**Proof.** New file `packages/redis/src/sale-store.reconcile.spec.ts`: `reconcileStock` against
an uninitialized sale (`NOT_INITIALIZED`, touches nothing); the literal AOF-partial-loss
scenario from the finding (seed 500, sell 300, force stock to a wrong post-replay value,
correct it via `reconcileStock`, assert the exact previous/new values); `scanReservations`
paging through 50 reservations at a small COUNT and matching the buyers set exactly;
`restoreReservations` rebuilding both the buyers Set (I2) and the reservations ledger (I4,
compensation still works with the original reservationId) after a simulated cold-data-loss
`reset()`; and an empty-snapshot no-op case. All pass against real Redis 7.4.

### 11.3 Finding 3 (MAJOR, I4) — subsumed by §11.1

**The defect** (persisted narrower than "no reservation record exists" — restated for the
record): at `CONFIRMED` time, prior to this addendum, Redis recorded only Set membership — no
reservation id, no timestamp, no pending-persistence marker — and `commandTimeout: 1000`
(§5.1) is a client-side timer that does not abort server-side execution, so a slow Redis
instant can produce a silent, server-side-successful `CONFIRMED` that the client observes as a
timeout error and never enqueues. Nothing distinguished that orphan from a healthy in-flight
reservation, and (pre-§11.2) nothing could enumerate it either.

**The fix.** §11.1's reservations hash *is* the fix this finding asked for: every `CONFIRMED`
purchase now durably records `<reservationId>:<reservedAtMs>` in the same atomic unit as the
stock decrement, independent of whether the client observes the reply. §11.2's
`scanReservations` is exactly the "O(pending) set of exactly what needs persisting after any
crash or timeout, plus the timestamp needed to distinguish a stuck reservation from an
in-flight one" the finding's fix text asked for.

**What remains genuinely out of Phase 1's reach.** The finding's second fix clause — "Phase 2
MUST treat a purchase command-timeout as indeterminate rather than as a failure: call
`hasPurchased` on the recovery path and, if true, enqueue the persistence job anyway" — is
`apps/api` request-handling logic. Phase 1 writes zero application code (§0.1) and no
`apps/**` file was touched by this remediation. This requirement is recorded here as a
**binding instruction to Phase 2**: the purchase route's command-timeout error handler MUST
NOT map directly to `UPSTREAM_UNAVAILABLE` without first calling
`hasPurchased(saleId, userId)`; if true, Phase 2 must locate the reservation via
`scanReservations` (or a targeted lookup Phase 2 adds) and enqueue its persistence job rather
than surfacing a bare 503, using the `reservationId` recorded in the hash so the enqueued job
is idempotent by `reservationId` per PRD §3.5. Phase 2's implementer and reviewer must treat
this as if it were written directly into §4 of this contract.

### 11.4 Files touched by this addendum

Additive only; no path outside the union of §2's frozen tree and this list was created:

```
packages/shared/src/keys.ts                        ~  + saleReservationsKey, SaleKeys.reservations
packages/shared/src/keys.spec.ts                    ~  + reservations assertions
packages/shared/src/index.ts                        ~  + saleReservationsKey export
packages/shared/src/index.spec.ts                   ~  updated saleKeys() expectation (5 fields)
packages/redis/src/scripts/purchase.lua.ts           ~  KEYS[4], ARGV[2], reservations HSET
packages/redis/src/scripts/compensate.lua.ts         ~  KEYS[4], ARGV[2], reservation-identity gate
packages/redis/src/scripts/reconcile.lua.ts          +  new script (§11.2)
packages/redis/src/scripts/registry.ts               ~  numKeys 3->4 (purchase/compensate), + RECONCILE_SCRIPT
packages/redis/src/scripts/run.spec.ts               ~  updated KEYS count in the non-NOSCRIPT-error case
packages/redis/src/sale-store.ts                     ~  purchase()/compensate() signatures, + reconcileStock,
                                                          scanReservations, restoreReservations; reset() DELs
                                                          the reservations key
packages/redis/src/types.ts                          ~  PurchaseResult.reservationId, + Reconcile*/Reservation* types
packages/redis/src/index.ts                          ~  export the new surface
packages/redis/src/sale-store.compensate.spec.ts      ~  reservationId threaded through T7; + finding-1 regression case
packages/redis/src/sale-store.concurrency.spec.ts     ~  + reservationId uniqueness assertions (T1)
packages/redis/src/sale-store.window.spec.ts          ~  + reservations-untouched assertions (T6)
packages/redis/src/sale-store.reconcile.spec.ts       +  new file (§11.2 proof)
```

No `apps/**` file was modified. `packages/redis` still declares no new npm dependency —
`randomUUID` is `node:crypto`, already used by `packages/redis/test/harness.ts`.
