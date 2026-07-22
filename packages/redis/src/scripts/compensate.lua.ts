// packages/redis/src/scripts/compensate.lua.ts
//
// The DLQ compensation path (Phase 3 uses this to return stock and remove a buyer
// after a failed durable write). Compensating the same reservation twice must never
// inflate stock above totalStock — see .claude/contracts/phase-1.md §4.6.
//
// POST-FREEZE REMEDIATION (.claude/contracts/phase-1.md §11.1, finding 1 of the Phase
// 1 review — CRITICAL, I1/I2/I4): the ORIGINAL idempotency token was `SREM`'s return
// value against the buyers Set — 1 on first removal, 0 ever after. That is a token
// per membership, not per reservation, and it is NOT safe under the exact hazard the
// old comment on this file called out ("it runs on an at-least-once queue, so it WILL
// execute twice"): if the user is compensated and then legitimately re-purchases
// (getting a NEW reservation), they become a Set member again, which silently re-arms
// the STALE compensation job for the FIRST reservation. When the at-least-once queue
// redelivers it, `SREM` finds the member present (from the second purchase) and
// returns 1 again — not a NOOP — tearing down the live, already-persisted second
// reservation: stock is inflated by one unit above what's truly outstanding (I1), the
// user's buyer-set guard is erased so they can purchase a THIRD time (I2), and the
// second order silently disappears from Redis's point of view while it still exists
// in Postgres (I4). Reproduced verbatim against redis:7.4-alpine; see contract §11.1
// for the full timeline.
//
// FIX: the idempotency token is now reservation IDENTITY, carried in
// `sale:{<id>}:reservations` (written atomically by purchase.lua). Compensation must
// present the SAME reservationId currently on file for that user before it is allowed
// to touch stock or the buyers Set; a stale/redelivered job whose reservationId no
// longer matches (because the user has since re-purchased) is now unconditionally a
// NOOP, regardless of Set membership. The hash entry is deleted in the same atomic
// step as the match, so a *correctly* redelivered compensation (same reservationId,
// e.g. plain at-least-once redelivery of the same job) is still a single-use token —
// second and further deliveries see `HGET` return nil and NOOP, exactly as before.
//
// No window check, deliberately: most DLQ traffic lands after endsAt, and gating
// compensation on the window would strand stock and violate I4.
export const COMPENSATE_LUA_SRC = `-- compensate.lua — DLQ compensation. Idempotent by reservation identity. NO window check (deliberate).
-- KEYS[1] = sale:{<saleId>}:config
-- KEYS[2] = sale:{<saleId>}:stock
-- KEYS[3] = sale:{<saleId>}:buyers
-- KEYS[4] = sale:{<saleId>}:reservations
-- ARGV[1] = userId
-- ARGV[2] = reservationId — must equal the CURRENT reservation on file for this user
-- RETURN  = { code, stockRemaining }
local current = redis.call('HGET', KEYS[4], ARGV[1])
local stock   = tonumber(redis.call('GET', KEYS[2]) or '0')

if current == false then
  return { 'NOOP', stock }
end

local sep = string.find(current, ':')
local currentReservationId = sep and string.sub(current, 1, sep - 1) or current
if currentReservationId ~= ARGV[2] then
  return { 'NOOP', stock }
end

redis.call('HDEL', KEYS[4], ARGV[1])
local removed = redis.call('SREM', KEYS[3], ARGV[1])

if removed == 0 then
  return { 'NOOP', stock }
end

local total = tonumber(redis.call('HGET', KEYS[1], 'totalStock'))
if total ~= nil and stock >= total then
  return { 'COMPENSATED_CAPPED', stock }
end

local remaining = redis.call('INCR', KEYS[2])
return { 'COMPENSATED', remaining }
`;
