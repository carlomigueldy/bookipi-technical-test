import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SaleSnapshot } from '@flash/redis';

import { SaleSnapshotCache } from './sale-snapshot.cache.js';

function buildSnapshot(overrides: Partial<SaleSnapshot> = {}): SaleSnapshot {
  return {
    initialized: true,
    saleId: 'flash-2026',
    name: 'Aurora',
    startsAt: '2026-07-22T12:00:00.000Z',
    endsAt: '2026-07-22T13:00:00.000Z',
    startsAtMs: Date.parse('2026-07-22T12:00:00.000Z'),
    endsAtMs: Date.parse('2026-07-22T13:00:00.000Z'),
    totalStock: 500,
    stockRemaining: 480,
    serverTimeMs: Date.parse('2026-07-22T12:00:05.000Z'),
    state: 'active',
    ...overrides,
  };
}

describe('SaleSnapshotCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-22T12:00:05.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('get() returns null before any update has landed', () => {
    const cache = new SaleSnapshotCache();
    expect(cache.get()).toBeNull();
  });

  it('get() returns the last snapshot with ageMs computed from elapsed wall-clock time', () => {
    const cache = new SaleSnapshotCache();
    const snapshot = buildSnapshot();
    cache.update(snapshot, Date.now());

    vi.advanceTimersByTime(1234);

    const entry = cache.get();
    expect(entry).not.toBeNull();
    expect(entry!.snapshot).toEqual(snapshot);
    expect(entry!.ageMs).toBe(1234);
  });

  it('ageMs is ~0 immediately after an update', () => {
    const cache = new SaleSnapshotCache();
    cache.update(buildSnapshot(), Date.now());
    expect(cache.get()!.ageMs).toBe(0);
  });

  it('a later update replaces the entry entirely (no merge of stale fields)', () => {
    const cache = new SaleSnapshotCache();
    cache.update(buildSnapshot({ stockRemaining: 480 }), Date.now());

    vi.advanceTimersByTime(5000);
    const second = buildSnapshot({ stockRemaining: 10 });
    cache.update(second, Date.now());

    const entry = cache.get();
    expect(entry!.snapshot.stockRemaining).toBe(10);
    expect(entry!.ageMs).toBe(0);
  });

  it('preserves initialized: false snapshots verbatim (HealthService reads this field)', () => {
    const cache = new SaleSnapshotCache();
    const notInitialized = buildSnapshot({ initialized: false, stockRemaining: 0 });
    cache.update(notInitialized, Date.now());
    expect(cache.get()!.snapshot.initialized).toBe(false);
  });
});
