// Phase 5 A4 identity inspection. Both reads execute at one Redis serialization
// point and the script deliberately contains no mutation or repair command.
export const INSPECT_RESERVATION_MEMBERSHIP_LUA_SRC = `-- inspect-reservation-membership.lua — read-only atomic identity inspection.
-- KEYS[1] = sale:{<saleId>}:buyers
-- KEYS[2] = sale:{<saleId>}:reservations
-- ARGV[1] = userId
local buyerMember = redis.call('SISMEMBER', KEYS[1], ARGV[1])
local reservation = redis.call('HGET', KEYS[2], ARGV[1])

if buyerMember == 1 and reservation then
  return {'BOTH', reservation}
end
if buyerMember == 0 and not reservation then
  return {'NEITHER', ''}
end
if buyerMember == 1 then
  return {'BUYER_ONLY', ''}
end
return {'RESERVATION_ONLY', reservation}
`;
