import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

describe('HealthController', () => {
  let controller: HealthController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: HealthService, useValue: { readiness: () => ({ status: 'degraded' }) } },
      ],
    }).compile();

    controller = module.get<HealthController>(HealthController);
  });

  it('returns the frozen health payload shape', () => {
    const result = controller.getHealth();

    expect(result.status).toBe('ok');
    expect(result.service).toBe('worker');
    expect(result.version).toBe('0.0.0');
    expect(typeof result.uptimeSeconds).toBe('number');
  });

  it('sets readiness status to 503 when degraded', () => {
    const reply = { status: vi.fn() };
    expect(controller.getReady(reply).status).toBe('degraded');
    expect(reply.status).toHaveBeenCalledWith(503);
  });
});
