# Phase 5 load harness

The harness runs the shipped API and worker in an isolated, disposable Compose project. It never
resets the ordinary developer stack or its named volumes. Every repetition uses a new sale and
buyer namespace, then audits Redis, Postgres, readiness, and queue convergence for I1–I4.

```bash
pnpm stress:smoke # one 30-second 200 purchase/s run
pnpm stress       # warmup plus 3x surge, duplicate storm, sold-out, and window-edge
```

Docker and Compose are required; no global k6 installation is needed. The runner uses the pinned
`grafana/k6:1.7.1@sha256:4fd3a694926b064d3491d9b02b01cde886583c4931f1223816e3d9a7bdfa7e0f`
container. Raw evidence is written under `load/results/raw/<runId>/` and ignored by Git. The
historical delivery disposition and its integrity manifest are
[`load/results/phase-5-results.md`](./results/phase-5-results.md) and
[`load/results/phase-5-results.sha256`](./results/phase-5-results.sha256).

Local execution requires a non-root POSIX UID/GID. The runner maps that numeric identity only to
the k6 container, keeps its root filesystem and scripts read-only, and proves the run-scoped result
mount can create and remove a private probe before any workload starts.

The runner fails closed on occupied ports, unknown `STRESS_*` variables, missing summaries,
threshold failures, convergence timeouts, audit mismatches, evidence failures, cleanup failures,
or interruption. See `.env.example` for the seven supported runner settings.

The original delivery record did not run live stress because secure atomic audit publication
required a root-owned, non-group/world-writable `/usr/bin/ln`, while the delivery host reported
uid 65534. That record remains intact. A later partial full-profile diagnostic run is captured in
the [post-delivery evidence amendment](./results/post-delivery-stress-2026-07-23.md) and its
[tracked-only SHA-256 manifest](./results/post-delivery-stress-2026-07-23.sha256): warmup and all
three surge repetitions were correctness-clean, but duplicate-storm r1 failed latency and
dropped-iteration acceptance criteria despite a clean I1–I4 audit. The operational evidence
includes 64 terminal enqueue failures, 3,315 reconciliation repairs, and one worker-readiness HTTP 503. The measurement included the T2 listen-backlog candidate, which was reverted; it is not a
final-code capacity or latency claim. Later partial duplicate-storm, sold-out, and window-edge
attempts are excluded and carry no pass claim; the run is non-qualifying.
