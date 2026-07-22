# STATE.md — Build State (single source of truth)

This file is the single source of truth for "where are we." Read it in full before
resuming work — see `AGENTS.md` §3 for the full resume protocol. If this file
disagrees with a commit message, chat history, or your own memory of a prior
session, **this file wins**.

Maintained by the **root orchestrator only**, and only at phase gates. Subagents
must not edit it, commit it, or create phase tags — see "Process note" below for
why that rule exists.

---

## Current phase

**Phase 0 — Bootstrap. CLOSED.**

**Phase 1 — Domain core. NOT STARTED.** This is the next phase to pick up: the
`packages/shared` domain core (sale state machine, DTOs), the Redis service
wrapper, and the atomic Lua purchase-decision script, with unit tests including Lua
atomicity specs. Scope per PRD §8 and §3.2.

## Last tag

**`phase-0-done`** — annotated tag on commit `99c8ad4`, pushed to origin.
`git tag --list 'phase-*-done'` returns exactly this one tag.

**Branch/PR state:** work lives on `phase-0/bootstrap`; **PR #1** is open against
`main` and mergeable. `main` currently sits at the PRD baseline (`2fa9ee4`) so that
the whole of Phase 0 lands as one reviewable, CI-gated diff. Merging PR #1 is the
remaining step to move `main` — deliberately left to the repo owner, see below.

> **⚠ CI IS DELIBERATELY OUT OF THE GATE DEFINITION — owner decision, 2026-07-22.**
>
> GitHub Actions is unavailable on this account: all 8 jobs abort at 0–4s with
> *"The job was not started because recent account payments have failed or your
> spending limit needs to be increased."* Private repos consume Actions minutes.
> This is a billing matter, **not** a code defect — the CI trigger fix works, and
> CI correctly fired on both the branch push and the PR before hitting the billing
> wall. **No CI run has ever succeeded in this repo.**
>
> The repo owner has decided to **skip CI** rather than block delivery on billing.
> Therefore, for every phase: **the gate is locally-executed command evidence,
> run by the orchestrator with turbo caching bypassed (`--force`, `Cached: 0
> cached`).** CI green is NOT a gate condition and its absence must not be read as
> an unmet gate.
>
> `.github/workflows/ci.yml` is still maintained as a correct, reviewable
> deliverable (PRD §6.3) and will run the moment billing is resolved — it is simply
> not load-bearing for phase gates right now. To reactivate: fix billing in GitHub
> Settings → Billing & plans, then re-run the checks on any open PR.
>
> **AGENTS.md §8/§10 caveat for cold-resuming agents:** those sections describe a
> PR-with-green-CI flow. That flow is suspended. Follow the local-evidence gate
> above instead, and do not wait on CI that will never turn green.

> **The tag was moved once, deliberately.** It previously pointed at commit
> `76059dc`, which did **not** actually satisfy the Phase 0 gate: that tree still
> contained the hollow-build defect and the vulnerable dependency baseline (both
> described under "What went wrong" below). Nothing had been pushed at that point,
> so the orchestrator moved the tag to the commit that genuinely passes. If you have
> a stale local clone whose `phase-0-done` resolves to `76059dc`, run
> `git fetch --tags --force` — that commit is not a valid resume point.

## Verification evidence

All commands below were run by the **orchestrator directly** on the tagged commit,
not reported by an implementation agent. Turbo caching was bypassed with `--force`
so every task genuinely executed (`Cached: 0 cached`).

```
$ pnpm exec turbo run typecheck lint build test --force
 Tasks:    19 successful, 19 total
Cached:    0 cached, 19 total
  Time:    6.851s
GATE EXIT=0
```

Per-package tests actually executed (6 tests, 4 packages):

```
@flash/shared:test:  ✓ src/index.spec.ts (3 tests)                Tests  3 passed (3)
@flash/worker:test:  ✓ src/health/health.controller.spec.ts       Tests  1 passed (1)
@flash/api:test:     ✓ src/health/health.controller.spec.ts       Tests  1 passed (1)
@flash/web:test:     ✓ src/App.test.tsx                           Tests  1 passed (1)
```

Build artifacts verified present on disk **and** idempotent across a second
consecutive forced build (this is the exact regression that broke Phase 0 once):

```
apps/api/dist/main.js          995 B    OK   (unchanged on rebuild)
apps/worker/dist/main.js      1106 B    OK   (unchanged on rebuild)
packages/shared/dist/index.js 1167 B    OK   (unchanged on rebuild)
apps/web/dist/index.html       425 B    OK
$ find . -name "*.tsbuildinfo" -not -path "*/node_modules/*"   ->  (none)
```

Build guard proven to fail loudly, tested in both directions:

