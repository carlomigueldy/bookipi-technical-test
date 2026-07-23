# Phase 5 stress results

Status: COMPLETE — OWNER-AUTHORIZED ENVIRONMENT-LIMITED EVIDENCE BYPASS
UTC disposition date: 2026-07-23
Base commit: 2dcfdbf9f4e359ee6e9f971b1ab4fc053e4337f6
Implementation digest: 87e92304714e5b9e46918d16ed436ba6e4064e3f5bf6be34b2c8d6f15f76c30d

Observed helper stat: `/usr/bin/ln: regular file, mode 0755, uid 65534, gid 65534`. The frozen
production rule requires a root-owned (uid 0), non-group/world-writable regular executable. The
owner authorized skipping privileged host remediation; no privileged remediation was attempted.

Untuned baseline: NOT RUN
Tuning: NOT ELIGIBLE
Final full stress: NOT RUN
Performance/capacity verdict: NOT EVALUATED
Phase 5 live I1–I4 verdict: NOT EVALUATED

| Scenario        | Rep     | Target purchase/s | Achieved purchase/s | Dropped | HTTP failed % | Purchase p95 ms | Purchase p99 ms | Status p95 ms | Confirmed | Duplicate | Sold out | Window rejected | PG persisted | PG compensated | Redis stock | I1            | I2            | I3            | I4            |
| --------------- | ------- | ----------------: | ------------------: | ------: | ------------: | --------------: | --------------: | ------------: | --------: | --------: | -------: | --------------: | -----------: | -------------: | ----------: | ------------- | ------------- | ------------- | ------------- |
| surge           | NOT RUN |                 — |                   — |       — |             — |               — |               — |             — |         — |         — |        — |               — |            — |              — |           — | NOT EVALUATED | NOT EVALUATED | NOT EVALUATED | NOT EVALUATED |
| duplicate-storm | NOT RUN |                 — |                   — |       — |             — |               — |               — |             — |         — |         — |        — |               — |            — |              — |           — | NOT EVALUATED | NOT EVALUATED | NOT EVALUATED | NOT EVALUATED |
| sold-out        | NOT RUN |                 — |                   — |       — |             — |               — |               — |             — |         — |         — |        — |               — |            — |              — |           — | NOT EVALUATED | NOT EVALUATED | NOT EVALUATED | NOT EVALUATED |
| window-edge     | NOT RUN |                 — |                   — |       — |             — |               — |               — |             — |         — |         — |        — |               — |            — |              — |           — | NOT EVALUATED | NOT EVALUATED | NOT EVALUATED | NOT EVALUATED |

## Substitute evidence

The following verifies implementation and fail-closed publication behavior only. It is not live
stress evidence.

| §30.5 evidence group                                                    | Status                                                                                                                                                                                        | Scope                                                                                                                                                                      |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A12 focused audit tests                                                 | Verified: 15/15                                                                                                                                                                               | Secure publication implementation tests                                                                                                                                    |
| Full audit tests                                                        | Verified: 62/62                                                                                                                                                                               | Audit behavior and negative controls                                                                                                                                       |
| Full `@flash/load` tests                                                | Verified: 104/104                                                                                                                                                                             | Harness and audit test suite                                                                                                                                               |
| Forced root graph                                                       | Verified: 28/28 uncached tasks; 66 files and 927 tests                                                                                                                                        | Lint, typecheck, tests, build, integration                                                                                                                                 |
| Dependency audit, build-output, Compose, static, format, and diff gates | Verified clean                                                                                                                                                                                | Required repository checks                                                                                                                                                 |
| Host attestation                                                        | SECURITY_PREREQUISITE_UNSATISFIED                                                                                                                                                             | `/usr/bin/ln` is uid 65534; uid 0 is required                                                                                                                              |
| Production fail-closed probe                                            | Verified                                                                                                                                                                                      | Rejected the untrusted helper, created no `audit.json`, retained one quarantined temp, and cleaned the fixture and capability                                              |
| Final A12/A14/A13/A15 defensive review                                  | APPROVE — A13 accurately records an owner-authorized environment-limited evidence bypass; secure publication remains fail closed, and no Phase 5 live performance or invariant claim is made. | A14 keeps the held descriptor as sole write authority and rejects canonical bind-mount-visible aliases before/after publication without weakening helper trust or cleanup. |

Prior Phase 1–4 invariant evidence is not a Phase 5 live stress result.
