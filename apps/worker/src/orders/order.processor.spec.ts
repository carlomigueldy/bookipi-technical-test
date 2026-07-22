import { describe, expect, it, vi } from 'vitest';
import { OrderProcessor } from './order.processor.js';

const data = {
  saleId: 'flash-2026',
  userId: 'user-001',
  reservationId: '11111111-1111-4111-8111-111111111111',
  reservedAtMs: 1,
  requestId: 'req-1',
};
const job = {
  name: 'persist-order',
  data,
  id: 'flash-2026-user-001',
  opts: { attempts: 5 },
  attemptsMade: 0,
};

describe('OrderProcessor', () => {
  it('persists a valid shared-contract job', async () => {
    const repository = { persist: vi.fn(async () => 'persisted') };
    await new OrderProcessor(repository as never).process(job as never);
    expect(repository.persist).toHaveBeenCalledWith(data);
  });

  it.each([
    [{ ...job, name: 'wrong' }, 'unexpected job name'],
    [{ ...job, data: { ...data, extra: true } }, 'payload'],
    [{ ...job, id: 'wrong' }, 'job id mismatch'],
    [{ ...job, opts: { attempts: 3 } }, 'job attempts'],
  ])('rejects invalid jobs and never persists', async (invalid, message) => {
    const repository = { persist: vi.fn() };
    await expect(new OrderProcessor(repository as never).process(invalid as never)).rejects.toThrow(
      message,
    );
    expect(repository.persist).not.toHaveBeenCalled();
  });

  it('propagates repository errors to BullMQ', async () => {
    const repository = {
      persist: vi.fn(async () => {
        throw new Error('pg down');
      }),
    };
    await expect(new OrderProcessor(repository as never).process(job as never)).rejects.toThrow(
      'pg down',
    );
  });
});
