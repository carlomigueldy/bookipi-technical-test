/**
 * DI token registry — frozen contract §4.1. Exact literal string values; no
 * slice invents another. Every other file in this app that needs one of
 * these tokens imports it from here.
 *
 * Reconciliation note: `PerUserRateLimitGuard` (`common/per-user-rate-limit.guard.ts`)
 * was written before this file existed and, per its own header comment,
 * locally re-declares `API_ENV` / `REDIS_LIMIT_CLIENT` as an interim measure.
 * The literal values below were chosen to be byte-identical to that file's
 * local declarations specifically so nothing needs to change at runtime —
 * Nest resolves DI tokens by string equality, so `@Inject('API_ENV')` there
 * and `@Inject(API_ENV)` here already refer to the same binding. Folding that
 * file over to import from here is a safe, optional follow-up refactor, left
 * undone in this pass to avoid touching already-tested code with a
 * pure-style change under time pressure.
 */
export const API_ENV = 'API_ENV'; // ApiEnv (parsed, frozen object)
export const REDIS_STORE_CLIENT = 'REDIS_STORE_CLIENT'; // ioredis — hot path ONLY
export const REDIS_LIMIT_CLIENT = 'REDIS_LIMIT_CLIENT'; // ioredis — rate limiter ONLY
export const SALE_REDIS_STORE = 'SALE_REDIS_STORE'; // SaleRedisStore
export const PG_POOL = 'PG_POOL'; // pg.Pool
export const CLOCK = 'CLOCK'; // Clock (interface, §5.1)
export const SALE_SNAPSHOT_CACHE = 'SALE_SNAPSHOT_CACHE'; // SaleSnapshotCache
export const QUEUE_DEPTH_PROBE = 'QUEUE_DEPTH_PROBE'; // QueueDepthProbe
