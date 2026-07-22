import type { ServiceName } from './constants';

/**
 * Health status literal union. Phase 0 only ever produces 'ok'; 'degraded' is
 * reserved for Phase 2, when the health endpoint starts pinging Redis/Postgres.
 */
export type HealthStatus = 'ok' | 'degraded';

/**
 * Frozen response shape for the Phase 0 health surface (contract §13). Phase 2
 * may ADD keys (redis, postgres, queueDepth) but must never rename these four.
 */
export interface HealthResponse {
  status: HealthStatus;
  service: ServiceName;
  version: string;
  uptimeSeconds: number;
}
