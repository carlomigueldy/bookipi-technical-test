import { describe, expect, it, vi } from 'vitest';
import { HealthService } from './health.service.js';
import type { WorkerEnv } from '../config/env.js';

const baseEnv = { WORKER_RECONCILE_INTERVAL_MS: 2000 } as WorkerEnv;

const baseState = () => ({
  bootstrapReconciled: true,
  consumerReady: true,
  reconciliationHealthy: true,
  lastReconciledAt: null,
  lastDlqSweepAt: null,
  activeJobs: 0,
  failedJobs: 0,
});

describe('HealthService', () => {
  it('is ready only when bootstrap, consumer, and reconciliation are healthy', () => {
    const state = baseState();
    expect(new HealthService(state, baseEnv).readiness().status).toBe('ok');

    state.bootstrapReconciled = false;
    expect(new HealthService(state, baseEnv).readiness().status).toBe('degraded');
    state.bootstrapReconciled = true;

    state.consumerReady = false;
    expect(new HealthService(state, baseEnv).readiness().status).toBe('degraded');
    state.consumerReady = true;

    // A persistently unhealthy reconciliation loop (not just a single
    // transient flap — see the staleness-budget tests below) still degrades.
    state.reconciliationHealthy = false;
    const health = new HealthService(state, baseEnv);
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(0);
    expect(health.readiness().status).toBe('ok');
    nowSpy.mockReturnValue(baseEnv.WORKER_RECONCILE_INTERVAL_MS * 5 + 1);
    expect(health.readiness().status).toBe('degraded');
    nowSpy.mockRestore();
  });

  it('tolerates a single transient reconciliationHealthy=false flap during a storm-scale cold-start sweep, self-clearing without ever degrading', () => {
    // Reproduces the adjudicated storm signature: bootstrap and the consumer
    // are already up, but the reconciliation pass momentarily reports
    // unhealthy mid-sweep (e.g. thousands of enqueue_repaired events, or a
    // transient WSL2 CLOCK_REALTIME step) and recovers on the very next
    // scheduled pass — well inside the interval-scaled grace budget.
    const state = baseState();
    const health = new HealthService(state, baseEnv);
    expect(health.readiness().status).toBe('ok');

    state.reconciliationHealthy = false;
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1_000_000);
    expect(health.readiness().status).toBe('ok'); // just went unhealthy — inside budget

    nowSpy.mockReturnValue(1_000_000 + 3_000); // still mid-sweep, under 5x2000ms budget
    expect(health.readiness().status).toBe('ok');

    state.reconciliationHealthy = true; // the sweep completes and self-clears
    nowSpy.mockReturnValue(1_000_000 + 3_500);
    expect(health.readiness().status).toBe('ok');

    nowSpy.mockRestore();
  });

  it('still degrades once reconciliation stays unhealthy longer than the interval-scaled staleness budget (genuine stall)', () => {
    const state = baseState();
    const health = new HealthService(state, baseEnv);
    state.reconciliationHealthy = false;

    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(2_000_000);
    expect(health.readiness().status).toBe('ok');

    // Budget is WORKER_RECONCILE_INTERVAL_MS * 5 = 10,000ms; well past that
    // with no recovery means the reconciliation loop is genuinely stalled.
    nowSpy.mockReturnValue(2_000_000 + 10_001);
    expect(health.readiness().status).toBe('degraded');

    nowSpy.mockRestore();
  });
});
