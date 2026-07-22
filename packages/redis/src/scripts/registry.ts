// packages/redis/src/scripts/registry.ts
//
// The registry of Lua scripts, frozen shape per .claude/contracts/phase-1.md §4.8.
// `sha1` is computed client-side at module load time — not via `SCRIPT LOAD` — so
// there is no boot round-trip and no boot ordering requirement, and the value becomes
// a pure function of `src` that a unit test can cross-check against what the server
// itself reports for `SCRIPT LOAD src` (see scripts/registry.spec.ts, T5).
import { createHash } from 'node:crypto';

import { COMPENSATE_LUA_SRC } from './compensate.lua';
import { PURCHASE_LUA_SRC } from './purchase.lua';
import { RECONCILE_LUA_SRC } from './reconcile.lua';
import { SEED_LUA_SRC } from './seed.lua';
import { STATUS_LUA_SRC } from './status.lua';

export interface LuaScript {
  readonly name: 'purchase' | 'compensate' | 'seed' | 'status' | 'reconcile';
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

export const LUA_SCRIPTS: readonly LuaScript[] = [
  PURCHASE_SCRIPT,
  COMPENSATE_SCRIPT,
  SEED_SCRIPT,
  STATUS_SCRIPT,
  RECONCILE_SCRIPT,
];
