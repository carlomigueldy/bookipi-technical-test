import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OrdersQueueJobPayload } from '@flash/shared';
import { OrderRepository, RECONCILIATION_LOCK_POLL_MS } from './order.repository.js';

const payload: OrdersQueueJobPayload = {
  saleId: 'flash-2026',
  userId: 'user-001',
  reservationId: '11111111-1111-4111-8111-111111111111',
  reservedAtMs: 1_700_000_000_000,
  requestId: 'request-1',
};
const workerEnv = {
  SALE_ID: 'flash-2026',
  SALE_NAME: 'Sale',
  SALE_TOTAL_STOCK: 10,
  SALE_STARTS_AT: '2026-07-22T12:00:00.000Z',
  SALE_ENDS_AT: '2026-07-22T13:00:00.000Z',
} as never;

function repository(
  results: Array<{ rowCount?: number; rows?: unknown[] } | Error>,
  reservationId = payload.reservationId,
) {
  const query = vi.fn(async (..._args: unknown[]) => {
    const next = results.shift() ?? { rows: [], rowCount: 0 };
    if (next instanceof Error) throw next;
    return {
      command: '',
      fields: [],
      oid: 0,
      rowCount: next.rowCount ?? next.rows?.length ?? 0,
      rows: next.rows ?? [],
    };
  });
  const client = { query, release: vi.fn() };
  const pool = { connect: vi.fn(async () => client) };
  const store = { getReservation: vi.fn(async () => ({ reservationId })) };
  return {
    repo: new OrderRepository(pool as never, workerEnv, store as never),
    pool,
    query,
    client,
    store,
  };
}

afterEach(() => vi.useRealTimers());

describe('OrderRepository.persist', () => {
  it('commits a newly inserted reservation', async () => {
    const { repo, query } = repository([
      {},
      { rows: [{ pid: 123 }] },
      {},
      { rowCount: 1, rows: [{ id: payload.reservationId, status: 'persisted' }] },
      {},
    ]);
    await expect(repo.persist(payload)).resolves.toBe('persisted');
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes('ON CONFLICT (user_id) DO NOTHING')),
    ).toBe(true);
    expect(query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
  });

  it('adjudicates same-id persisted delivery as idempotent', async () => {
    const { repo } = repository([
      {},
      { rows: [{ pid: 123 }] },
      {},
      { rowCount: 0 },
      { rows: [{ id: payload.reservationId, status: 'persisted' }] },
      {},
    ]);
    await expect(repo.persist(payload)).resolves.toBe('idempotent');
  });

  it('does not resurrect a same-id compensated reservation', async () => {
    const { repo } = repository([
      {},
      { rows: [{ pid: 123 }] },
      {},
      { rowCount: 0 },
      { rows: [{ id: payload.reservationId, status: 'compensated' }] },
      {},
    ]);
    await expect(repo.persist(payload)).resolves.toBe('compensated');
  });

  it('promotes a different compensated row only for the exact current ledger identity', async () => {
    const { repo, store } = repository([
      {},
      { rows: [{ pid: 123 }] },
      {},
      { rowCount: 0 },
      { rows: [{ id: '22222222-2222-4222-8222-222222222222', status: 'compensated' }] },
      { rowCount: 1 },
      {},
    ]);
    await expect(repo.persist(payload)).resolves.toBe('persisted');
    expect(store.getReservation).toHaveBeenCalled();
  });

  it('rejects a different persisted identity', async () => {
    const { repo, query } = repository([
      {},
      { rows: [{ pid: 123 }] },
      {},
      { rowCount: 0 },
      { rows: [{ id: '22222222-2222-4222-8222-222222222222', status: 'persisted' }] },
      {},
    ]);
    await expect(repo.persist(payload)).rejects.toThrow('permanent persistence conflict');
    expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });

  it('throws an indeterminate commit error', async () => {
    const { repo } = repository([
      {},
      { rows: [{ pid: 123 }] },
      {},
      { rowCount: 1, rows: [{}] },
      new Error('commit lost'),
    ]);
    await expect(repo.persist(payload)).rejects.toThrow('commit lost');
  });

  it('runs race hooks immediately before the advisory lock and after commit', async () => {
    const { repo, query } = repository([
      {},
      { rows: [{ pid: 456 }] },
      {},
      { rowCount: 1, rows: [{}] },
      {},
    ]);
    const before = vi.fn(async () => undefined);
    const after = vi.fn(async () => undefined);
    await repo.persist(payload, {
      beforePersisterAdvisoryLock: before,
      afterPersisterCommit: after,
    });
    expect(before).toHaveBeenCalledWith(456);
    expect(String(query.mock.calls[2]?.[0])).toContain('pg_advisory_xact_lock');
    expect(query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
    expect(after).toHaveBeenCalledOnce();
  });
});

