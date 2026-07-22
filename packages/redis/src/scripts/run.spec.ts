// T4 — NOSCRIPT fallback (.claude/contracts/phase-1.md §6.3).
//
// `SCRIPT FLUSH`, a Redis restart without AOF script-cache persistence, a failover to a
// replica that never saw the script, or `redis-cli DEBUG RELOAD` all empty the server's
// script cache. Without the EVALSHA -> EVAL fallback, every purchase after that returns
// NOSCRIPT — a total outage of the hot path from an operation that is supposed to be
// harmless. This spec proves the fallback fires, reloads the script, and — just as
// importantly — never masks or retries a genuinely different error.
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { saleKeys } from '@flash/shared';

import { cleanup, connect, seedActiveSale } from '../../test/harness';
import { SaleRedisStore } from '../sale-store';
import { PURCHASE_SCRIPT } from './registry';
import { isNoScriptError, runScript } from './run';

describe('isNoScriptError', () => {
  it('matches the exact error Redis raises for an empty script cache', () => {
    expect(isNoScriptError(new Error('NOSCRIPT No matching script. Please use EVAL.'))).toBe(true);
  });

  it('does not match unrelated errors, non-Error values, or nothing at all', () => {
    expect(isNoScriptError(new Error('ERR wrong number of arguments for evalsha'))).toBe(false);
    expect(isNoScriptError('a plain string, not an Error instance')).toBe(false);
    expect(isNoScriptError(undefined)).toBe(false);
    expect(isNoScriptError(null)).toBe(false);
  });
});

describe('runScript — EVALSHA -> EVAL fallback', () => {
  let client: Redis;
  let store: SaleRedisStore;
  let saleId: string;

  beforeAll(async () => {
    client = connect();
    store = new SaleRedisStore(client);
    saleId = await seedActiveSale(store, { stock: 5 });
  });

  afterAll(async () => {
    await cleanup(saleId);
    client.disconnect();
  });

  it('cold cache -> EVAL reload -> SCRIPT FLUSH -> EVAL reload again (T4 a-g)', async () => {
    // Force a genuinely cold cache for this scenario, independent of whatever any
    // other spec file sharing this Redis server already loaded. SCRIPT FLUSH is
    // explicitly permitted in the test harness (never in production code, per
    // .claude/contracts/phase-1.md §5.1's forbidden-commands list).
    await client.script('FLUSH', 'SYNC');

    // (a) SCRIPT EXISTS -> 0 on a cold server.
    expect(await client.script('EXISTS', PURCHASE_SCRIPT.sha1)).toEqual([0]);

    // (b) purchase() succeeds — EVALSHA misses with NOSCRIPT, runScript falls back to
    // EVAL exactly once, which both executes the purchase AND loads the script.
    const first = await store.purchase(saleId, 'run-spec-user-1');
    expect(first.outcome).toBe('CONFIRMED');

    // (c) SCRIPT EXISTS -> 1, proving the EVAL fallback loaded it as a side effect.
    expect(await client.script('EXISTS', PURCHASE_SCRIPT.sha1)).toEqual([1]);

    // (d) empty the cache again.
    await client.script('FLUSH', 'SYNC');

    // (e) confirmed empty.
    expect(await client.script('EXISTS', PURCHASE_SCRIPT.sha1)).toEqual([0]);

    // (f) purchase() succeeds again with the correct decremented outcome — proves the
    // fallback is not a one-shot fluke tied to the first-ever call.
    const second = await store.purchase(saleId, 'run-spec-user-2');
    expect(second.outcome).toBe('CONFIRMED');
    expect(second.stockRemaining).toBe(first.stockRemaining - 1);

    // (g) SCRIPT EXISTS -> 1 again, proving the second EVAL fallback re-loaded it.
    expect(await client.script('EXISTS', PURCHASE_SCRIPT.sha1)).toEqual([1]);
  });

  it('a client-side numKeys mismatch throws before any network call is made', async () => {
    const spyClient = connect();
    let evalshaCalls = 0;
    let evalCalls = 0;
    const originalEvalsha = spyClient.evalsha.bind(spyClient);
    const originalEval = spyClient.eval.bind(spyClient);
    spyClient.evalsha = ((...args: unknown[]) => {
      evalshaCalls += 1;
      return (originalEvalsha as (...a: unknown[]) => unknown)(...args);
    }) as typeof spyClient.evalsha;
    spyClient.eval = ((...args: unknown[]) => {
      evalCalls += 1;
      return (originalEval as (...a: unknown[]) => unknown)(...args);
    }) as typeof spyClient.eval;

    const badScript = { ...PURCHASE_SCRIPT, numKeys: 99 };

    try {
      await expect(runScript(spyClient, badScript, [saleId], ['someone'])).rejects.toThrow(
        /expects 99 KEYS, received 1/,
      );
      expect(evalshaCalls).toBe(0);
      expect(evalCalls).toBe(0);
    } finally {
      spyClient.disconnect();
    }
  });

  it('a real, non-NOSCRIPT Redis error is rethrown without attempting the EVAL fallback', async () => {
    // Precondition: the first test in this file leaves PURCHASE_SCRIPT's sha cached.
    expect(await client.script('EXISTS', PURCHASE_SCRIPT.sha1)).toEqual([1]);

    const spyClient = connect();
    let evalCalls = 0;
    const originalEval = spyClient.eval.bind(spyClient);
    spyClient.eval = ((...args: unknown[]) => {
      evalCalls += 1;
      return (originalEval as (...a: unknown[]) => unknown)(...args);
    }) as typeof spyClient.eval;

    const keys = saleKeys(saleId);
    try {
      // Pass the correct KEYS count (4, post-freeze — see .claude/contracts/phase-1.md
      // §11.1) but omit ARGV[1] (userId): the script's own SISMEMBER call then passes a
      // Lua nil into redis.call, which Redis rejects with a genuine Lua-argument error —
      // a real server-side error that is emphatically not NOSCRIPT. (Getting the KEYS
      // count wrong would instead trip runScript's own client-side assertion before any
      // network call — a different code path than the one this test exists to prove.)
      await expect(
        runScript(
          spyClient,
          PURCHASE_SCRIPT,
          [keys.config, keys.stock, keys.buyers, keys.reservations],
          [],
        ),
      ).rejects.toThrow();
      expect(evalCalls).toBe(0);
    } finally {
      spyClient.disconnect();
    }
  });
});
