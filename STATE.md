# STATE.md — Build State (single source of truth)

This file is the single source of truth for "where are we." Read it in full before
resuming work — see `AGENTS.md` §3 for the full resume protocol. If this file
disagrees with a commit message, chat history, or your own memory of a prior
session, this file wins.

---

## Current phase

**Phase 0 — Bootstrap.** In progress → closing out.

Scope per `.claude/contracts/phase-0.md`: monorepo scaffold, tooling presets
(`packages/tooling`), empty-but-wired `apps/api` / `apps/worker` / `apps/web` /
`packages/shared`, Docker Compose stack (`infra/`), frozen CI job graph
(`.github/workflows/ci.yml`), `AGENTS.md`, `STATE.md`, root `README.md`,
`.claude/settings.json`.

This gate is closing on **this commit** after a review pass (see Changelog) fixed
every critical/major finding from the Phase 0 review. Phase 1 (`packages/shared`
domain core: state machine, DTOs, Redis service + Lua, unit tests) has **not**
started.

## Last tag

**None yet.** This is the commit that will be tagged `phase-0-done` immediately
after this update lands and the verification block below is re-confirmed on the
committed tree (see AGENTS.md §4 gate ritual — commit → tag → update STATE.md is
one atomic sequence, done in that order).

Historical note: the tree was fully built in this working copy before this commit
but was never `git add`ed — `git ls-files` showed only `PRD.md` and
`prototype/index.html` prior to this commit. There is no phase history before this
entry.

## Verification evidence

Re-run on this exact commit (after `pnpm run clean` wiped `node_modules`, `dist`,
`.turbo`, and every `*.tsbuildinfo` first, to reproduce and confirm-fixed the
build bug described below from a genuinely clean state):

```bash
pnpm install                # Packages: +559, Done in 1s
pnpm run format:check       # All matched files use Prettier code style!
pnpm run typecheck          # Tasks: 7 successful, 7 total
pnpm run lint                # Tasks: 7 successful, 7 total
pnpm run build                # Tasks: 5 successful, 5 total — apps/api/dist/main.js
                               # and apps/worker/dist/main.js both present, no
                               # "no output files found" warning for api/worker
pnpm run test                  # Tasks: 7 successful, 7 total — 5 test files, 5 tests, all passed
pnpm run test:integration      # Tasks: 4 successful, 4 total — "No test files found, exiting with code 0"
pnpm run stress                 # "stress: k6 scenarios land in Phase 5 (see PRD §6.2). Nothing to run yet."
```

All eight green on this commit. The `pnpm build` step is the one that matters
most here: prior to this commit, `nest build` for `apps/api` and `apps/worker`
exited 0 with **no `dist/` output** whenever a stale `*.tsbuildinfo` (written at
the package root, not inside `dist/`) survived a `dist/` wipe — TypeScript's
incremental compiler trusted the buildinfo's "nothing changed" state and never
noticed `nest-cli`'s `deleteOutDir` had just removed the output. Fixed by (a)
gitignoring `*.tsbuildinfo`, (b) every package's `clean` script now removing it
alongside `dist/` and `.turbo`, and (c) deleting the stale files that had
already accumulated in this working copy. Reproduced-then-confirmed-fixed by
running `pnpm run clean && pnpm install && pnpm run build` from a state with
zero `node_modules`/`dist`/`.turbo`/`*.tsbuildinfo` on disk and inspecting
`apps/api/dist/main.js` / `apps/worker/dist/main.js` for real content
afterward (not just a 0 exit code).

## Open issues

1. **Dependency audit gate is out of scope for Phase 0, not yet scheduled.** The
   `lint` CI job previously ran `pnpm audit --audit-level high` unilaterally; this
   was removed (not part of the frozen `.claude/contracts/phase-0.md` §17 job
   table, and `load/README.md` + PRD §6.2 place dependency auditing in Phase 5).
   `pnpm audit --audit-level high` currently exits 1 against the lockfile (high +
   critical advisories in the `@nestjs/platform-fastify`/`@nestjs/cli` dependency
   chain). **Next action for whoever plans Phase 5:** decide whether to (a) bump
   the vulnerable packages, (b) add an explicit, contract-blessed audit job at that
   point, or (c) accept documented risk for a take-home project — and update
   `.claude/contracts/phase-5.md` accordingly. Do not silently reintroduce the
   `pnpm audit` CI step without adding it to a frozen contract first.
2. **`.claude/settings.json` hooks are minimal.** A post-edit typecheck hook and a
   main-branch push guard now exist (see the file itself), matching what
   `AGENTS.md` §13 describes. They have not been exercised under a live edit/push
   in this session — verify they fire as expected the first time either is
   exercised for real, and tighten if they're too loose or too strict.
3. **`frontend-design` skill is now vendored** at `.agents/skills/frontend-design/`
   (Apache-2.0, copied from the Claude Code global skill of the same name) and
   symlinked under `.claude/skills/frontend-design`, and added to
   `skills-lock.json`. Phase 4's frontend-implementer should confirm it loads
   correctly via the project-local path before relying on it, since this is the
   first time it's been available locally rather than only as an
   account-level/global skill.

## Exact next actions

1. `git add -A && git commit` the Phase 0 tree (this is the first real commit of
   the build — see Changelog). Verification evidence above is already captured on
   the pre-commit working tree; confirm nothing changes it (a bare `git status`
   after `add` should show only the expected files staged, no surprises).
2. `git tag -a phase-0-done -m "Phase 0: monorepo bootstrap, tooling, CI, docs"`.
3. Do a fresh `git clone` of the repo to a scratch path and confirm `AGENTS.md`,
   `STATE.md`, and `.claude/contracts/phase-0.md` are present there and the §3
   step-4 verification block passes — this is the only real evidence for the
   "fresh agent can resume cold" claim AGENTS.md makes. Record the result here
   once done (as of this edit it has not yet been performed).
4. Start Phase 1 per `.claude/contracts/phase-1.md` if it exists; if it does not
   yet exist, the orchestrator role (AGENTS.md §5) must have the architect produce
   it before any Phase 1 implementation work starts.

## Changelog

- **(this commit, pre-tag)** Phase 0 review-fix pass: removed the uncontracted
  `pnpm audit` CI step (not in the frozen §17 job graph); fixed the
  `*.tsbuildinfo`/`deleteOutDir` desync that silently zeroed out `nest build`
  output (gitignored the cache files, wired `clean` scripts to remove them,
  deleted the stale ones already on disk); added the previously-missing
  `.dockerignore`; added this file, root `README.md`, and `.claude/settings.json`;
  rewrote `AGENTS.md` §3's resume protocol to add a cold-start branch (step 0) and
  replaced the unconditional `git checkout <tag>` with a decision tree plus an
  explicit `git checkout -b phase-N/<slice>` step; aligned `AGENTS.md` §3 step 4 /
  §8's local verification block with the actual CI/DoD gate; vendored the
  `frontend-design` skill into `.agents/skills/` + `.claude/skills/` +
  `skills-lock.json` so it travels with the repo instead of depending on
  account-level state. `git add`ed the entire pre-existing-but-untracked Phase 0
  tree for the first time.
- Everything before this line was built in the working tree but never committed —
  there is no prior tagged history to report.
