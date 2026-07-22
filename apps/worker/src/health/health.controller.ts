import { Controller, Get, Res } from '@nestjs/common';
import { HEALTH_PATH, type HealthResponse } from '@flash/shared';
import { HealthService, type WorkerReadinessResponse } from './health.service.js';

interface StatusReply {
  status(code: number): unknown;
}

/**
 * Frozen Phase-0 health surface (contract §13). No global prefix is set on
 * the worker's Nest app, so this route is `GET /health`. Response shape is
 * frozen — Phase 3 may add keys but must never rename `status`, `service`,
 * `version`, `uptimeSeconds`.
 */
const SERVICE_VERSION = '0.0.0';

@Controller(HEALTH_PATH)
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  getHealth(): HealthResponse {
    return {
      status: 'ok',
      service: 'worker',
      version: SERVICE_VERSION,
      uptimeSeconds: process.uptime(),
    };
  }

  @Get('ready')
  getReady(@Res({ passthrough: true }) reply: StatusReply): WorkerReadinessResponse {
    const result = this.healthService.readiness();
    reply.status(result.status === 'ok' ? 200 : 503);
    return result;
  }
}
