// Import-then-export (not `export * from` / `export { X } from`) for the same reason
// documented in `@flash/shared/src/index.ts`: TypeScript compiles both re-export forms
// for CJS targets into a shape Rollup's commonjs interop (used by apps/web's Vite
// build) cannot statically resolve named imports against. A plain local import +
// export compiles to a simple, statically analyzable `exports.X = mod.X;` assignment.
import { createRedisClient, closeRedisClient } from './client';
import type { CreateRedisClientOptions } from './client';
import { SaleRedisStore } from './sale-store';
import type {
  CompensateOutcome,
  CompensateResult,
  PurchaseResult,
  ReconcileOutcome,
  ReconcileResult,
  ReservationEntry,
  ReservationRestoreInput,
  SaleConfigInput,
  SaleSnapshot,
  SeedOutcome,
  SeedResult,
} from './types';
import {
  LUA_SCRIPTS,
  PURCHASE_SCRIPT,
  COMPENSATE_SCRIPT,
  SEED_SCRIPT,
  STATUS_SCRIPT,
  RECONCILE_SCRIPT,
} from './scripts/registry';
import type { LuaScript } from './scripts/registry';
import { isNoScriptError, runScript } from './scripts/run';

export {
  createRedisClient,
  closeRedisClient,
  SaleRedisStore,
  LUA_SCRIPTS,
  PURCHASE_SCRIPT,
  COMPENSATE_SCRIPT,
  SEED_SCRIPT,
  STATUS_SCRIPT,
  RECONCILE_SCRIPT,
  isNoScriptError,
  runScript,
};
export type {
  CreateRedisClientOptions,
  CompensateOutcome,
  CompensateResult,
  PurchaseResult,
  ReconcileOutcome,
  ReconcileResult,
  ReservationEntry,
  ReservationRestoreInput,
  SaleConfigInput,
  SaleSnapshot,
  SeedOutcome,
  SeedResult,
  LuaScript,
};
