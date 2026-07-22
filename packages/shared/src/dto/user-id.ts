/**
 * userId validation schema (Phase 1 contract §8.4). This is a SECURITY
 * boundary, not a formality: it is the first gate untrusted input passes
 * before it ever reaches `purchase.lua`'s `ARGV[1]` (Redis) or the Postgres
 * `orders.user_id` column. Treat any change here as invariant-affecting.
 *
 * Rule, exact: trimmed, 3–64 characters after trimming, matching
 * `/^[a-zA-Z0-9._@-]+$/` (letters, digits, `.`, `_`, `@`, `-`).
 *
 * `.trim()` MUST precede `.min()`/`.max()` — length is measured on the
 * trimmed value, not the raw input — and the schema's parsed OUTPUT is the
 * trimmed string. That trimmed string is what flows into `SADD` (I2) and the
 * Postgres unique index; if trimming happened after validation instead of as
 * part of the pipeline, `'  bob  '` and `'bob'` would be distinct set/row
 * members and I2 would be defeated by whitespace alone.
 *
 * The regex is a WHITELIST, not a blocklist: no key-injection surface (`{`,
 * `}`, `:`), no Lua metacharacter surface (`'`, `"`, newlines — userId only
 * ever travels as Redis `ARGV`, which is binary-safe, but a whitelist means
 * there is nothing to smuggle through it in the first place), and no
 * SQL-metacharacter surface either (the same string later becomes a bound
 * parameter for Postgres, never concatenated SQL, but again: nothing to
 * inject). Non-ASCII is deliberately rejected — the brief specifies an email
 * or username-shaped identifier, and a Unicode-normalization mismatch
 * (`'usér'` vs its NFC/NFD forms) is exactly the kind of thing that would
 * silently defeat I2 if it were allowed through.
 */
import { z } from 'zod';
import { USER_ID_MAX_LENGTH, USER_ID_MIN_LENGTH, USER_ID_PATTERN } from '../constants';

export const userIdSchema = z
  .string()
  .trim() // trim FIRST — length is measured after
  .min(USER_ID_MIN_LENGTH)
  .max(USER_ID_MAX_LENGTH)
  .regex(USER_ID_PATTERN);

export type UserId = z.infer<typeof userIdSchema>;
