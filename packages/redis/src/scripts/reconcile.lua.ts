// packages/redis/src/scripts/reconcile.lua.ts
//
// POST-FREEZE ADDITION (.claude/contracts/phase-1.md §11.2, finding 2 of the Phase 1
// review — CRITICAL, I1/I4): `seed.lua`'s only gate is `EXISTS config`. That makes it
// correct for cold boot (nothing exists yet) but unusable for WARM recovery — the
// exact case PRD §3.5's boot reconciliation targets: Redis restarts with AOF
// `everysec`, loses up to ~1s of writes, config survives (it's rarely mutated) but
// stock/buyers may be short. `seed()` sees `EXISTS config == 1` and, because all
// three drift fields still match, returns ALREADY_SEEDED and writes NOTHING — the
// lost stock and buyer entries are never corrected, silently overselling (I1) and
// silently re-opening I2 for exactly the users whose SADD was lost.
//
// `reconcile.lua` is the deliberate, explicit-intent corrective write seed.lua
// refuses to perform. It is NOT a general-purpose stock setter: it never creates a
// sale (a missing config is NOT_INITIALIZED, not a seed), and it is intended to be
// called by exactly one caller — Phase 3's boot reconciliation — with a value derived
// from Postgres truth (`totalStock - persistedOrderCount`), never from a client
// request. Restoring the buyers/reservations side of I2 is `restoreReservations`
// (packages/redis/src/sale-store.ts), backed by the reservations hash `scanReservations`
// reads via HSCAN — see the store for the full recovery contract.
export const RECONCILE_LUA_SRC = `-- reconcile.lua — explicit-intent stock correction for Phase 3 boot reconciliation.
-- Never creates a sale; only corrects the stock counter of one that already exists.
-- KEYS[1] = sale:{<saleId>}:config
-- KEYS[2] = sale:{<saleId>}:stock
-- ARGV[1] = stockRemaining (canonical decimal; caller computes totalStock - persistedOrders)
-- RETURN  = { code, previousStock, newStock }
if redis.call('EXISTS', KEYS[1]) == 0 then
  return { 'NOT_INITIALIZED', -1, -1 }
end

local previous = redis.call('GET', KEYS[2])
local previousNum = previous and tonumber(previous) or -1
redis.call('SET', KEYS[2], ARGV[1])
return { 'RECONCILED', previousNum, tonumber(ARGV[1]) }
`;
