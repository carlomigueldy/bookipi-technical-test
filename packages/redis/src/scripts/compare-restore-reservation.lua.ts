// Phase 3 A2 identity-safe reservation restoration. The compare and both writes
// share one Redis serialization point so a stale recovery candidate cannot replace
// a concurrently-created live reservation.
export const COMPARE_RESTORE_RESERVATION_LUA_SRC = `-- compare-restore-reservation.lua — identity CAS for reconciliation.
-- KEYS[1] = sale:{<saleId>}:buyers
-- KEYS[2] = sale:{<saleId>}:reservations
-- ARGV[1] = userId
-- ARGV[2] = reservationId
-- ARGV[3] = reservedAtMs
local current = redis.call('HGET', KEYS[2], ARGV[1])
local candidate = ARGV[2] .. ':' .. ARGV[3]

if not current then
  redis.call('HSET', KEYS[2], ARGV[1], candidate)
  redis.call('SADD', KEYS[1], ARGV[1])
  return {'RESTORED', candidate}
end

local separator = string.find(current, ':', 1, true)
local currentId = separator and string.sub(current, 1, separator - 1) or current

if currentId == ARGV[2] then
  redis.call('SADD', KEYS[1], ARGV[1])
  return {'ALREADY_MATCHED', current}
end

return {'CONFLICT', current}
`;
