# Phase 5 load harness

The harness runs the shipped API and worker in an isolated, disposable Compose project. It never
resets the ordinary developer stack or its named volumes. Every repetition uses a new sale and
buyer namespace, then audits Redis, Postgres, readiness, and queue convergence for I1–I4.

```bash
pnpm stress:smoke # one 30-second 200 purchase/s run
pnpm stress       # warmup plus 3x surge, duplicate storm, sold-out, and window-edge
```

Docker and Compose are required; k6 is the pinned `grafana/k6:1.7.1` container. Raw evidence is
written under `load/results/raw/<runId>/` and ignored by Git. The reviewed table and integrity
manifest are `load/results/phase-5-results.md` and `phase-5-results.sha256`.

Local execution requires a non-root POSIX UID/GID. The runner maps that numeric identity only to
the k6 container, keeps its root filesystem and scripts read-only, and proves the run-scoped result
mount can create and remove a private probe before any workload starts.

The runner fails closed on occupied ports, unknown `STRESS_*` variables, missing summaries,
threshold failures, convergence timeouts, audit mismatches, evidence failures, cleanup failures,
or interruption. See `.env.example` for the seven supported runner settings.

Phase 5 live stress status: not run on the delivery host. Secure atomic audit publication requires
a root-owned, non-group/world-writable /usr/bin/ln; this host reports uid 65534. The owner
authorized skipping privileged host remediation. No Phase 5 rps, p95/p99, threshold, or live
post-stress I1–I4 claim is made. On a compliant Linux host, run pnpm stress to produce those
measurements; do not bypass the helper validation.
