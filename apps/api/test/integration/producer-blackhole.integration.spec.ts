import net, { type AddressInfo, type Server, type Socket } from 'node:net';

import { saleKeys } from '@flash/shared';
import { purchaseResponseSchema } from '@flash/shared/schemas';
import Redis from 'ioredis';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type AppHarness, bootHarness } from '../support/app-harness.js';
import { closeHttpAgent, post } from '../support/http.js';
import { seedSale } from '../support/seed.js';

interface BlackHoleServer {
  redisUrl: string;
  acceptedSockets: Set<Socket>;
  close(): Promise<void>;
}

async function startBlackHoleServer(): Promise<BlackHoleServer> {
  const acceptedSockets = new Set<Socket>();
  const server: Server = net.createServer((socket) => {
    acceptedSockets.add(socket);
    socket.on('close', () => acceptedSockets.delete(socket));
    // Deliberately consume nothing and reply to nothing: the peer completes TCP,
    // then every Redis command remains pending until the producer hard-cancels it.
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;

  return {
    redisUrl: `redis://127.0.0.1:${address.port}`,
    acceptedSockets,
    async close() {
      for (const socket of acceptedSockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  description: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('BullMQ producer against a real black-hole TCP boundary (Amendment A4)', () => {
  let blackHole: BlackHoleServer;
  let harness: AppHarness;
  let producer: import('../../src/queue/orders-queue.service.js').OrdersQueueService;
  const unhandledRejections: unknown[] = [];
  const uncaughtExceptions: Error[] = [];
  const onUnhandledRejection = (reason: unknown): void => {
    unhandledRejections.push(reason);
  };
  const onUncaughtException = (error: Error): void => {
    uncaughtExceptions.push(error);
  };

  beforeEach(async () => {
    process.on('unhandledRejection', onUnhandledRejection);
    process.on('uncaughtException', onUncaughtException);
    blackHole = await startBlackHoleServer();
    harness = await bootHarness({
      env: {
        ENQUEUE_TIMEOUT_MS: '100',
        RATE_LIMIT_MAX: '100000',
        RATE_LIMIT_USER_MAX: '100000',
      },
      overrideModule: async (builder) => {
        const { env } =
          (await import('../../src/config/env.js')) as typeof import('../../src/config/env.js');
        const { OrdersQueueService } =
          (await import('../../src/queue/orders-queue.service.js')) as typeof import('../../src/queue/orders-queue.service.js');
        producer = new OrdersQueueService({ ...env, REDIS_URL: blackHole.redisUrl });
        return builder.overrideProvider(OrdersQueueService).useValue(producer);
      },
    });
  });

  afterEach(async () => {
    await harness.close();
    await blackHole.close();
    await new Promise((resolve) => setImmediate(resolve));
    process.removeListener('unhandledRejection', onUnhandledRejection);
    process.removeListener('uncaughtException', onUncaughtException);
  });

  afterAll(async () => {
    await closeHttpAgent();
  });

  it('keeps confirmations truthful and producer ownership bounded through sustained outage', async () => {
    const requestCount = 70;
    await seedSale(harness.store, { saleId: harness.saleId, stock: requestCount });
    const raw = new Redis(harness.redisUrl, { connectionName: 'flash-api-blackhole-ledger' });
    let maxGenerations = 0;
    let maxInFlight = 0;
    let polling = true;
    const poll = (async () => {
      while (polling) {
        maxGenerations = Math.max(maxGenerations, producer.activeGenerationCount);
        maxInFlight = Math.max(maxInFlight, producer.inFlightCount);
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    })();

    try {
      const startedAt = Date.now();
      const responses = await Promise.all(
        Array.from({ length: requestCount }, (_, index) =>
          post(`${harness.baseUrl}/api/purchase`, {
            body: { userId: `black-hole-user-${index}` },
          }),
        ),
      );
      const elapsedMs = Date.now() - startedAt;
      polling = false;
      await poll;

      expect(responses).toHaveLength(requestCount);
      for (const response of responses) {
        expect(response.status).toBe(201);
        expect(purchaseResponseSchema.parse(response.body).status).toBe('CONFIRMED');
      }
      expect(elapsedMs).toBeLessThan(1500);
      expect(maxGenerations).toBeLessThanOrEqual(1);
      expect(maxInFlight).toBeLessThanOrEqual(64);

      await waitFor(
        () => producer.inFlightCount === 0 && producer.activeGenerationCount === 0,
        1500,
        'all producer add settlements and the retiring generation to clear',
      );

      const keys = saleKeys(harness.saleId);
      expect(await raw.get(keys.stock)).toBe('0');
      expect(await raw.scard(keys.buyers)).toBe(requestCount);
      expect(await raw.hlen(keys.reservations)).toBe(requestCount);
      expect(await harness.queueObserver.getJobCounts()).toEqual({
        waiting: 0,
        active: 0,
        delayed: 0,
        failed: 0,
      });
      expect(unhandledRejections).toEqual([]);
      expect(uncaughtExceptions).toEqual([]);
    } finally {
      polling = false;
      await poll;
      raw.disconnect();
    }
  });
});
