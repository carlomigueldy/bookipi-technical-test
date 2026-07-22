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

**Phase 5 — Stress & tuning. NOT STARTED.** Next up: freeze the Phase 5 contract,
implement the k6 stress scenarios and invariant audit, tune against measured results,
and publish the results table.

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

Phase branches are cut from the **previous phase's tag**, not from `main`.
Current branch: `phase-4/frontend`.

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
6. **`.dockerignore` correctness remains unverified from a cold clone** (carried from
   Phase 0); confirm image contents at Phase 6.
7. **Node/pnpm pins remain tight:** Node 22.14.x and pnpm 11.9.x. Do not lower either
   without checking the other. NodeNext now requires runtime dependencies to expose a
   CommonJS `require` condition; see Phase 2 Amendment A1.
8. **CI remains unavailable by owner decision** because of GitHub Actions billing. The
   local uncached gate above is the authoritative evidence until billing is restored.
9. **A forced ops refresh during an active ops poll is coalesced until the next
   scheduled poll.** The action remains bounded and non-overlapping, retains the last
   good values, and does not affect purchase or invariant enforcement. This is an
   accepted non-blocking medium frontend responsiveness risk for Phase 4.

## Exact next actions

1. Have the Sol-mapped `architect` produce and freeze
   `.claude/contracts/phase-5.md`. Do not begin stress implementation before the
   contract fixes the scenarios, thresholds, audit semantics, and evidence format.
2. Dispatch Phase 5 implementation to the k6 specialist/general implementer with the
   project-local `k6`, Redis, and PostgreSQL skills loaded before editing.
3. Implement the required surge, duplicate-buyer, sold-out, and window-edge stress
   scenarios; add the post-run Redis/Postgres I1/I2 audit; tune only from measured
   bottlenecks; and produce the contract-required results table.
4. Run the canonical local forced graph plus the Phase 5 stress gate and invariant
   audit, complete adversarial review, then have the orchestrator commit, create the
   annotated `phase-5-done` tag, and update this file.

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
