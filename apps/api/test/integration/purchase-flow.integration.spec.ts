// apps/api/test/integration/purchase-flow.integration.spec.ts  [SLICE E]
// POST /api/purchase — contract §6.4, §6.7, §8.1, §11.2.
import { buildOrdersJobId } from '@flash/shared';
import { purchaseResponseSchema } from '@flash/shared/schemas';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type AppHarness, bootHarness } from '../support/app-harness.js';
import { post } from '../support/http.js';
import { seedSale } from '../support/seed.js';

interface ApiErrorBody {
  error: string;
  message: string;
  requestId: string;
  serverTime: string;
  serverTimeMs: number;
}

describe('POST /api/purchase', () => {
  let harness: AppHarness;

  beforeEach(async () => {
    harness = await bootHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  it('201 CONFIRMED, envelope parses against purchaseResponseSchema', async () => {
    await seedSale(harness.store, { saleId: harness.saleId, stock: 5 });

    const res = await post(`${harness.baseUrl}/api/purchase`, { body: { userId: 'alice-2026' } });

    expect(res.status).toBe(201);
    const parsed = purchaseResponseSchema.parse(res.body);
    expect(parsed.status).toBe('CONFIRMED');
    expect(parsed.userId).toBe('alice-2026');
    expect(parsed.saleId).toBe(harness.saleId);
    expect(parsed.stockRemaining).toBe(4);
  });

  it('second attempt by the same user -> 409 ALREADY_PURCHASED', async () => {
    await seedSale(harness.store, { saleId: harness.saleId, stock: 5 });

    const first = await post(`${harness.baseUrl}/api/purchase`, { body: { userId: 'bob-2026' } });
    expect(first.status).toBe(201);

    const second = await post(`${harness.baseUrl}/api/purchase`, { body: { userId: 'bob-2026' } });
    expect(second.status).toBe(409);
    const parsed = purchaseResponseSchema.parse(second.body);
    expect(parsed.status).toBe('ALREADY_PURCHASED');
  });

  it('stock exhausted -> 410 SOLD_OUT', async () => {
    await seedSale(harness.store, { saleId: harness.saleId, stock: 1 });

    const first = await post(`${harness.baseUrl}/api/purchase`, {
      body: { userId: 'winner-2026' },
    });
    expect(first.status).toBe(201);

    const second = await post(`${harness.baseUrl}/api/purchase`, {
      body: { userId: 'loser-2026' },
    });
    expect(second.status).toBe(410);
    const parsed = purchaseResponseSchema.parse(second.body);
    expect(parsed.status).toBe('SOLD_OUT');
    expect(parsed.stockRemaining).toBe(0);
  });

  it('unseeded sale -> 503 NOT_INITIALIZED with stockRemaining: null, never -1', async () => {
    const res = await post(`${harness.baseUrl}/api/purchase`, { body: { userId: 'nobody-2026' } });

    expect(res.status).toBe(503);
    const parsed = purchaseResponseSchema.parse(res.body);
    expect(parsed.status).toBe('NOT_INITIALIZED');
    expect(parsed.stockRemaining).toBeNull();
  });

  describe('validation -> 422 for the adversarial userId corpus', () => {
    beforeEach(async () => {
      await seedSale(harness.store, { saleId: harness.saleId, stock: 10 });
    });

    const invalidBodies: Array<{ label: string; body: unknown }> = [
      { label: 'empty body', body: {} },
      { label: 'empty userId', body: { userId: '' } },
      { label: 'too short (below USER_ID_MIN_LENGTH)', body: { userId: 'ab' } },
      { label: 'too long (above USER_ID_MAX_LENGTH)', body: { userId: 'a'.repeat(65) } },
      { label: 'illegal character', body: { userId: 'bad!char' } },
      { label: 'unknown key rejected by .strict()', body: { userId: 'ok-user-2026', extra: 1 } },
    ];

    for (const { label, body } of invalidBodies) {
      it(`${label} -> 422`, async () => {
        const res = await post<ApiErrorBody>(`${harness.baseUrl}/api/purchase`, { body });
        expect(res.status).toBe(422);
      });
    }

    it('malformed JSON -> 422', async () => {
      const res = await post<ApiErrorBody>(`${harness.baseUrl}/api/purchase`, {
        rawBody: '{ "userId": ',
        contentType: 'application/json',
      });
      expect(res.status).toBe(422);
    });

    it('text/plain content-type -> 422', async () => {
      const res = await post<ApiErrorBody>(`${harness.baseUrl}/api/purchase`, {
        rawBody: JSON.stringify({ userId: 'ok-user-2026' }),
        contentType: 'text/plain',
      });
      expect(res.status).toBe(422);
    });

    it('17KB body (over REQUEST_BODY_LIMIT_BYTES=16384) -> 422', async () => {
      const oversized = JSON.stringify({ userId: 'ok-user-2026', padding: 'x'.repeat(17 * 1024) });
      const res = await post<ApiErrorBody>(`${harness.baseUrl}/api/purchase`, {
        rawBody: oversized,
        contentType: 'application/json',
      });
      expect(res.status).toBe(422);
    });
  });

  it('a CONFIRMED purchase produces a BullMQ job with jobId === buildOrdersJobId(saleId, userId) carrying a non-empty reservationId', async () => {
    await seedSale(harness.store, { saleId: harness.saleId, stock: 5 });

    const res = await post(`${harness.baseUrl}/api/purchase`, {
      body: { userId: 'queue-check-2026' },
    });
    expect(res.status).toBe(201);

    const job = await harness.queueObserver.getJob(
      buildOrdersJobId(harness.saleId, 'queue-check-2026'),
    );

    expect(job).not.toBeNull();
    expect(job?.data?.reservationId).toEqual(expect.any(String));
    expect(job?.data?.reservationId?.length).toBeGreaterThan(0);
  });

  it('real BullMQ accepts buildOrdersJobId and deduplicates one pair without colliding distinct users', async () => {
    const { OrdersQueueService } =
      (await import('../../src/queue/orders-queue.service.js')) as typeof import('../../src/queue/orders-queue.service.js');
    const service =
      harness.get<import('../../src/queue/orders-queue.service.js').OrdersQueueService>(
        OrdersQueueService,
      );
    const firstUser = 'bullmq-idempotent-a';
    const secondUser = 'bullmq-idempotent-b';
    const payload = {
      saleId: harness.saleId,
      userId: firstUser,
      reservationId: '11111111-1111-4111-8111-111111111111',
      reservedAtMs: Date.now(),
      requestId: 'bullmq-idempotency-proof',
    };

    const first = await service.enqueue(payload);
    const duplicate = await service.enqueue(payload);
    const distinct = await service.enqueue({
      ...payload,
      userId: secondUser,
      reservationId: '22222222-2222-4222-8222-222222222222',
    });

    expect(first.id).toBe(buildOrdersJobId(harness.saleId, firstUser));
    expect(duplicate.id).toBe(first.id);
    expect(distinct.id).toBe(buildOrdersJobId(harness.saleId, secondUser));
    expect(distinct.id).not.toBe(first.id);
    const jobIds = await harness.queueObserver.listJobIds(['waiting', 'active', 'delayed']);
    expect(jobIds).toEqual([first.id, distinct.id].sort());
  });
});
