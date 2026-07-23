// T5 — SHA correctness (.claude/contracts/phase-1.md §6.3).
//
// For every registered script: the client-computed sha1 must equal what the server itself
// returns from `SCRIPT LOAD src`, and `numKeys` must match the highest `KEYS[n]`
// actually referenced in the source. This is a Lua-adjacent spec (it exercises a real
// server's SCRIPT LOAD), so it uses the package's real-Redis harness rather than
// running as a pure unit test.
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { connect } from '../../test/harness';
import {
  COMPARE_RESTORE_RESERVATION_SCRIPT,
  INSPECT_RESERVATION_MEMBERSHIP_SCRIPT,
  LUA_SCRIPTS,
} from './registry';

describe('script registry', () => {
  let client: Redis;

  beforeAll(() => {
    client = connect();
  });

  afterAll(() => {
    client.disconnect();
  });

  it.each(LUA_SCRIPTS)(
    "$name: client-computed sha1 matches the server's SCRIPT LOAD result",
    async (script) => {
      const serverSha = await client.script('LOAD', script.src);
      expect(script.sha1).toBe(serverSha);
    },
  );

  it.each(LUA_SCRIPTS)(
    '$name: numKeys equals the highest KEYS[n] referenced in the source',
    (script) => {
      const indices = [...script.src.matchAll(/KEYS\[(\d+)\]/g)].map((m) => Number(m[1]));
      expect(indices.length).toBeGreaterThan(0);
      expect(Math.max(...indices)).toBe(script.numKeys);
      // And the inverse: nothing references an index beyond numKeys.
      expect(Math.min(...indices)).toBe(1);
    },
  );

  it('every script name is unique and every sha1 is a 40-char hex string', () => {
    const names = LUA_SCRIPTS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    for (const script of LUA_SCRIPTS) {
      expect(script.sha1).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it('registers the Phase 3 A2 compare-and-restore identity CAS with exactly two keys', () => {
    expect(COMPARE_RESTORE_RESERVATION_SCRIPT.name).toBe('compare-restore-reservation');
    expect(COMPARE_RESTORE_RESERVATION_SCRIPT.numKeys).toBe(2);
    expect(LUA_SCRIPTS).toContain(COMPARE_RESTORE_RESERVATION_SCRIPT);
  });

  it('A4 — registry pins inspect-reservation-membership name, sha1, key count, and membership', async () => {
    expect(INSPECT_RESERVATION_MEMBERSHIP_SCRIPT.name).toBe('inspect-reservation-membership');
    expect(INSPECT_RESERVATION_MEMBERSHIP_SCRIPT.numKeys).toBe(2);
    expect(INSPECT_RESERVATION_MEMBERSHIP_SCRIPT.sha1).toMatch(/^[0-9a-f]{40}$/);
    expect(await client.script('LOAD', INSPECT_RESERVATION_MEMBERSHIP_SCRIPT.src)).toBe(
      INSPECT_RESERVATION_MEMBERSHIP_SCRIPT.sha1,
    );
    expect(LUA_SCRIPTS).toContain(INSPECT_RESERVATION_MEMBERSHIP_SCRIPT);
  });
});
