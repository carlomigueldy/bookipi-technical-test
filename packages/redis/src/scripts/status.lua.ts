// packages/redis/src/scripts/status.lua.ts
//
// Read-only consistent snapshot backing GET /sale/status. One round trip, one clock:
// the countdown the SPA renders must be judged by the same TIME call that will judge
// the purchase. See .claude/contracts/phase-1.md §4.7.
//
// Source is verbatim per the frozen contract. No writes, no side effects.
export const STATUS_LUA_SRC = `-- status.lua — read-only snapshot. No writes, no side effects.
-- KEYS[1] = sale:{<saleId>}:config
-- KEYS[2] = sale:{<saleId>}:stock
-- RETURN = { nowMs, initialized, stockRemaining, totalStock, startsAtMs, endsAtMs, name, startsAt, endsAt }
local t     = redis.call('TIME')
local nowMs = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local cfg   = redis.call('HMGET', KEYS[1],
  'totalStock', 'startsAtMs', 'endsAtMs', 'name', 'startsAt', 'endsAt')

if cfg[1] == false then
  return { nowMs, 0, -1, -1, -1, -1, '', '', '' }
end

local stock = tonumber(redis.call('GET', KEYS[2]) or '-1')
return { nowMs, 1, stock,
  tonumber(cfg[1]), tonumber(cfg[2]), tonumber(cfg[3]),
  cfg[4], cfg[5], cfg[6] }
`;
