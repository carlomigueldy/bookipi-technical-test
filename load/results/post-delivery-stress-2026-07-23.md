# Post-delivery stress evidence amendment — 2026-07-23

This is a factual, non-qualifying amendment for partial full-profile diagnostic run
`20260723142302-6a2bc45c`. It does not replace the historical Phase 5 disposition
in [phase-5-results.md](./phase-5-results.md), which remains byte-for-byte as
shipped and checksum-verified.

## Scope and provenance

The qualifying decision failed at duplicate-storm r1 after warmup and all three
surge repetitions completed. Later partial duplicate-storm, sold-out, and
window-edge attempts are excluded from this record and carry no pass claim. This
record curates only the terminal k6 summary, audit, and command-status JSON for
warmup r1, surge r1–r3, and duplicate-storm r1. The larger raw run tree remains
ignored and is deliberately not part of this delivery evidence.

The measurement included the T2 HTTP listen-backlog candidate (`4096`). That
candidate was reverted after measurement. These values are therefore diagnostic
evidence, not a final-code capacity or latency claim.

## Observations

| Scenario           | Result             |            Purchase p95 / p99 |    Status p95 | HTTP failure rate | Dropped iterations | I1–I4 audit |
| ------------------ | ------------------ | ----------------------------: | ------------: | ----------------: | -----------------: | ----------- |
| Warmup r1          | pass               |              4.924 / 6.875 ms |      4.479 ms |                0% |                  0 | pass        |
| Surge r1           | pass               |              4.950 / 7.815 ms |      3.683 ms |                0% |                  0 | pass        |
| Surge r2           | pass               |              4.740 / 7.744 ms |      3.444 ms |                0% |                  0 | pass        |
| Surge r3           | pass               |              5.312 / 8.540 ms |      3.886 ms |                0% |                  0 | pass        |
| Duplicate-storm r1 | **non-qualifying** | **1,320.189 / 16,255.311 ms** | **71.804 ms** |                0% |              **6** | pass        |

Surge was configured for 2,000 purchase attempts/s. Each surge audit recorded
exactly 500 confirmed and persisted orders, zero stock remaining, and clean I1–I4.
Duplicate-storm r1 recorded 5,000 confirmed and persisted orders, 45,000 duplicates,
zero stock remaining, and a clean terminal audit; however, it failed the latency and
dropped-iteration acceptance criteria. Its k6 process exited `99`. Operational logs
also recorded 64 terminal enqueue failures, 3,315 reconciliation repairs, and one
worker-readiness HTTP 503.

Correctness evidence is not a performance pass. The duplicate-storm result means
this run cannot support a qualifying Phase 5 threshold, capacity, or final-code
latency claim.

## Curated artifacts

| Repetition         | k6 summary                                                                       | Terminal audit                                                            | Command status                                                                      |
| ------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Warmup r1          | [summary](./evidence/20260723142302-6a2bc45c/warmup/r1/k6-summary.json)          | [audit](./evidence/20260723142302-6a2bc45c/warmup/r1/audit.json)          | [status](./evidence/20260723142302-6a2bc45c/warmup/r1/command-status.json)          |
| Surge r1           | [summary](./evidence/20260723142302-6a2bc45c/surge/r1/k6-summary.json)           | [audit](./evidence/20260723142302-6a2bc45c/surge/r1/audit.json)           | [status](./evidence/20260723142302-6a2bc45c/surge/r1/command-status.json)           |
| Surge r2           | [summary](./evidence/20260723142302-6a2bc45c/surge/r2/k6-summary.json)           | [audit](./evidence/20260723142302-6a2bc45c/surge/r2/audit.json)           | [status](./evidence/20260723142302-6a2bc45c/surge/r2/command-status.json)           |
| Surge r3           | [summary](./evidence/20260723142302-6a2bc45c/surge/r3/k6-summary.json)           | [audit](./evidence/20260723142302-6a2bc45c/surge/r3/audit.json)           | [status](./evidence/20260723142302-6a2bc45c/surge/r3/command-status.json)           |
| Duplicate-storm r1 | [summary](./evidence/20260723142302-6a2bc45c/duplicate-storm/r1/k6-summary.json) | [audit](./evidence/20260723142302-6a2bc45c/duplicate-storm/r1/audit.json) | [status](./evidence/20260723142302-6a2bc45c/duplicate-storm/r1/command-status.json) |

Validate this amendment and every curated artifact with:

```bash
sha256sum -c load/results/post-delivery-stress-2026-07-23.sha256
```
