import { Inject, Injectable } from '@nestjs/common';
import { RECONCILIATION_STATE, WORKER_ENV } from '../common/tokens.js';
import type { WorkerEnv } from '../config/env.js';
import type { ReconciliationState } from '../reconciliation/reconciliation.service.js';

export interface WorkerReadinessResponse {
  status: 'ok' | 'degraded';
  service: 'worker';
  version: '0.0.0';
  uptimeSeconds: number;
  checks: ReconciliationState;
}

/**
 * A single *periodic* reconciliation pass can legitimately flip
 * `reconciliationHealthy` false for one cycle without anything being
 * wrong — e.g. a storm-scale cold-start sweep (thousands of
 * `enqueue_repaired` events) transiently recomputing `queueIssueCount`, or
 * this host's proven CLOCK_REALTIME instability (steps of several seconds)
 * perturbing a time-based check mid-sweep — and flip back to healthy on the
 * very next scheduled pass. Reporting the readiness probe as instantly
 * degraded on that single flap treats a self-healing blip as an outage. We
 * only call that case a genuine stall once it has stayed unhealthy for
 * longer than several reconciliation cadences — tied to
 * `WORKER_RECONCILE_INTERVAL_MS` rather than a fixed small constant, so the
 * budget scales with however long a sweep actually takes to run.
 *
 * That grace is deliberately narrow: `ReconciliationService` only marks a
 * transition as grace-eligible for its own routine periodic reassessment
 * (`reconciliationFailureConfirmed === false`). Every other source of
 * unhealthy — boot-time assessment, an explicitly thrown/caught
 * reconciliation error, retained-unsafe DLQ entries, consumer termination,
 * or shutdown — sets `reconciliationFailureConfirmed = true` and is reported
 * degraded immediately, with no grace window. This preserves the I4
 * fail-closed requirement that a confirmed structural problem (e.g.
 * malformed retained queue entries, an unrecoverable identity conflict)
 * degrades readiness the moment it is detected, never masked for up to the
 * grace window's duration.
 */
const RECONCILIATION_STALL_GRACE_CYCLES = 5;

@Injectable()
export class HealthService {
  private unhealthySinceMs: number | null = null;

  constructor(
    @Inject(RECONCILIATION_STATE) private readonly state: ReconciliationState,
    @Inject(WORKER_ENV) private readonly env: WorkerEnv,
  ) {}

  readiness(): WorkerReadinessResponse {
    const reconciliationHealthy = this.isReconciliationHealthy();
    const healthy =
      this.state.bootstrapReconciled && this.state.consumerReady && reconciliationHealthy;
    return {
      status: healthy ? 'ok' : 'degraded',
      service: 'worker',
      version: '0.0.0',
      uptimeSeconds: process.uptime(),
      // `reconciliationHealthy` here must reflect the *gated* value (through
      // the staleness-budget grace window), not the raw periodic-pass state,
      // because external consumers (e.g. the stress harness's sampler
      // evidence gate) key off `checks.reconciliationHealthy` directly,
      // independent of the top-level `status` field.
      checks: { ...this.state, reconciliationHealthy },
    };
  }

  private isReconciliationHealthy(): boolean {
    const now = Date.now();
    if (this.state.reconciliationHealthy) {
      this.unhealthySinceMs = null;
      return true;
    }
    if (this.state.reconciliationFailureConfirmed) {
      this.unhealthySinceMs = null;
      return false;
    }
    this.unhealthySinceMs ??= now;
    const staleBudgetMs = this.env.WORKER_RECONCILE_INTERVAL_MS * RECONCILIATION_STALL_GRACE_CYCLES;
    return now - this.unhealthySinceMs <= staleBudgetMs;
  }
}
