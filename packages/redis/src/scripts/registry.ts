// packages/redis/src/scripts/registry.ts
//
// The registry of Lua scripts, frozen shape per .claude/contracts/phase-1.md §4.8.
// `sha1` is computed client-side at module load time — not via `SCRIPT LOAD` — so
// there is no boot round-trip and no boot ordering requirement, and the value becomes
// a pure function of `src` that a unit test can cross-check against what the server
// itself reports for `SCRIPT LOAD src` (see scripts/registry.spec.ts, T5).
import { createHash } from 'node:crypto';

import { COMPARE_RESTORE_RESERVATION_LUA_SRC } from './compare-restore-reservation.lua';
import { COMPENSATE_LUA_SRC } from './compensate.lua';
import { PURCHASE_LUA_SRC } from './purchase.lua';
import { RECONCILE_LUA_SRC } from './reconcile.lua';
import { RECONCILE_MEMBERSHIP_LUA_SRC } from './reconcile-membership.lua';
import { RECONCILE_STATE_LUA_SRC } from './reconcile-state.lua';
import { SEED_LUA_SRC } from './seed.lua';
import { STATUS_LUA_SRC } from './status.lua';

export interface LuaScript {
  readonly name:
    | 'purchase'
    | 'compensate'
    | 'seed'
    | 'status'
    | 'reconcile'
    | 'reconcile-membership'
    | 'reconcile-state'
    | 'compare-restore-reservation';
  readonly src: string;
  readonly sha1: string;
  readonly numKeys: number;
}

function sha1(src: string): string {
  return createHash('sha1').update(src, 'utf8').digest('hex');
}

// numKeys bumped 3 -> 4 post-freeze: both scripts gained KEYS[4] = the reservations
// hash. See .claude/contracts/phase-1.md §11.1 and the *.lua.ts source comments.
export const PURCHASE_SCRIPT: LuaScript = {
  name: 'purchase',
  src: PURCHASE_LUA_SRC,
  sha1: sha1(PURCHASE_LUA_SRC),
  numKeys: 4,
};

export const COMPENSATE_SCRIPT: LuaScript = {
  name: 'compensate',
  src: COMPENSATE_LUA_SRC,
  sha1: sha1(COMPENSATE_LUA_SRC),
  numKeys: 4,
};

export const SEED_SCRIPT: LuaScript = {
  name: 'seed',
  src: SEED_LUA_SRC,
  sha1: sha1(SEED_LUA_SRC),
  numKeys: 2,
};

export const STATUS_SCRIPT: LuaScript = {
  name: 'status',
  src: STATUS_LUA_SRC,
  sha1: sha1(STATUS_LUA_SRC),
  numKeys: 2,
};

// Post-freeze addition, .claude/contracts/phase-1.md §11.2 (finding 2).
export const RECONCILE_SCRIPT: LuaScript = {
  name: 'reconcile',
  src: RECONCILE_LUA_SRC,
  sha1: sha1(RECONCILE_LUA_SRC),
  numKeys: 2,
};

export const RECONCILE_MEMBERSHIP_SCRIPT: LuaScript = {
  name: 'reconcile-membership',
  src: RECONCILE_MEMBERSHIP_LUA_SRC,
  sha1: sha1(RECONCILE_MEMBERSHIP_LUA_SRC),
  numKeys: 2,
};

export const RECONCILE_STATE_SCRIPT: LuaScript = {
  name: 'reconcile-state',
  src: RECONCILE_STATE_LUA_SRC,
  sha1: sha1(RECONCILE_STATE_LUA_SRC),
  numKeys: 3,
};

export const COMPARE_RESTORE_RESERVATION_SCRIPT: LuaScript = {
  name: 'compare-restore-reservation',
  src: COMPARE_RESTORE_RESERVATION_LUA_SRC,
  sha1: sha1(COMPARE_RESTORE_RESERVATION_LUA_SRC),
  numKeys: 2,
};

export const LUA_SCRIPTS: readonly LuaScript[] = [
  PURCHASE_SCRIPT,
  COMPENSATE_SCRIPT,
  SEED_SCRIPT,
  STATUS_SCRIPT,
  RECONCILE_SCRIPT,
  RECONCILE_MEMBERSHIP_SCRIPT,
  RECONCILE_STATE_SCRIPT,
  COMPARE_RESTORE_RESERVATION_SCRIPT,
];
