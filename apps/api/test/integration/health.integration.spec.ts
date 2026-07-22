// apps/api/test/integration/health.integration.spec.ts  [SLICE E]
// GET /api/health (liveness) and GET /api/health/ready (readiness) — contract §9, §11.2.
import Redis from 'ioredis';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type AppHarness, bootHarness } from '../support/app-harness.js';
import { closeHttpAgent, get } from '../support/http.js';
import { seedSale } from '../support/seed.js';

interface LivenessBody {
  status: string;
  service: string;
  version: string;
  uptimeSeconds: number;
}

interface ReadinessBody extends LivenessBody {
  checks: {
    redis: { ok: boolean; latencyMs: number | null };
    postgres: { ok: boolean; latencyMs: number | null };
    clock: { ok: boolean; offsetMs?: number; rttMs?: number; ageMs?: number };
    sale: { ok: boolean; initialized: boolean; stockKeyPresent: boolean };
    queue: { ok: boolean; waiting?: number; active?: number; delayed?: number; failed?: number };
  };
  requestId: string;
  serverTime: string;
  serverTimeMs: number;
}

describe('Health', () => {
  let harness: AppHarness;

  beforeEach(async () => {
    harness = await bootHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  afterAll(async () => {
    await closeHttpAgent();
  });

  it('GET /api/health: 200 with the frozen four keys and no dependency I/O', async () => {
    const res = await get<LivenessBody>(`${harness.baseUrl}/api/health`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('api');
    expect(typeof res.body.version).toBe('string');
    expect(typeof res.body.uptimeSeconds).toBe('number');
  });

  it('GET /api/health/ready: 200 healthy when everything is up', async () => {
    await seedSale(harness.store, { saleId: harness.saleId, stock: 5 });

    const res = await get<ReadinessBody>(`${harness.baseUrl}/api/health/ready`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.checks.redis.ok).toBe(true);
    expect(res.body.checks.sale.ok).toBe(true);
    expect(Object.keys(res.body).sort()).toEqual(
      [
        'checks',
        'requestId',
        'serverTime',
        'serverTimeMs',
        'service',
        'status',
        'uptimeSeconds',
        'version',
      ].sort(),
    );
    expect(Object.keys(res.body.checks).sort()).toEqual(
      ['clock', 'postgres', 'queue', 'redis', 'sale'].sort(),
    );
    expect(Object.keys(res.body.checks.redis).sort()).toEqual(['latencyMs', 'ok']);
    expect(Object.keys(res.body.checks.postgres).sort()).toEqual(['latencyMs', 'ok']);
    expect(Object.keys(res.body.checks.clock).sort()).toEqual(['ageMs', 'offsetMs', 'ok', 'rttMs']);
    expect(Object.keys(res.body.checks.sale).sort()).toEqual([
      'initialized',
      'ok',
      'stockKeyPresent',
    ]);
    expect(Object.keys(res.body.checks.queue).sort()).toEqual([
      'active',
      'delayed',
      'failed',
      'ok',
      'waiting',
    ]);
  });

  it('Redis unreachable -> 503 degraded', async () => {
    const { SALE_REDIS_STORE } =
      (await import('../../src/common/tokens.js')) as typeof import('../../src/common/tokens.js');
    const appStore = harness.get<import('@flash/redis').SaleRedisStore>(SALE_REDIS_STORE);
    vi.spyOn(appStore, 'ping').mockResolvedValue(false);
    vi.spyOn(appStore, 'status').mockRejectedValue(new Error('owned readiness outage'));

    const res = await get<ReadinessBody>(`${harness.baseUrl}/api/health/ready`);
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
  });

  it('PG pool stopped -> 200 with checks.postgres.ok === false (PG outage is tolerated)', async () => {
    await seedSale(harness.store, { saleId: harness.saleId, stock: 5 });

    const { PG_POOL } =
      (await import('../../src/common/tokens.js')) as typeof import('../../src/common/tokens.js');
    const appPool = harness.get<import('pg').Pool>(PG_POOL);
    const endSpy = vi.spyOn(appPool, 'end');
    await appPool.end();

    const res = await get<ReadinessBody>(`${harness.baseUrl}/api/health/ready`);
    expect(res.status).toBe(200);
    expect(res.body.checks.postgres.ok).toBe(false);

    await harness.app.close();
    await harness.app.close();
    expect(endSpy).toHaveBeenCalledTimes(1);
  });

  it('DEL the stock key (config intact) -> 503', async () => {
    const seeded = await seedSale(harness.store, { saleId: harness.saleId, stock: 5 });
    void seeded;

    const { saleKeys } = (await import('@flash/shared')) as typeof import('@flash/shared');
    const raw = new Redis(harness.redisUrl);
    try {
      await raw.del(saleKeys(harness.saleId).stock);
    } finally {
      raw.disconnect();
    }

    const res = await get<ReadinessBody>(`${harness.baseUrl}/api/health/ready`);
    expect(res.status).toBe(503);
    expect(res.body.checks.sale.ok).toBe(false);
  });

  it('repeated public readiness probes keep a black-holed queue observer single-flight and bounded', async () => {
    await harness.close();

    let probe:
      | (import('../../src/infra/queue-depth-probe.js').QueueDepthProbe & {
          generationsCreated: number;
          maximumLiveGenerations: number;
        })
      | undefined;

    harness = await bootHarness({
      env: { RATE_LIMIT_MAX: '100000' },
      overrideModule: async (builder) => {
        const [{ QUEUE_DEPTH_PROBE }, { env }, queueDepthModule] = await Promise.all([
          import('../../src/common/tokens.js'),
          import('../../src/config/env.js'),
          import('../../src/infra/queue-depth-probe.js'),
        ]);

        class BlackHoledQueueDepthProbe extends queueDepthModule.QueueDepthProbe {
          generationsCreated = 0;
          maximumLiveGenerations = 0;
          private liveGenerations = 0;

          protected override createGeneration(): import('../../src/infra/queue-depth-probe.js').ObserverGeneration {
            this.generationsCreated += 1;
            this.liveGenerations += 1;
            this.maximumLiveGenerations = Math.max(
              this.maximumLiveGenerations,
              this.liveGenerations,
            );

            let rejectCommand!: (reason: Error) => void;
            const command = new Promise<never>((_resolve, reject) => {
              rejectCommand = reject;
            });
            let closed = false;
            const redis = {
              disconnect: vi.fn(() => rejectCommand(new Error('observer unavailable'))),
            };
            const queue = {
              getJobCounts: vi.fn(() => command),
              close: vi.fn(async () => {
                if (!closed) {
                  closed = true;
                  this.liveGenerations -= 1;
                }
              }),
            };
            return {
              redis: redis as never,
              queue: queue as never,
              closePromise: null,
            };
          }
        }

        probe = new BlackHoledQueueDepthProbe(env);
        return builder.overrideProvider(QUEUE_DEPTH_PROBE).useValue(probe);
      },
    });
    await seedSale(harness.store, { saleId: harness.saleId, stock: 5 });

    for (let wave = 1; wave <= 3; wave += 1) {
      const startedAt = Date.now();
      const responses = await Promise.all(
        Array.from({ length: 12 }, () => get<ReadinessBody>(`${harness.baseUrl}/api/health/ready`)),
      );
      expect(Date.now() - startedAt).toBeLessThan(1500);
      expect(responses.every((response) => response.status === 200)).toBe(true);
      expect(responses.every((response) => response.body.checks.queue.ok === false)).toBe(true);
      expect(probe?.generationsCreated).toBe(wave);
      expect(probe?.activeGenerationCount).toBe(0);
      expect(probe?.inFlightCount).toBe(0);
    }

    expect(probe?.maximumLiveGenerations).toBe(1);
  }, 10_000);
});
