import { describe, expect, it } from 'vitest';
import { HealthService } from './health.service.js';

describe('HealthService', () => {
  it('is ready only when bootstrap, consumer, and reconciliation are healthy', () => {
    const state = {
      bootstrapReconciled: true,
      consumerReady: true,
      reconciliationHealthy: true,
      lastReconciledAt: null,
      lastDlqSweepAt: null,
      activeJobs: 0,
      failedJobs: 2,
    };
    expect(new HealthService(state).readiness().status).toBe('ok');
    state.reconciliationHealthy = false;
    expect(new HealthService(state).readiness().status).toBe('degraded');
  });
});
