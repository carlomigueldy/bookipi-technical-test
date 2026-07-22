import { USER_ID_MAX_LENGTH, USER_ID_MIN_LENGTH, USER_ID_PATTERN } from '@flash/shared';

export const USER_ID_ERROR = 'Enter 3–64 characters using letters, numbers, ., _, @, or -.';

export function normalizeUserId(raw: string): string {
  return raw.trim();
}

export function validateUserId(
  raw: string,
): { ok: true; value: string } | { ok: false; message: string } {
  const value = normalizeUserId(raw);
  if (
    value.length < USER_ID_MIN_LENGTH ||
    value.length > USER_ID_MAX_LENGTH ||
    !USER_ID_PATTERN.test(value)
  ) {
    return { ok: false, message: USER_ID_ERROR };
  }
  return { ok: true, value };
}