describe('OrderRepository.resolveFailed', () => {
  it('never compensates a same-id persisted row', async () => {
    const { repo } = repository([
      {},
      {},
      { rows: [{ id: payload.reservationId, status: 'persisted' }] },
      {},
    ]);
    const compensate = vi.fn();
    await expect(repo.resolveFailed(payload, compensate)).resolves.toBe('persisted');
    expect(compensate).not.toHaveBeenCalled();
  });

  it('records compensation before commit', async () => {
    const { repo, query } = repository([{}, {}, { rows: [] }, { rowCount: 1 }, {}]);
    await expect(
      repo.resolveFailed(payload, async () => ({ outcome: 'COMPENSATED', stockRemaining: 10 })),
    ).resolves.toBe('compensated');
    expect(String(query.mock.calls.at(-2)?.[0])).toContain('INSERT INTO orders');
    expect(query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
  });

  it('runs the resolver absence hook under the advisory lock before compensation', async () => {
    const { repo, query } = repository([{}, {}, { rows: [] }, { rowCount: 1 }, {}]);
    const calls: string[] = [];
    await repo.resolveFailed(
      payload,
      async () => {
        calls.push('compensate');
        return { outcome: 'COMPENSATED', stockRemaining: 10 };
      },
      {
        afterResolverAbsentRead: async () => {
          calls.push('absent');
        },
      },
    );
    expect(String(query.mock.calls[1]?.[0])).toContain('pg_advisory_xact_lock');
    expect(calls).toEqual(['absent', 'compensate']);
  });
});

describe('OrderRepository.withSessionReconciliationLock', () => {
  it('polls false to true on one client, runs under ownership, unlocks, and releases once', async () => {
    vi.useFakeTimers();
    const { repo, query, client, pool } = repository([
      { rows: [{ acquired: false }] },
      { rows: [{ acquired: false }] },
      { rows: [{ acquired: true }] },
      { rows: [{ unlocked: true }] },
    ]);
    const work = vi.fn(async () => 'done');
    const locked = repo.withSessionReconciliationLock(work, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(RECONCILIATION_LOCK_POLL_MS * 2);
    await expect(locked).resolves.toBe('done');
    expect(pool.connect).toHaveBeenCalledOnce();
    expect(work).toHaveBeenCalledOnce();
    expect(
      query.mock.calls.filter(([sql]) => String(sql).includes('pg_try_advisory_lock')),
    ).toHaveLength(3);
    expect(String(query.mock.calls.at(-1)?.[0])).toContain('pg_advisory_unlock');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('aborts before acquisition without callback or unlock', async () => {
    vi.useFakeTimers();
    const { repo, query, client } = repository([{ rows: [{ acquired: false }] }]);
    const controller = new AbortController();
    const reason = new Error('planned stop');
    const work = vi.fn(async () => undefined);
    const locked = repo.withSessionReconciliationLock(work, controller.signal);
    controller.abort(reason);
    await expect(locked).rejects.toBe(reason);
    expect(work).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => String(sql).includes('pg_advisory_unlock'))).toBe(
      false,
    );
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('still unlocks when abort terminates owned work', async () => {
    const { repo, query, client } = repository([
      { rows: [{ acquired: true }] },
      { rows: [{ unlocked: true }] },
    ]);
    const controller = new AbortController();
    const work = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
            once: true,
          });
        }),
    );
    const locked = repo.withSessionReconciliationLock(work, controller.signal);
    await vi.waitFor(() => expect(work).toHaveBeenCalledOnce());
    controller.abort(new Error('stop after acquire'));
    await expect(locked).rejects.toThrow('stop after acquire');
    expect(String(query.mock.calls.at(-1)?.[0])).toContain('pg_advisory_unlock');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('preserves owned-work abort first and unlock failure second in one aggregate', async () => {
    const { repo, client } = repository([
      { rows: [{ acquired: true }] },
      new Error('unlock failed'),
    ]);
    const controller = new AbortController();
    const reason = new Error('exact abort reason');
    const work = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
            once: true,
          });
        }),
    );
    const locked = repo.withSessionReconciliationLock(work, controller.signal);
    await vi.waitFor(() => expect(work).toHaveBeenCalledOnce());
    controller.abort(reason);
    await expect(locked).rejects.toMatchObject({
      errors: [reason, expect.objectContaining({ message: 'unlock failed' })],
    });
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('aggregates work and unlock failures and rejects a false unlock', async () => {
    const first = repository([{ rows: [{ acquired: true }] }, new Error('unlock failed')]);
    const workFailure = first.repo.withSessionReconciliationLock(async () => {
      throw new Error('work failed');
    }, new AbortController().signal);
    await expect(workFailure).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ message: 'work failed' }),
        expect.objectContaining({ message: 'unlock failed' }),
      ],
    });
    expect(first.client.release).toHaveBeenCalledOnce();

    const second = repository([{ rows: [{ acquired: true }] }, { rows: [{ unlocked: false }] }]);
    await expect(
      second.repo.withSessionReconciliationLock(async () => 'done', new AbortController().signal),
    ).rejects.toThrow('session-lock cleanup failed');
    expect(second.client.release).toHaveBeenCalledOnce();
  });
});
