// apps/api/src/health/health.controller.ts
//
// SLICE D — .claude/contracts/phase-2.md §9.
//
// `GET /api/health` (liveness) and `GET /api/health/ready` (readiness), the deliberate
// split from the PRD's single endpoint (§0.3.1): a Redis blip must never restart every
// pod, which is exactly what one conflated, failure-capable endpoint used as both the
// container healthcheck and the LB readiness probe would do.
//
// `@RouteConfig({ rateLimit: false })` is `@nestjs/platform-fastify`'s own mechanism
// (not something SLICE A needs to build) for reaching Fastify's native per-route
// `config.rateLimit = false` that `@fastify/rate-limit`'s `onRoute` hook reads to skip a
// route entirely (contract §9.2: "a probe must not be able to rate-limit itself out of
// existence during a surge").
//
// `/health/ready` replies via the raw Fastify `reply` rather than a thrown exception
// through the global filter: its body (§9.3) is a complete, self-contained shape
// (including its own `requestId`/`serverTime`/`serverTimeMs`) that owes nothing to the
// `ApiErrorResponse`/`common/messages.ts` vocabulary the filter exists to produce, and a
// readiness probe should not depend on a shared filter's behavior to report accurately.
// No numeric HTTP status literal appears anywhere in this file — `HttpStatus.OK` /
// `HttpStatus.SERVICE_UNAVAILABLE` only.
import { Controller, Get, HttpStatus, Req, Res } from '@nestjs/common';
import { RouteConfig } from '@nestjs/platform-fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { HEALTH_PATH, type HealthResponse } from '@flash/shared';

import { HealthService } from './health.service.js';

@Controller(HEALTH_PATH)
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  @RouteConfig({ rateLimit: false })
  getHealth(): HealthResponse {
    return this.healthService.getLiveness();
  }

  @Get('ready')
  async getReadiness(
    @Req() request: FastifyRequest,
    @Res({ passthrough: false }) reply: FastifyReply,
  ): Promise<void> {
    const { healthy, body } = await this.healthService.getReadiness(request.id);

    if (!healthy) {
      reply.header('retry-after', '1');
    }

    reply.status(healthy ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE).send(body);
  }
}
