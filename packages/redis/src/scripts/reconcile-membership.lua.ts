// Phase 3 buyer-membership repair. The ledger check and Set mutation must be one
// Redis serialization point so reconciliation cannot remove a just-created purchase.
export const RECONCILE_MEMBERSHIP_LUA_SRC = `-- reconcile-membership.lua — atomically align one buyer with the reservation ledger.
-- KEYS[1] = sale:{<saleId>}:buyers
-- KEYS[2] = sale:{<saleId>}:reservations
-- ARGV[1] = userId
if redis.call('HEXISTS', KEYS[2], ARGV[1]) == 1 then
  redis.call('SADD', KEYS[1], ARGV[1])
  return 'PRESENT'
end
redis.call('SREM', KEYS[1], ARGV[1])
return 'ABSENT'
`;
