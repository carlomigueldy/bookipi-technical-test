// apps/api/src/health/health.controller.spec.ts
//
// SLICE D unit spec (contract §11.1: `src/**/*.spec.ts`, no containers, no network).
// Replaces the Phase 0 scaffold spec per §2.2's explicit deletion right. `HealthService`
// is mocked here — its own liveness/readiness *logic* (including the real
// dependency-down 503 path) is exercised in `health.service.spec.ts`; genuinely killing
// a container (Redis paused, PG pool stopped) to prove the wire end-to-end is SLICE E's
// `test/integration/health.integration.spec.ts`, driven over a real socket, which is
// out of this file's ownership (`apps/api/src/health/**` is unit-only per §11.1).
//
// This spec's job is narrower and just as load-bearing: prove the controller sets the
// right Fastify reply status/header for each `HealthService.getReadiness()` outcome, and
// never itself decides liveness (§9.2: liveness performs no I/O at all).
import { HttpStatus } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';

import { HealthController } from './health.controller.js';
import { HealthService, type LivenessBody, type ReadinessResult } from './health.service.js';

function fakeReply() {
  const reply = {
    header: vi.fn().mockReturnThis(),
    status: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  };
  return reply;
}

function fakeRequest(id: string) {
  return { id };
}

describe('HealthController', () => {
  async function build(healthService: Partial<HealthService>) {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: HealthService, useValue: healthService }],
    }).compile();

    return module.get(HealthController);
  }

  describe('GET /health (liveness)', () => {
    it('returns the frozen four-key shape, unrenamed', async () => {
      const body: LivenessBody = {
        status: 'ok',
        service: 'api',
        version: '0.0.0',
        uptimeSeconds: 12.5,
      };
      const controller = await build({ getLiveness: vi.fn().mockReturnValue(body) });

      expect(controller.getHealth()).toEqual(body);
    });
  });

  describe('GET /health/ready (readiness)', () => {
    it('healthy: replies 200, no retry-after header, body sent verbatim', async () => {
      const result: ReadinessResult = {
        healthy: true,
        body: {
          status: 'ok',
          service: 'api',
          version: '0.0.0',
          uptimeSeconds: 1,
          checks: {
            redis: { ok: true, latencyMs: 1 },
            postgres: { ok: true, latencyMs: 2 },
            clock: { ok: true, offsetMs: 0, rttMs: 1, ageMs: 100 },
            sale: { ok: true, initialized: true, stockKeyPresent: true },
            queue: { ok: true, waiting: 0, active: 0, delayed: 0, failed: 0 },
          },
          requestId: 'req-1',
          serverTime: new Date(1).toISOString(),
          serverTimeMs: 1,
        },
      };
      const getReadiness = vi.fn().mockResolvedValue(result);
      const controller = await build({ getReadiness });
      const reply = fakeReply();

      await controller.getReadiness(fakeRequest('req-1') as never, reply as never);

      expect(getReadiness).toHaveBeenCalledWith('req-1');
      expect(reply.header).not.toHaveBeenCalledWith('retry-after', expect.anything());
      expect(reply.status).toHaveBeenCalledWith(HttpStatus.OK);
      expect(reply.send).toHaveBeenCalledWith(result.body);
    });

    it('degraded: replies 503 with retry-after: 1', async () => {
      const result: ReadinessResult = {
        healthy: false,
        body: {
          status: 'degraded',
          service: 'api',
          version: '0.0.0',
          uptimeSeconds: 1,
          checks: {
            redis: { ok: false, latencyMs: null },
            postgres: { ok: true, latencyMs: 2 },
            clock: { ok: true, offsetMs: 0, rttMs: 1, ageMs: 100 },
            sale: { ok: false, initialized: false, stockKeyPresent: false },
            queue: { ok: true, waiting: 0, active: 0, delayed: 0, failed: 0 },
          },
          requestId: 'req-2',
          serverTime: new Date(2).toISOString(),
          serverTimeMs: 2,
        },
      };
      const controller = await build({ getReadiness: vi.fn().mockResolvedValue(result) });
      const reply = fakeReply();

      await controller.getReadiness(fakeRequest('req-2') as never, reply as never);

      expect(reply.header).toHaveBeenCalledWith('retry-after', '1');
      expect(reply.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
      expect(reply.send).toHaveBeenCalledWith(result.body);
    });
  });
});