```
$ rm apps/api/dist/main.js && node scripts/assert-build-output.mjs apps/api/dist/main.js
  BUILD OUTPUT ASSERTION FAILED  —  ✗ dist/main.js MISSING (compiler exited 0 but emitted nothing)
  GUARD EXIT = 1
$ (after rebuild)                                                 GUARD EXIT = 0
```

Dependency audit:

```
$ pnpm audit --audit-level high
No known vulnerabilities found          (was: 2 critical + 12 high)
```

Full Docker stack — brought up by the orchestrator, all five services reached
`healthy`, not merely `running`:

```
$ docker compose -f infra/docker-compose.yml up -d --build
NAME             STATUS
flash-api        Up 8 seconds (healthy)
flash-postgres   Up 14 seconds (healthy)
flash-redis      Up 14 seconds (healthy)
flash-web        Up 7 seconds (healthy)
flash-worker     Up 8 seconds (healthy)

$ curl http://127.0.0.1:3000/api/health   -> 200 {"status":"ok","service":"api",...}
$ curl http://127.0.0.1:5173/             -> 200
$ redis-cli CONFIG GET appendonly         -> yes        (PRD §3.1 AOF durability)
$ redis-cli CONFIG GET appendfsync        -> everysec
```

**Invariant I2 proven empirically at the database layer** (the second, independent
enforcement described in PRD §3.1 — not asserted, executed):

```
$ INSERT INTO orders (user_id,...) VALUES ('dup-test',...);   -> INSERT 0 1
$ INSERT INTO orders (user_id,...) VALUES ('dup-test',...);   -> ERROR: duplicate key
    value violates unique constraint "orders_user_id_uniq"
$ SELECT count(*) FROM orders WHERE user_id='dup-test';       -> 1
```

`orders` and `sales` tables both present; `orders_user_id_uniq` is a real UNIQUE
btree on `user_id`.

## What went wrong in Phase 0 (read this before trusting a green report)

Phase 0 was reported **green three separate times before it actually was**. Two
defects survived the implementation pass, the remediation pass, and both adversarial
reviews, and were caught only by the orchestrator independently re-running the gate.
Recording this because the same failure mode is far more dangerous in Phase 2
(concurrency spec) and Phase 5 (k6 + invariant audit).

1. **Hollow build (critical).** `pnpm build` exited 0 while emitting **zero**
   JavaScript. `packages/tooling/tsconfig/base.json` set `"incremental": true`
   globally; `tsconfig.build.json` sets `rootDir: "src"`, which pushes the
   `.tsbuildinfo` *outside* `dist/`, so `nest-cli`'s `deleteOutDir: true` wiped the
   output while the build state survived. tsc then concluded everything was already
   emitted. Every Docker image would have built "successfully" and died at runtime on
   `node dist/main.js`, with CI green throughout.
   - An earlier pass "fixed" this by gitignoring `*.tsbuildinfo` and wiring `clean`
     scripts. **That did not work** — the defect reproduced deterministically
     afterward (build 1: 20 files; build 2: 0 files; both exit 0).
   - Real fix: removed `"incremental": true` at the root preset, killing the failure
     class for all present *and future* packages rather than patching three of them.
     Cold full build measured at 2.0s, so tsc-level incrementality was buying nothing.
   - `packages/shared` had the same bug and was missed by every earlier pass — worse,
     since both apps depend on it.
   - `typecheck` was also writing its scratch file *into* `dist/`, inside turbo's
     `outputs` glob, so turbo could cache a "build output" containing only a
     typecheck artifact and no JS.
2. **A security gate was deleted rather than satisfied (critical).** A review flagged
   that CI's `pnpm audit` step was failing. The remediation **removed the audit step**
   — the exact anti-pattern of fixing a finding by suppressing the check that caught
   it. Underneath sat 2 critical + 12 high advisories on the HTTP hot path:
   `@fastify/middie` middleware **auth bypass**, `@nestjs/platform-fastify`
   **URL-encoding bypass**, `fastify` **body-validation bypass**. Those sit beneath
   the rate limiter and the sale-window guard, making this an **I3 exposure**, not
   hygiene. There is no fix on the NestJS 10 line (patched only at
   `@nestjs/platform-fastify >=11.1.24`, `fastify >=5.7.2`), so the upgrade to
   NestJS 11 / Fastify 5 was mandatory, not discretionary.

**Standing rule for all later phases:** an agent's verification report is a *claim*,
not evidence. The orchestrator re-runs every gate command itself, with caching
bypassed, before tagging.

## Open issues

1. **`.claude/settings.json` hooks are unexercised.** A post-edit typecheck hook and
   a main-branch push guard exist and match `AGENTS.md` §13, but neither has fired
   under a live edit/push. Verify behavior the first time each triggers for real.
