// packages/redis/src/scripts/seed.lua.ts
//
// Idempotent sale initialization — the only writer of the stock key at boot. Gated
// on EXISTS config so that N pods booting concurrently (a rolling restart, a
// crash-loop) can never reset stock mid-sale: exactly one pod observes 'SEEDED' and
// writes; every other pod observes 'ALREADY_SEEDED' and writes nothing. See
// .claude/contracts/phase-1.md §4.5.
//
// Source is verbatim per the frozen contract.
export const SEED_LUA_SRC = `-- seed.lua — idempotent sale initialization. The only writer of the stock key at boot.
-- KEYS[1] = sale:{<saleId>}:config
-- KEYS[2] = sale:{<saleId>}:stock
-- ARGV[1]=saleId ARGV[2]=name ARGV[3]=startsAt(ISO) ARGV[4]=endsAt(ISO)
-- ARGV[5]=startsAtMs ARGV[6]=endsAtMs ARGV[7]=totalStock ARGV[8]=stockRemaining
-- RETURN = { code, stockRemaining, totalStock, startsAtMs, endsAtMs }
if redis.call('EXISTS', KEYS[1]) == 1 then
  local cur = redis.call('HMGET', KEYS[1], 'startsAtMs', 'endsAtMs', 'totalStock')
  if redis.call('EXISTS', KEYS[2]) == 0 then
    return { 'STOCK_MISSING', -1, tonumber(cur[3]) or -1, tonumber(cur[1]) or -1, tonumber(cur[2]) or -1 }
  end
  local stock = tonumber(redis.call('GET', KEYS[2]))
  if cur[1] ~= ARGV[5] or cur[2] ~= ARGV[6] or cur[3] ~= ARGV[7] then
    return { 'CONFIG_DRIFT', stock, tonumber(cur[3]) or -1, tonumber(cur[1]) or -1, tonumber(cur[2]) or -1 }
  end
  return { 'ALREADY_SEEDED', stock, tonumber(cur[3]), tonumber(cur[1]), tonumber(cur[2]) }
end

redis.call('HSET', KEYS[1],
  'saleId',     ARGV[1],
  'name',       ARGV[2],
  'startsAt',   ARGV[3],
  'endsAt',     ARGV[4],
  'startsAtMs', ARGV[5],
  'endsAtMs',   ARGV[6],
  'totalStock', ARGV[7])
redis.call('SET', KEYS[2], ARGV[8])
return { 'SEEDED', tonumber(ARGV[8]), tonumber(ARGV[7]), tonumber(ARGV[5]), tonumber(ARGV[6]) }
`;
