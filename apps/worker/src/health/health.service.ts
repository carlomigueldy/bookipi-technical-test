import { Inject, Injectable } from '@nestjs/common';
import { RECONCILIATION_STATE } from '../common/tokens.js';
import type { ReconciliationState } from '../reconciliation/reconciliation.service.js';

export interface WorkerReadinessResponse {
  status: 'ok' | 'degraded';
  service: 'worker';
  version: '0.0.0';
  uptimeSeconds: number;
  checks: ReconciliationState;
}

@Injectable()
export class HealthService {
  constructor(@Inject(RECONCILIATION_STATE) private readonly state: ReconciliationState) {}

  readiness(): WorkerReadinessResponse {
    const healthy =
      this.state.bootstrapReconciled &&
      this.state.consumerReady &&
      this.state.reconciliationHealthy;
    return {
      status: healthy ? 'ok' : 'degraded',
      service: 'worker',
      version: '0.0.0',
      uptimeSeconds: process.uptime(),
      checks: { ...this.state },
    };
  }
}
