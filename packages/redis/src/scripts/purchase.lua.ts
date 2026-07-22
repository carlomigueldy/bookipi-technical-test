// packages/redis/src/scripts/purchase.lua.ts
//
// The atomic purchase decision. This is the serialization point for I1 (no oversell),
// I2 (one confirmed order per user) and I3 (window enforcement) — see
// .claude/contracts/phase-1.md §4.3. Redis's single-threaded command dispatcher is what
// makes check -> decrement -> record one indivisible unit; this script must never be
// split into multiple round trips from the client.
//
// POST-FREEZE REMEDIATION (.claude/contracts/phase-1.md §11.1/§11.3, findings 1 & 3 of
// the Phase 1 review): a 4th key, `sale:{<id>}:reservations`, and a caller-supplied
// `reservationId` (ARGV[2]) were added. Reasons, both load-bearing for I1/I2/I4:
//
//   1. `compensate.lua`'s original idempotency token was `SREM`'s return value against
//      the buyers Set — i.e. per-*membership*, not per-*reservation*. A user who is
//      compensated and then re-purchases becomes a member again, which silently
//      re-arms a stale, redelivered DLQ compensation for the FIRST reservation and lets
//      it tear down the SECOND (live, already-persisted) one. See §11.1 for the full
//      repro. Giving every CONFIRMED purchase a distinct identity, and gating
//      compensation on matching that identity (not just presence), closes this.
//   2. Prior to this change, CONFIRMED time recorded only Set membership — no
//      timestamp, no pending-persistence marker. A command-timeout or crash between the
//      Lua reply and the durable-write enqueue was therefore an undetectable, orphaned
//      reservation: nothing to enumerate, nothing to age out. The reservations hash
//      (`userId -> "<reservationId>:<reservedAtMs>"`) is the ledger Phase 3's DLQ
//      handler and boot sweep need to reconstruct exactly what requires persisting.
//
// The check ORDER above KEYS[3]/SADD is unchanged from the frozen §4.3 body — only the
// CONFIRMED branch gained one additional write and the RETURN tuple gained one field.
// Do not reorder the checks.
export const PURCHASE_LUA_SRC = `-- purchase.lua — the serialization point for I1, I2 and I3.
-- KEYS[1] = sale:{<saleId>}:config        (hash)
-- KEYS[2] = sale:{<saleId>}:stock         (string, integer)
-- KEYS[3] = sale:{<saleId>}:buyers        (set)
-- KEYS[4] = sale:{<saleId>}:reservations  (hash: userId -> "<reservationId>:<reservedAtMs>")
-- ARGV[1] = userId (binary-safe; never interpolated into the source)
-- ARGV[2] = reservationId (caller-generated UUID; binary-safe, never interpolated)
-- RETURN  = { code:string, stockRemaining:integer, nowMs:integer, reservationId:string }
local cfg        = redis.call('HMGET', KEYS[1], 'startsAtMs', 'endsAtMs')
local startsAtMs = tonumber(cfg[1])
local endsAtMs   = tonumber(cfg[2])
local t          = redis.call('TIME')
local nowMs      = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

if startsAtMs == nil or endsAtMs == nil then
  return { 'NOT_INITIALIZED', -1, nowMs, '' }
end

local stock = tonumber(redis.call('GET', KEYS[2]) or '0')
if stock < 0 then stock = 0 end

if nowMs < startsAtMs then
  return { 'SALE_NOT_STARTED', stock, nowMs, '' }
end
if nowMs >= endsAtMs then
  return { 'SALE_ENDED', stock, nowMs, '' }
end
if redis.call('SISMEMBER', KEYS[3], ARGV[1]) == 1 or
   redis.call('HEXISTS', KEYS[4], ARGV[1]) == 1 then
  redis.call('SADD', KEYS[3], ARGV[1])
  return { 'ALREADY_PURCHASED', stock, nowMs, '' }
end
if stock <= 0 then
  return { 'SOLD_OUT', 0, nowMs, '' }
end

local remaining = redis.call('DECR', KEYS[2])
redis.call('SADD', KEYS[3], ARGV[1])
redis.call('HSET', KEYS[4], ARGV[1], ARGV[2] .. ':' .. nowMs)
return { 'CONFIRMED', remaining, nowMs, ARGV[2] }
`;
