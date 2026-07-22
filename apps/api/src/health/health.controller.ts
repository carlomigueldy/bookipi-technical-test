import { Controller, Get } from '@nestjs/common';
import { HEALTH_PATH, type HealthResponse } from '@flash/shared';

/**
 * Frozen Phase-0 health surface (contract §13). Global prefix `api` makes
 * this route `GET /api/health`. Response shape is frozen — Phase 2 may add
 * keys (redis, postgres, queueDepth) and a 503 branch, but must never rename
 * `status`, `service`, `version`, `uptimeSeconds`.
 */
const SERVICE_VERSION = '0.0.0';

@Controller(HEALTH_PATH)
export class HealthController {
  @Get()
  getHealth(): HealthResponse {
    return {
      status: 'ok',
      service: 'api',
      version: SERVICE_VERSION,
      uptimeSeconds: process.uptime(),
    };
  }
}
