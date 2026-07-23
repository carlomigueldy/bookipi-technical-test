# STATE.md — Build State (single source of truth)

This file is the single source of truth for "where are we." Read it in full before
resuming work — see `AGENTS.md` §3 for the resume protocol. If this file disagrees
with a commit message, chat history, or your own memory of a prior session, **this
file wins**.

Maintained by the **root orchestrator only**, and only at phase gates. Subagents must
not edit it, commit it, or create phase tags — see "Process notes" for why.

---

## Current phase

**Phase 0 — Bootstrap. CLOSED.** (tag `phase-0-done`, merged to `main` via PR #1)
**Phase 1 — Domain core. CLOSED.** (tag `phase-1-done`)

**Phase 2 — API. CLOSED.** (tag `phase-2-done`)

**Phase 3 — Worker & durability. CLOSED.** (tag `phase-3-done`)

**Phase 4 — Frontend. CLOSED.** (tag `phase-4-done`)

**Phase 5 — Stress & tuning. CLOSED.** (tag `phase-5-done`)

Qualified status: **COMPLETE — OWNER-AUTHORIZED ENVIRONMENT-LIMITED EVIDENCE BYPASS**.
The live performance run and Phase 5 live I1–I4 audit were **NOT RUN / NOT
EVALUATED** because `/usr/bin/ln` is owned by uid 65534 and therefore fails the
frozen uid 0 trust prerequisite. The owner authorized proceeding without privileged
host remediation; no performance, capacity, threshold, or live invariant claim is
made.

**Phase 6 — Ship. CLOSED.** (annotated tag `phase-6-done`; PRD delivery complete —
no next phase.)
Immutable candidate:
`5373e20a6f8bb6932e4f4fe77d58dd3559ec51e1`. The shared and fresh-clone gates,
mandatory final security review, and final architecture review are green. The
state-closing commit is the commit resolved by `phase-6-done^{commit}`.

## Gate policy — READ THIS FIRST

> **⚠ CI IS DELIBERATELY OUT OF THE GATE DEFINITION — owner decision, 2026-07-22.**
>
> GitHub Actions is unavailable on this account: all 8 jobs abort at 0–4s with _"The
> job was not started because recent account payments have failed or your spending
> limit needs to be increased."_ Private repos consume Actions minutes. This is a
> billing matter, **not** a code defect — CI correctly fired on both the branch push
> and the PR before hitting the billing wall. **No CI run has ever succeeded here.**
>
> The owner has decided to skip CI rather than block delivery. Therefore, for every
> phase: **the gate is locally-executed command evidence, run by the orchestrator with
> turbo caching bypassed (`--force`, confirming `Cached: 0 cached`).** CI green is NOT
> a gate condition and its absence must not be read as an unmet gate.
>
> `.github/workflows/ci.yml` is still maintained as a correct deliverable (PRD §6.3)
> and runs the moment billing is resolved — it is simply not load-bearing.
>
> **AGENTS.md §8/§10 caveat:** those sections describe a PR-with-green-CI flow. That
> flow is suspended. Follow the local-evidence gate above; do not wait on CI that will
> never turn green.

## Tags

| Tag            | Commit                                    | Meaning                                               |
| -------------- | ----------------------------------------- | ----------------------------------------------------- |
| `phase-0-done` | `d47314e`                                 | Bootstrap gate passed (merged to `main` as `aee91b9`) |
| `phase-1-done` | see `git rev-parse phase-1-done^{commit}` | Domain core gate passed                               |
| `phase-2-done` | see `git rev-parse phase-2-done^{commit}` | API gate passed                                       |
| `phase-3-done` | see `git rev-parse phase-3-done^{commit}` | Worker and durability gate passed                     |
| `phase-4-done` | see `git rev-parse phase-4-done^{commit}` | Frontend gate passed                                  |
| `phase-5-done` | see `git rev-parse phase-5-done^{commit}` | Qualified stress evidence gate passed                 |
| `phase-6-done` | see `git rev-parse phase-6-done^{commit}` | Evaluator-ready delivery gate passed                  |

Phase branches are cut from the **previous phase's tag**, not from `main`.
Current branch: `phase-6/ship`.

> `phase-0-done` was moved once, deliberately: it originally pointed at `76059dc`,
> which did **not** pass the gate (hollow build + vulnerable deps still present).
> If a stale clone resolves it to `76059dc`, run `git fetch --tags --force`.

## Phase 1 verification evidence

All commands re-run by the **orchestrator directly**, caching bypassed.

```
$ pnpm exec turbo run typecheck lint build test --force
 Tasks:    23 successful, 23 total
Cached:    0 cached, 23 total
GATE EXIT=0
```

**254 tests passing** — `@flash/shared` 206, `@flash/redis` 45, scaffolds 3.

**The money test (T1), against real redis:7.4 via testcontainers — never a mock:**

```
500 concurrent purchase() over 50 independent connections, stock=10, repeated 5x
  -> exactly 10 CONFIRMED, exactly 490 SOLD_OUT, 0 other outcomes, every iteration
  -> GET stock == 0, never negative                                    (I1)
  -> SCARD buyers == 10, matching the 10 confirmed userIds exactly     (I2)
  -> the 10 CONFIRMED stockRemaining values are the distinct set {0..9}
  -> HLEN reservations == 10, all reservationIds distinct and non-empty (I4)
```

**T2 — the negative control, and the reason T1 is trustworthy.** A deliberately
non-atomic `purchaseUnsafe()` (4 round trips with a yield) runs the identical
scenario and **must oversell**; the spec asserts `oversold === true`. Without it, T1
is unfalsifiable — a test that passes against a broken implementation proves nothing.
This gives the suite permanent discriminating power, not a one-off check.

A falsification check was also run and reverted: `purchase()` was temporarily replaced
with the naive sequence, T1 failed immediately (500 CONFIRMED instead of 10 — full
oversell) while T2 still passed; the revert diffed byte-identical.

**Other invariant evidence:**

```
T3  200 concurrent attempts, one userId  -> exactly 1 CONFIRMED, 199 ALREADY_PURCHASED   (I2)
T4  cold cache -> EVAL reload -> SCRIPT FLUSH -> EVAL reload again                       (availability)
T6  start boundary inclusive / end boundary EXCLUSIVE, on the server's own clock         (I3)
    SALE_NOT_STARTED and SALE_ENDED both have ZERO side effects
T7  100 concurrent compensate(), same reservation -> exactly 1 COMPENSATED, 99 NOOP,
    stock exactly back to 10, never above totalStock                                     (I1)
T8  50 concurrent seeds -> exactly 1 SEEDED, 49 ALREADY_SEEDED, stock == totalStock      (I1)
    seed -> 3 purchases (497) -> re-seed -> ALREADY_SEEDED, stock still 497
T9  never-seeded sale -> NOT_INITIALIZED, stockRemaining -1, never SOLD_OUT              (fail-closed)
```

No spec skips when Redis is unreachable — an unreachable Redis fails the suite rather
than silently passing.

## Phase 2 verification evidence

All commands were re-run by the **orchestrator directly** on 2026-07-22. Turbo
caching was bypassed and the integration task was part of the same forced graph.

```text
$ pnpm install --frozen-lockfile
Already up to date

$ pnpm format:check
All matched files use Prettier code style!

$ pnpm exec turbo run lint typecheck test build test:integration --force
Tasks:    25 successful, 25 total
Cached:   0 cached, 25 total
Time:     40.318s

$ pnpm audit --audit-level high
No known vulnerabilities found

$ node scripts/assert-build-output.mjs apps/api/dist/main.js
bookipi-technical-test: build output verified (apps/api/dist/main.js)
```

Test totals in the forced graph:

- `@flash/api` unit: **17 files, 180 tests passed**.
- `@flash/api` integration: **13 files, 72 tests passed**, real Redis 7.4 and
  Postgres 16 via Testcontainers, zero unhandled errors and zero teardown warnings.
- `@flash/shared`: **206 tests passed**; `@flash/redis`: **45 tests passed**.

Phase-specific evidence:

- Money test, three iterations: 500 concurrent real HTTP purchases at stock 10 →
  exactly **10 CONFIRMED / 490 SOLD_OUT / 0 other** each time; stock 0, 10 buyers,
  10 distinct reservations and 10 deterministic BullMQ jobs (I1/I2/I4).
- Negative control: the identical real-HTTP harness with the deliberately unsafe
  non-atomic service oversold and drove stock below zero.
- Window edges: Redis-time relations passed at start/end boundaries with zero side
  effects on rejected attempts (I3).
- Queue failure: confirmed reservations remained truthful 201s with stock, buyers,
  and reservation ledger intact; the real black-holed producer stayed bounded at one
  generation / 64 in-flight operations, cleared both counters, and emitted no
  unhandled rejection (I4 handoff to Phase 3 reconciliation).
- Lifecycle/security: bounded queue observation and shutdown watchdog passed; raw
  slow-header/body sockets were closed by finite deadlines; Redis limiter TTL healing,
  cardinality, X-Forwarded-For, CORS, request ID, headers, and error-hygiene specs passed.
- Required source greps returned zero forbidden hits. `ignoreGhsas` remains `[]`.
- Final Terra adversarial review and Sol security/final architecture review approved.

## Phase 3 verification evidence

All commands were re-run by the **orchestrator directly** on 2026-07-22. Turbo
caching was bypassed and both API and worker integration suites were part of the
same forced graph.

```text
$ pnpm install --frozen-lockfile
Already up to date

$ pnpm format:check
All matched files use Prettier code style!

$ pnpm exec turbo run lint typecheck test build test:integration --force
Tasks:    25 successful, 25 total
Cached:   0 cached, 25 total

$ pnpm audit --audit-level high
No known vulnerabilities found
```

Test totals in the forced graph:

- Unit: **44 files, 591 tests passed**.
- Integration: **14 files, 94 tests passed** — `@flash/worker` **22** and
  `@flash/api` **72**, all against real Redis 7.4 and Postgres 16 via
  Testcontainers.

Phase-specific evidence:

- Both API and worker build artifacts passed `scripts/assert-build-output.mjs`;
  Compose config rendered successfully; `git diff --check` and all contract source
  scans were clean.
- The datastore fail probe proved integration tests fail rather than skip when their
  real Redis/Postgres prerequisites are unavailable. The final run had zero skipped
  datastore tests and zero unhandled errors.
- **A1:** purchase-status persisted/compensated fixtures matched the final durable
  schema and the API integration suite remained green.
- **A2:** max-stalled terminal resolution worked with `attemptsMade < 5`; 200
  concurrent stale-R1 CAS conflicts left live R2 byte-identical; bounded DLQ pages
  resolved valid tail jobs behind malformed heads; the identical unsafe advisory-lock
  negative control produced the forbidden state while production serialization did
  not; built-worker SIGTERM and watchdog/resource proofs passed.
- **A3:** retained malformed failed heads no longer blocked startup or fair traversal;
  the R1-persisted/R2-live collision path compensated R2 exactly once, preserved PG
  R1, restored Redis R1, and derived stock exactly once while readiness stayed
  degraded for malformed internal work.
- **A4:** the built P1 active-job crash and built P2 paused-queue restart recovered the
  orphan before boot diff/consumer resume, persisted exactly one row, reached ready
  only after safe resume, and shut down with no active work or leaked resources.
- **A5:** the reconciliation session fence excluded competing boot diffs through the
  ready transition; unexpected consumer resolve/reject forced readiness 503 and exit
  1; cancellation during orphan recovery released the fence/resources and a later
  process reclaimed the reservation exactly once.
- **A6:** the minimum legal PG pool size 2 completed fenced boot and persistence;
  production pool size 1 failed before health/resource creation; abort plus unlock
  failure remained an aggregate through shutdown and exit 1, while exact pure abort
  alone closed cleanly with exit 0.
- Final Terra adversarial review: **APPROVE**. Final Sol architecture review:
  **APPROVE**.
- Final cleanup confirmed no Phase 3 Testcontainers, Docker containers, or worker/API
  processes remained running.

## Phase 4 verification evidence

All commands were re-run by the **orchestrator directly** on 2026-07-23. The frozen
install was unchanged, Turbo caching was bypassed, and the browser suite exercised
the committed production build through Vite preview rather than the source-mode dev
graph.

```text
$ pnpm install --frozen-lockfile
Already up to date

$ pnpm format:check
All matched files use Prettier code style!

$ pnpm exec turbo run lint typecheck test build test:integration --force
Tasks:    25 successful, 25 total
Cached:   0 cached, 25 total

$ pnpm --filter @flash/web test:e2e
28 passed (desktop-chromium and mobile-chromium)

$ pnpm audit --audit-level high
No known vulnerabilities found
```

Test totals in the forced graph:

- Unit: **712 tests passed** — `@flash/web` **122**, `@flash/shared` **232**,
  `@flash/redis` **70**, `@flash/api` **181**, and `@flash/worker` **107**.
- Integration: **94 tests passed** — `@flash/api` **72** and `@flash/worker`
  **22**, against real Redis 7.4 and Postgres 16 via Testcontainers.
- Browser: **28/28 Playwright tests passed** across the desktop and mobile Chromium
  projects, with no retries or skips; **8/8 axe scans** and **2/2 visual comparisons**
  passed.

Phase-specific evidence:

- The responsive Aurora SPA reproduces the read-only prototype's product story,
  acquisition console, server-time countdown, truthful supply meter, buyer and
  reservation-status flows, protocol strip, API-backed ops ledger, and footer. The
  browser checks found no horizontal overflow, page errors, console errors, or failed
  same-app asset requests in the committed production-preview build.
- Purchase representation remains fail-safe: no optimistic stock decrement, duplicate
  submission, automatic POST retry, fabricated confirmation, stale status overwrite,
  raw error leak, or compensated-as-purchased state. Exact HTTP 201 plus a valid
  `CONFIRMED` envelope is the only success path; transport ambiguity remains
  check-status-first.
- All four named upcoming/active/sold-out/ended surfaces passed serious/critical axe
  scans in both viewports. Keyboard focus, validation association, reduced motion,
  200% zoom, mobile overflow, and the adversarial boundary/lifecycle cases were clean.
- Visual baselines passed unchanged with SHA-256 hashes
  `fe0720268a15d3fc484de3e5a2ca623e12c4d6b201d2e057b50bb15782ff67a3`
  (desktop) and
  `4dfabc79bc8c116acacbfe55f6610447382cd5ffddfcffd52148c95eb5e8f9ee`
  (mobile).
- Web lint, typecheck, unit tests, and production build passed independently. Build
  artifact assertions, Compose rendering, dependency audit, formatting, diff checks,
  contract path/source scans, and the scheduler bare-import scan were clean.
- The final adversarial review returned **APPROVE**. The only remaining frontend
  observation is the accepted medium issue recorded below; it is non-blocking and
  does not weaken I1–I4.

## Phase 5 verification evidence

Qualified status: **COMPLETE — OWNER-AUTHORIZED ENVIRONMENT-LIMITED EVIDENCE
BYPASS**.

The frozen install and format checks passed. The final independently inspected
evidence on 2026-07-23 was:

```text
$ pnpm --filter @flash/load exec vitest run audit.spec.ts -t "A14"
Test Files  1 passed (1)
Tests       8 passed | 62 skipped (70)

$ pnpm exec turbo run lint typecheck test build test:integration --force
Tasks:    28 successful, 28 total
Cached:   0 cached, 28 total

$ pnpm audit --audit-level high
No known vulnerabilities found

$ sha256sum -c load/results/phase-5-results.sha256
load/results/phase-5-results.md: OK
```

Test totals in the forced graph:

- Unit: `@flash/load` **112**, `@flash/api` **181**, `@flash/worker` **115**,
  `@flash/redis` **78**, `@flash/shared` **232**, and `@flash/web` **122**.
- Integration: `@flash/api` **72** and `@flash/worker` **23**.
- Overall: **66 files / 935 tests passed** across the uncached graph.

Phase-specific disposition:

- A14 focused security coverage passed **8/8**; the full `@flash/load` suite passed
  **112/112**.
- The deterministic implementation digest was stable twice at
  `0388fd0a4a12ef2b032c95701aee1bd4ea605b60bcbdce5768ace714218ddbb8`.
- The qualified results artifact digest is
  `b8cea1aad39020b430f44b405bf2971f65f18ed8c014a3ae9f88e67bd54b5081`
  after the gate's mechanical trailing-whitespace cleanup; the reviewed pre-cleanup
  artifact digest was
  `fefff2bff5616fc4c1bdb880a3f114ecea8b077b419cbd36ba24261c4d48d3a4`.
- Dependency audit, both Compose renders, build outputs, formatting, static checks,
  and `git diff --check` were clean.
- The final defensive review returned **APPROVE**.
- No `baseline-20260723-a5` artifact exists.
- The live performance run and Phase 5 live I1–I4 audit were **NOT RUN / NOT
  EVALUATED**. `/usr/bin/ln` is a regular mode-0755 executable owned by uid 65534,
  which fails the frozen root-owned uid 0 helper prerequisite. Privileged remediation
  was owner-declined, so tuning was not eligible and no live performance or invariant
  verdict was published.

## Phase 6 verification evidence

Phase 6 closed from the verified immutable ship candidate. Candidate and publication
identities:

```text
candidate commit: 5373e20a6f8bb6932e4f4fe77d58dd3559ec51e1
state-closing commit: see git rev-parse phase-6-done^{commit}
annotated phase-6-done tag: resolves to the state-closing commit above
branch: phase-6/ship
```

All shared-checkout and disposable fresh-clone evidence below is bound to that exact
candidate. No stress workload ran, and the one-user production-stack smoke is not a
performance, capacity, latency-threshold, or Phase 5 live I1–I4 audit result.

### Shared and fresh-clone gates

Both the shared checkout and a local `--no-hardlinks` disposable clone detached at
the exact candidate passed independently:

```text
pnpm install --frozen-lockfile: passed
pnpm format:check: passed
forced Turbo graph: 28 successful, 28 total
Turbo cache: 0 cached, 28 total
Playwright: 28/28 passed across desktop and mobile Chromium
dependency audit: no known vulnerabilities
A14 focused security suite: 8/8 passed
API, worker, shared, and web build assertions: passed
ordinary and load Compose renders: passed
load/results/phase-5-results.md: OK
```

The forced graph included API integration **72/72**, including three real-HTTP
iterations of exactly **10 CONFIRMED / 490 SOLD_OUT**, and worker failure-mode
integration **23/23**. The clone started clean at the exact candidate with no
`.codex/` or `.env`; the shared checkout remained at the exact candidate with only
the pre-existing, untracked, untouched `.codex/`.

Fresh-clone provenance:

```text
Node: v22.22.1
pnpm: 11.9.0
Docker: Docker version 29.5.3, build d1c06ef
Docker Compose: Docker Compose version v5.1.4
```

The disposable path was created from the validated
`/tmp/bookipi-phase6-fresh.XXXXXX` template and removed during guaranteed cleanup;
it is provenance, not a reusable artifact.

### A3 supply-chain, build, and image proof

The uncached API build-stage inspection passed at candidate tag
`bookipi-phase6-context:5373e20a6f8b`. Its log showed the checksum-fixed pnpm
tarball SHA-256
`2b567aa66026238078ac2e0a33bec3febd60e962987aac697456f3180819b287`
and the executed version assertion `test 11.9.0 = 11.9.0`. Inspection image ID:
`sha256:c2ae8e2b3744731ef4ca5c2614c1011eb06776bb8fdab5531da26579f8f3d96f`.

The build context excluded `.env`, `.env.production`, `.codex`, `.git`, the host
`node_modules` sentinel, and the raw-results sentinel. The build stage contained the
Redis workspace manifest and nonempty API output. All three production images then
built without cache, and Compose started all five services healthy with `--no-build`
and a bounded 180-second wait.

A3 provenance and containment checks passed:

- ordinary Redis and Postgres rendered `HostIp` as `127.0.0.1`;
- Redis resolved to OCI index digest
  `sha256:6ab0b6e7381779332f97b8ca76193e45b0756f38d4c0dcda72dbb3c32061ab99`;
- Postgres resolved to OCI index digest
  `sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777`;
- the k6 remote index was
  `sha256:4fd3a694926b064d3491d9b02b01cde886583c4931f1223816e3d9a7bdfa7e0f`;
- all reviewed runtime, service, and k6 references were multi-platform OCI index
  digest pins;
- all environment variants except `.env.example` were excluded from Git and Docker
  contexts.

Runtime image IDs and content assertions:

```text
API:    sha256:818b00c91b5c0f037719f42fe42eb91a7232d9c49f0db19ce066b62cbbf84cc1
worker: sha256:f17bb8cf97194c8d10d2d2123d96c98c876f3fdc6c50716d77052f05079c8026
web:    sha256:288f4396b565a6f697901c204d78170246a16422aa8cb52acc349d71777af3ea
```

API and worker ran as `node`, contained exactly `dist`, `node_modules`, and
`package.json` under `/app`, and had no source or protected documentation/state.
The web image contained only the required built static assets, with no TypeScript
or source maps. Runtime environment, history, secret, URL-whitelist, active-content,
and sentinel checks were clean.

### Fresh-clone production invariant flow

The production stack used sale
`phase6-5373e20a6f8b-20260723082341`, active stock **3/3**, and user
`phase6-fresh-user`:

- first real HTTP purchase returned **201 CONFIRMED**, with remaining stock **2**;
- status polling returned `purchased: true` and `order.status: persisted`;
- the identical second purchase returned **409 ALREADY_PURCHASED**, never 201;
- final sale status remained active at exactly **2/3** stock;
- Redis reported stock **2**, buyer membership **1**, and the reservation ledger
  entry present;
- Postgres contained exactly one persisted order, zero duplicate user groups, and
  the `orders_user_id_uniq` index;
- API and worker readiness remained HTTP 200.

This proves candidate-bound one-reservation functional continuity across I1–I4. It
does not replace the real-Redis concurrency, exact-window, or worker failure-mode
suites and does not repair or reclassify the Phase 5 evidence limitation.

### Cleanup and reviews

Four proof-created anonymous volumes passed every frozen provenance predicate and
were removed individually without force. The disposable clone, exact inspection
image, Compose project, and proof-created resources were removed. Before/after
byte-sorted sets were identical:

```text
containers: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
networks:   ed14fca61c265101fd5bea5b50d93225126a2c3720f978317cb2382b41badea3
volumes:    22ca1793f260d00b9419b179c8edbd1444f3f8a6c7a38e57565dc85c78a27cc9
images:     0595269d630cd0156e91e6c82549f20f030b4352dc35b3a6e51da5b94dc4018c
target ports: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
```

No proof process remained on ports 3000, 3001, 5173, 5433, or 6380. The shared
checkout stayed clean except for the untouched `.codex/`.

The final Phase 6 security reviewer approved the exact candidate with the frozen A3
wording:

> APPROVE — Phase 6 ship surface preserves I1–I4; ordinary datastore ports are
> loopback-only; all environment variants except .env.example are excluded from Git
> and Docker contexts; runtime, service, and k6 images are pinned to reviewed
> multi-platform OCI index digests; the pnpm bootstrap is checksum-fixed and
> version-checked; and production datastore isolation, Postgres secret credentials,
> and Redis ACL/TLS requirements are disclosed without claiming local enforcement.

The final Phase 6 architect approved the exact candidate, evidence, security
approval, and this ledger disclosure with the frozen wording:

> APPROVE — Phase 6 is evaluator-ready: the README and diagrams describe the
> shipped interfaces and failure model, the committed candidate passed uncached and
> fresh-clone production proofs with complete cleanup, Phase 5 remains truthfully
> qualified, and no PRD deliverable or I1–I4 obligation is silently omitted.

## Phase 1 design decisions worth defending (README §12 material)

1. **Window enforcement (I3) lives INSIDE `purchase.lua`**, using Redis `TIME`, not in
   an API-only guard. An API-layer check has a genuine TOCTOU gap between guard and
   `EVALSHA` at 2k rps, and N pod clocks make I3 probabilistic rather than guaranteed.
   The "Redis TIME is non-deterministic" objection applied to _verbatim_ replication
   (Redis ≤4); Redis 5+ replicates by effects and Phase 0 pins Redis 7.4. The API
   guard remains as a fast-path optimization only.
2. **State is DERIVED, never stored** — `deriveSaleState()` is a pure function of
   (nowMs, window, stockRemaining) with time injected, which is what makes
   exact-millisecond boundary testing possible. It is **advisory only and explicitly
   NOT the I3 enforcement point**.
3. **`ioredis-mock` is banned** for atomicity specs, superseding PRD §6.1's mention. A
   mock would pass against a 3-round-trip `GET`/`DECR`/`SADD` implementation — zero
   discriminating power. Atomicity is only provable against real Redis.
4. **Redis lives in its own package `@flash/redis`**, not in `@flash/shared`.
   `apps/web` imports _values_ from shared, so ioredis behind that barrel would enter
   the browser bundle graph; it also isolates the Docker-requiring test surface to one
   turbo task.
5. **`@flash/shared` has two entry points** — `.` (pure, zero-dep) and `./schemas`
   (Zod) — so the web bundle pays nothing for server-side validation.

## Phase 1 review — two critical findings, both fixed with regression tests

The adversarial pass returned `approved` / `changes-required` with 2 critical + 1
major. Both criticals were design-level, exactly the kind that get expensive later:

1. **CRITICAL (I1/I2/I4) — `compensate.lua` idempotency was keyed on set membership,
   not reservation identity.** A user who compensated and then re-purchased became a
   Set member again, silently re-arming the stale DLQ compensation for their _first_
   reservation. On redelivery it would tear down a live, already-persisted order:
   stock inflated above what is truly outstanding (I1) and the user un-blocked for a
   second confirmed order (I2). **Fixed:** idempotency token is now reservation
   identity, carried in a `sale:{id}:reservations` hash written atomically by
   `purchase.lua`; a stale job whose reservationId no longer matches is a NOOP.
   Regression test: _"FINDING 1 REGRESSION — a stale, redelivered compensation for an
   EARLIER reservation must not tear down a LATER, live reservation."_
2. **CRITICAL (I4) — PRD §3.5's recovery paths were unimplementable on the frozen
   surface.** At CONFIRMED time Redis recorded only set membership — no reservation
   id, no timestamp, no pending-persistence marker — and `seed.lua` refuses to write
   whenever the config key survives, which is exactly the AOF-everysec partial-loss
   case. There was also no primitive to enumerate or rebuild the buyers set. **This
   would have made I4 unsatisfiable in Phase 3 regardless of worker quality.**
   **Fixed:** added the reservations ledger plus `reconcileStock()`,
   `scanReservations()` (HSCAN, cursor-paged), and `restoreReservations()`.
   Regression test: _"FINDING 2 REGRESSION — reproduces the warm-restart drift
   scenario: seed() cannot correct it, reconcileStock() can."_

## Open issues and accepted risks

1. **Identity is client-asserted by PRD scope.** Entitlement theft and per-candidate
   buyer probing remain possible without authentication. `README.md` documents the
   production requirement: derive `userId` from an authenticated principal.
2. **Readiness and metrics are public aggregate ops surfaces.** Accepted for this local
   take-home and required ops panel; a production deployment must put them behind an
   internal listener or authenticated gateway.
3. **Rate limiting deliberately fails open.** I1–I4 remain independently enforced by
   Redis Lua/Postgres. Production still needs network-layer flood protection.
4. **Single-sale assumptions are binding.** `orders_user_id_uniq` and the status lookup
   are global by `user_id`. Multi-sale support must add sale scoping everywhere as a
   contract/schema migration.
5. **Malformed internal queue data is retained and degrades readiness.** There is no
   public injection path, but an operator-corrupted entry may repeat bounded error logs
   until repaired. This is accepted and non-blocking because fail-closed retention is
   required for I4; production should alert and rate-limit duplicate log emission.
6. **Production images and build-context exclusion are now cold-clone verified.**
   The remaining production requirement is operational: use private, unpublished
   datastores, secret-managed non-default Postgres credentials, and Redis ACL/TLS.
   The loopback-only local Compose defaults are development conveniences, not
   production authentication.
7. **Node/pnpm pins remain tight:** Node 22.14.x and pnpm 11.9.x. Do not lower either
   without checking the other. NodeNext now requires runtime dependencies to expose a
   CommonJS `require` condition; see Phase 2 Amendment A1.
8. **CI remains unavailable by owner decision** because of GitHub Actions billing. The
   local uncached gate above is the authoritative evidence until billing is restored.
9. **A forced ops refresh during an active ops poll is coalesced until the next
   scheduled poll.** The action remains bounded and non-overlapping, retains the last
   good values, and does not affect purchase or invariant enforcement. This is an
   accepted non-blocking medium frontend responsiveness risk for Phase 4.
10. **Phase 5 live stress and its post-run I1–I4 audit were not executed on the
    delivery host.** `/usr/bin/ln` is owned by uid 65534 rather than the frozen
    required uid 0, and the owner authorized an environment-limited evidence bypass
    instead of privileged host remediation. Phase 5 therefore makes no live
    performance, capacity, threshold, or invariant claim.

## Exact next actions

None — PRD delivery is complete. An optional compliant-host stress rerun requires a
new architect-declared run ID and a versioned results amendment; it must not rewrite
the qualified Phase 5 record.

## Process notes

**Verification reports are claims, not evidence.** Phase 0 was reported GREEN three
times before it actually was: a build exiting 0 while emitting zero JavaScript, and a
security gate deleted rather than satisfied, both survived the implementation pass,
the remediation pass, _and_ two adversarial reviews. Only independent re-execution
caught them. The orchestrator re-runs every gate command itself, with caching
bypassed, before tagging. Phase 1 was verified this way.

**Subagents must not tag or edit STATE.md.** During Phase 0 a subagent created
`phase-0-done` on a tree that did not pass, and wrote a STATE.md asserting it. Both
are orchestrator-owned per PRD §9.1. If the agent that wrote the code also certifies
it, the checkpoint records belief rather than verified reality — which is precisely
how a broken tree became a "valid" resume point.

**Negative controls are now expected practice.** T2 exists because an atomicity test
that cannot fail proves nothing. Any future concurrency or atomicity claim should ship
with a control demonstrating the harness detects the violation.

## Changelog

- **`phase-6-done` — Phase 6 evaluator-ready delivery gate.** Candidate
  `5373e20a6f8bb6932e4f4fe77d58dd3559ec51e1` ships the complete evaluator README and
  diagram, minimal production images, environment containment, loopback datastore
  publication, reviewed digest pins, and checksum-fixed pnpm bootstrap. Shared and
  fresh-clone gates each passed 28/28 uncached Turbo tasks and Playwright 28/28;
  A14 8/8, audit, Compose, build output, checksum, runtime-image, one-reservation
  persistence/duplicate/stock, and byte-equal cleanup proofs passed. Final security
  and architecture reviews approved. The annotated tag resolves to this ledger's
  state-closing commit; PRD delivery is complete with no next phase.
- **`phase-5-done`** — Qualified Phase 5 stress harness and invariant-audit delivery.
  The isolated k6 scenarios, deterministic runner, secure descriptor-only audit
  publication, CI smoke path, Redis inspection support, and worker reconciliation
  hardening passed A14 8/8, the full load suite 112/112, and the 28/28 uncached root
  graph with 66 files / 935 tests. Dependency audit, Compose, build, format, static,
  diff, digests, and final defensive review were clean. Qualified status:
  **COMPLETE — OWNER-AUTHORIZED ENVIRONMENT-LIMITED EVIDENCE BYPASS**. Live
  performance and Phase 5 live I1–I4 were **NOT RUN / NOT EVALUATED** because the
  host's uid-65534 `/usr/bin/ln` fails the frozen uid 0 trust prerequisite.
- **`phase-4-done`** — Responsive accessible Aurora flash-sale SPA. The frontend now
  provides server-time sale state/countdown, exact stock presentation, a fail-safe
  one-shot purchase flow, correlated reservation lookup, bounded generation-safe sale
  and ops polling, API-backed readiness/metrics, and the prototype's titanium-card
  visual signature without demo mutation controls. Final gate: 25/25 forced Turbo
  tasks with zero cache hits; 712 unit, 94 integration, and 28 browser tests; 8 axe
  scans and 2 visual comparisons; audit, Compose, artifacts, formatting, scans, and
  adversarial review all green. Amendments A1–A5.1 close strict lifecycle ownership,
  pnpm/Vite production resolution, visual determinism, sale boundary/error recovery,
  exact purchase protocol handling, status correlation, and TSX spec discovery.
- **`phase-3-done`** — Worker durability and recovery. Shared BullMQ contracts,
  reservation-identity Postgres persistence, advisory-lock conflict adjudication,
  identity-safe DLQ compensation, bounded fair reconciliation, paused-queue orphan
  recovery, fenced ready transitions, fatal consumer supervision, and lossless
  cancellation cleanup. Amendments A1–A6 close fixture alignment, terminality/CAS,
  malformed-head fairness and job-ID collisions, active-orphan restart, lifecycle
  fencing, and minimum PG capacity/error precedence. Final gate: 25/25 forced Turbo
  tasks with zero cache hits; 591 unit and 94 integration tests; audit, Compose,
  artifacts, scans, datastore fail probe, adversarial review, and final architecture
  review all green.
- **`phase-2-done`** — API. NestJS/Fastify sale, purchase, status, metrics,
  liveness/readiness, Redis-backed IP/user rate limiting, structured error envelopes,
  request IDs, security headers/CORS, Redis-anchored clock, and bounded BullMQ producer.
  The real HTTP integration harness covers exact response schemas, production limits,
  raw slow-client deadlines, queue/Redis/Postgres outages, bounded shutdown, and a
  falsifiable 500-request concurrency proof. Final gate: 25/25 forced Turbo tasks with
  zero cache hits; 180 API units and 72 integrations; audit clean; Terra adversarial,
  Sol security, and Sol final architecture reviews approved. Amendments A1–A4.2 record
  NodeNext resolution, total response messages, lifecycle ownership, finite security
  controls, and executable BullMQ job IDs.
- **`phase-1-done`** — Domain core. `@flash/shared`: derived sale state machine with
  exact-millisecond half-open `[startsAt, endsAt)` semantics, Zod DTO/validation
  schemas (dual entry points), key builders with cluster hash-tag assertions, and the
  shared outcome→HTTP taxonomy (`satisfies Record<AttemptOutcome, number>` so an
  unmapped outcome is a compile error). New `@flash/redis`: 5 Lua scripts (purchase,
  compensate, seed, status, reconcile) with `EVALSHA`→`NOSCRIPT`→`EVAL` fallback,
  client-side SHA1, idempotent seeding, reservation-identity-keyed compensation, and
  the I4 boot-sweep primitives. 254 tests, atomicity proven against real Redis with a
  negative control. Fixed 2 critical review findings (compensation identity; I4
  recoverability), each with a named regression test.
- **`phase-0-done`** (`d47314e`, merged as `aee91b9`) — Bootstrap. Monorepo, tooling,
  compose stack, CI, agent harness. Escalation fixed a hollow build (removed
  `incremental` from the tsconfig preset; added `scripts/assert-build-output.mjs`),
  upgraded NestJS 10→11 / Fastify 4→5 closing 2 critical + 12 high advisories
  including middleware auth bypass and body-validation bypass, restored the deleted
  audit gate, and unblocked Docker (corepack keys, Node 22.14, `pnpm deploy --legacy`).
- **`2fa9ee4`** — PRD and approved high-fidelity prototype.
