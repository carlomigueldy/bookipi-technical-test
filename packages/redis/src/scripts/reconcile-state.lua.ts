// Phase 3 stock repair. The desired stock is derived inside Redis from the live
// reservation ledger, never from a caller-computed Postgres count.
export const RECONCILE_STATE_LUA_SRC = `-- reconcile-state.lua — atomically derive stock from totalStock - HLEN(reservations).
-- KEYS[1] = sale:{<saleId>}:config
-- KEYS[2] = sale:{<saleId>}:stock
-- KEYS[3] = sale:{<saleId>}:reservations
if redis.call('EXISTS', KEYS[1]) == 0 then return {'NOT_INITIALIZED',-1,-1,0,-1} end
local total = tonumber(redis.call('HGET', KEYS[1], 'totalStock') or '-1')
local count = redis.call('HLEN', KEYS[3])
local previous = tonumber(redis.call('GET', KEYS[2]) or '-1')
if total < 0 or count > total then
  return {'OVERCOMMITTED',previous,previous,count,total}
end
local desired = total - count
redis.call('SET', KEYS[2], desired)
return {'RECONCILED',previous,desired,count,total}
`;
