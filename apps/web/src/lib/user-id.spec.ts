import { describe, expect, it } from 'vitest';
import { normalizeUserId, validateUserId } from './user-id';

describe('user identifier', () => {
  it('trims once without changing case', () => {
    expect(normalizeUserId('  MiA@X.Co  ')).toBe('MiA@X.Co');
  });
  it.each(['abc', 'a.b_c-d@e', 'a'.repeat(64)])('accepts %s', (value) =>
    expect(validateUserId(value)).toEqual({ ok: true, value }),
  );
  it.each(['', 'ab', 'a'.repeat(65), 'bad user', 'bad/name', 'bad:name', 'ümlaut'])(
    'rejects %s with stable copy',
    (value) =>
      expect(validateUserId(value)).toMatchObject({
        ok: false,
        message: 'Enter 3–64 characters using letters, numbers, ., _, @, or -.',
      }),
  );
});
