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

**Phase 2 — API. NOT STARTED.** Next up: `SaleModule` (status/config), `PurchaseModule`
(attempt + status), `HealthModule`, global rate limiting, and integration tests
including the concurrency spec. Scope per PRD §8 and §4.

## Gate policy — READ THIS FIRST

> **⚠ CI IS DELIBERATELY OUT OF THE GATE DEFINITION — owner decision, 2026-07-22.**
>
> GitHub Actions is unavailable on this account: all 8 jobs abort at 0–4s with *"The
> job was not started because recent account payments have failed or your spending
> limit needs to be increased."* Private repos consume Actions minutes. This is a
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

| Tag | Commit | Meaning |
|---|---|---|
| `phase-0-done` | `d47314e` | Bootstrap gate passed (merged to `main` as `aee91b9`) |
| `phase-1-done` | see `git rev-parse phase-1-done^{commit}` | Domain core gate passed |

Phase branches are cut from the **previous phase's tag**, not from `main`.
Current branch: `phase-1/domain-core`.

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

## Phase 1 design decisions worth defending (README §12 material)

1. **Window enforcement (I3) lives INSIDE `purchase.lua`**, using Redis `TIME`, not in
   an API-only guard. An API-layer check has a genuine TOCTOU gap between guard and
   `EVALSHA` at 2k rps, and N pod clocks make I3 probabilistic rather than guaranteed.
   The "Redis TIME is non-deterministic" objection applied to *verbatim* replication
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
   `apps/web` imports *values* from shared, so ioredis behind that barrel would enter
   the browser bundle graph; it also isolates the Docker-requiring test surface to one
   turbo task.
5. **`@flash/shared` has two entry points** — `.` (pure, zero-dep) and `./schemas`
   (Zod) — so the web bundle pays nothing for server-side validation.

## Phase 1 review — two critical findings, both fixed with regression tests

The adversarial pass returned `approved` / `changes-required` with 2 critical + 1
major. Both criticals were design-level, exactly the kind that get expensive later:

1. **CRITICAL (I1/I2/I4) — `compensate.lua` idempotency was keyed on set membership,
   not reservation identity.** A user who compensated and then re-purchased became a
   Set member again, silently re-arming the stale DLQ compensation for their *first*
   reservation. On redelivery it would tear down a live, already-persisted order:
   stock inflated above what is truly outstanding (I1) and the user un-blocked for a
   second confirmed order (I2). **Fixed:** idempotency token is now reservation
   identity, carried in a `sale:{id}:reservations` hash written atomically by
   `purchase.lua`; a stale job whose reservationId no longer matches is a NOOP.
   Regression test: *"FINDING 1 REGRESSION — a stale, redelivered compensation for an
   EARLIER reservation must not tear down a LATER, live reservation."*
2. **CRITICAL (I4) — PRD §3.5's recovery paths were unimplementable on the frozen
   surface.** At CONFIRMED time Redis recorded only set membership — no reservation
   id, no timestamp, no pending-persistence marker — and `seed.lua` refuses to write
   whenever the config key survives, which is exactly the AOF-everysec partial-loss
   case. There was also no primitive to enumerate or rebuild the buyers set. **This
   would have made I4 unsatisfiable in Phase 3 regardless of worker quality.**
   **Fixed:** added the reservations ledger plus `reconcileStock()`,
   `scanReservations()` (HSCAN, cursor-paged), and `restoreReservations()`.
   Regression test: *"FINDING 2 REGRESSION — reproduces the warm-restart drift
   scenario: seed() cannot correct it, reconcileStock() can."*

## Open issues

1. **Contract §3.3 boundary table has one self-inconsistent row** (minor): for
   `nowMs === startsAtMs` with `stock=0` the table says `upcoming`, but §3.2's
   precedence (strict `nowMs < startsAtMs`) yields `sold_out`. Implementation and 3 of
   that row's 4 cells agree on `sold_out`; the table cell is the outlier. Fix the
   contract text in Phase 2 so it cannot mislead a later agent.
2. **API-side clock source for the I3 fast-path guard is unpinned** (minor, I3). The
   contract mandates a `deriveSaleState` fast-path but never pins where the API gets
   its clock, and `@flash/redis` exposes no primitive to learn Redis's clock offset —
   a skewed pod could reject purchases Redis would confirm. Enforcement is safe
   (Lua owns it); this is a UX/false-negative concern. **Phase 2 must pin this.**
3. **`status.lua` sentinel leaks** (minor): emits `stockRemaining = -1` when config
   exists but the stock key is gone; `SaleRedisStore` passes it through unvalidated,
   where `deriveSaleState` reads it as `sold_out`, contradicting the response schema's
   nonnegative constraint. Handle in Phase 2's status endpoint.
4. **`.claude/settings.json` hooks are partially exercised.** The main-push guard
   fired correctly and did its job. The post-edit typecheck hook has still not been
   observed firing.
5. **Skill discovery is unreliable for subagents.** Several agents found project-local
   skills absent from their Skill listing despite valid symlinks, and fell back to
   reading `.agents/skills/<name>/SKILL.md` directly. That fallback works — brief
   future agents with the explicit path as well as the skill name.
6. **`.dockerignore` correctness unverified from a cold clone** (carried from Phase 0);
   confirm image contents from a clean checkout at Phase 6.
7. **Node/pnpm pins are tight**: 22.14.x everywhere because pnpm 11.9 requires
   Node ≥22.13. Do not lower either without re-checking the other.

## Exact next actions

1. **Merge the Phase 1 PR** (opened against `main`). CI is skipped by owner decision,
   so it merges on local evidence.
2. **Have the `architect` agent (Opus) produce `.claude/contracts/phase-2.md`** before
   any implementation fan-out. Scope per PRD §4 and §8: `SaleModule` (status/config),
   `PurchaseModule` (attempt + status), `HealthModule`, global per-IP + per-user rate
   limiting, structured pino logging with request IDs, and integration tests with
   Testcontainers. The contract must resolve open issues 1–3 above, and must pin the
   API's clock source for the I3 fast-path guard.
3. **Phase 2's gate must include the concurrency spec from PRD §6.1** — N=500 parallel
   purchases for stock=10 through the *HTTP layer*, asserting exactly 10 CONFIRMED,
   490 SOLD_OUT, 10 PG rows, 10 distinct users. Reuse the T2 negative-control pattern:
   any new atomicity claim needs a control proving the test can fail.
4. **Security review (Opus) is mandatory at Phase 2** per PRD §9.3 — it is the phase
   where the untrusted HTTP surface first exists.

## Process notes

**Verification reports are claims, not evidence.** Phase 0 was reported GREEN three
times before it actually was: a build exiting 0 while emitting zero JavaScript, and a
security gate deleted rather than satisfied, both survived the implementation pass,
the remediation pass, *and* two adversarial reviews. Only independent re-execution
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