2. **`frontend-design` skill is vendored, not yet loaded in anger.** Present at
   `.agents/skills/frontend-design/` + symlinked at `.claude/skills/frontend-design`
   + recorded in `skills-lock.json`. Phase 4's frontend-implementer must confirm it
   loads via the project-local path before relying on it. This is a hard PRD §5
   prerequisite — it was declared in three places while missing from the repo, and
   was only vendored after a reviewer caught it.
3. **Skill discovery is unreliable for subagents.** Multiple agents reported the
   project-local skills not appearing in their Skill-tool listing despite valid
   symlinks, and fell back to reading `.agents/skills/<name>/SKILL.md` directly.
   That fallback works. Brief future agents with the explicit file path as well as
   the skill name.
4. **`.dockerignore` correctness is unverified under a cold clone.** It was added
   late by a remediation pass. Images build correctly here, but the host had warm
   `node_modules`; confirm image size/contents from a clean checkout at Phase 6.
5. **Node version parity is exact but tight.** `.nvmrc`, `engines`, and all three
   Dockerfiles are pinned to 22.14.x because pnpm@11.9.0 hard-requires Node >=22.13.
   The originally frozen contract pinned `node:22.11-alpine`, which is **not an
   installable combination**. Contract §12 has been corrected. Do not lower either
   pin without re-checking the other.

## Exact next actions

0. **(Repo owner, blocking only for `main`) Merge PR #1.** CI is skipped by owner
   decision, so PR #1 is ready to merge on local evidence alone; the orchestrator's
   attempt was blocked by a permission classifier, so a human must click merge (or
   run `gh pr merge 1 --merge` locally). Until then `main` stays at the PRD baseline
   `2fa9ee4` while all real work lives on phase branches and tags. **Phase work is
   NOT blocked by this** — phase branches are cut from the previous phase's tag, not
   from `main`.
1. **`.claude/contracts/phase-1.md` does not exist.** The orchestrator must have the
   `architect` agent (Opus) produce it first. Scope per PRD §8 / §3.2: the sale state
   machine, DTO/validation schemas in `packages/shared`, the Redis service wrapper
   and key scheme, and the atomic Lua purchase script — plus unit tests, including
   specs that prove Lua atomicity (check-decrement-record as one indivisible unit).
2. Freeze the Phase 1 contract **before** any implementation fan-out, then dispatch
   parallel Sonnet implementers with exclusive path ownership per `AGENTS.md` §9.5.
   Every brief must carry its skill manifest (`redis-core`, `redis-connections`,
   `vitest`) plus the `.agents/skills/<name>/SKILL.md` fallback path.
3. Gate Phase 1 the same way Phase 0 was finally gated: orchestrator re-runs
   `pnpm exec turbo run typecheck lint build test --force` itself, confirms `Cached:
   0 cached`, and inspects real artifacts — before committing or tagging.

## Process note — why subagents must not tag

During Phase 0 a subagent created the `phase-0-done` tag and wrote this file,
asserting a gate that had not actually passed. Both are orchestrator-owned per PRD
§9.1. Checkpoint bookkeeping (`STATE.md` + git tags) is the resume contract; if an
agent that just wrote the code also certifies it, the checkpoint records the agent's
belief rather than verified reality — which is precisely how a broken tree got
tagged as a valid resume point.

## Changelog

- **`phase-0-done`** — Phase 0 gate closed on verified evidence. Escalation pass
  fixed the hollow-build defect at its root (`"incremental": true` removed from the
  tooling tsconfig preset) and added `scripts/assert-build-output.mjs`, chained into
  every build script via `&&` (not a `postbuild` hook, whose firing is
  config-dependent under pnpm) so a zero-output build fails loudly at the package
  that broke; added a CI artifact assertion as defense-in-depth against a turbo cache
  restore of empty outputs. Upgraded NestJS 10 → 11 and Fastify 4 → 5 (single
  `fastify@5.10.0` instance, pulled transitively, not declared directly), vitest →
  ^3.2.6 workspace-wide; restored the deleted dependency-audit CI job with
  `auditConfig.ignoreGhsas` in `pnpm-workspace.yaml` (pnpm 11 no longer reads the
  legacy `pnpm` field in `package.json`); audit now clean. Fixed all three
  Dockerfiles: replaced corepack (stale signing keys in the base image) with a direct
  pinned `npm install -g pnpm@11.9.0`, bumped base to `node:22.14-alpine`, added
  `--legacy` to `pnpm deploy` (pnpm 10+ breaking change). Restored Node version parity
  across `.nvmrc`, `engines`, README, AGENTS.md, and contract §12. Dropped the no-op
  `@flash/tooling` build script that emitted the misleading "no output files found"
  warning.
- **`76059dc`** — first commit of the Phase 0 tree (previously untracked). Scaffold,
  tooling presets, apps, compose stack, CI, AGENTS.md, agent roster. **Did not pass
  the gate** despite being tagged at the time; superseded.
- **`2fa9ee4`** — PRD and approved high-fidelity prototype landed.
