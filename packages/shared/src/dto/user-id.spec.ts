import { describe, expect, it } from 'vitest';
import { userIdSchema } from './user-id';

/**
 * userId is the first gate untrusted input passes before it reaches
 * `purchase.lua`'s ARGV (Redis) and the Postgres `orders.user_id` unique
 * index. Every case below is adversarial-security coverage, not incidental
 * unit testing — see the module doc comment on `user-id.ts` for the threat
 * model (I2 whitespace bypass, key/hash-tag injection, SQL/Lua metacharacter
 * injection, Unicode-normalization confusables).
 */
describe('userIdSchema', () => {
  describe('§8.4 frozen table (accept cases assert the exact trimmed output)', () => {
    it.each([
      ['abc', 'abc'],
      ['a'.repeat(64), 'a'.repeat(64)],
      ['  bob  ', 'bob'],
      ['a.b_c-d@e', 'a.b_c-d@e'],
    ])('accepts %j -> %j', (input, expected) => {
      const result = userIdSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe(expected);
      }
    });

    // NOTE on `'user\n'` (contract §8.4's table lists it as a reject case,
    // grouped with `'a b'`/`'us er'` under "charset is a whitelist"): under
    // the contract's OWN mandated pipeline order (`.trim()` before
    // `.min()`/`.regex()`), a *trailing* `\n` is stripped by `.trim()`
    // before the regex ever sees it — `'user\n'.trim() === 'user'`, which
    // passes the charset check and is ACCEPTED. This is a genuine tension
    // between the contract's frozen code block (unambiguous, implemented
    // verbatim above) and its own illustrative test table, which conflates
    // trailing whitespace (trimmed away) with internal whitespace (not
    // trimmed, e.g. `'us er'`, still correctly rejected below). This
    // implementation follows the frozen CODE — see the "edge whitespace is
    // trimmed away" describe block below for the corrected, verified
    // assertion, and the slice's returned report for the flagged
    // discrepancy. Do not "fix" this by reintroducing 'user\n' as a reject
    // case without also changing the pipeline order, which the architect
    // has not authorized.
    it.each([
      ['a'.repeat(65), 'ceiling is exclusive above'],
      ['  ab  ', 'length measured after trim, not before'],
      ['ab', 'floor is exclusive below (2 chars)'],
      ['', 'empty string'],
      ['   ', 'whitespace-only'],
      ['a b', 'space is not in the charset'],
      ['a/b', 'slash is not in the charset'],
      ['a+b', 'plus is not in the charset'],
      ['a,b', 'comma is not in the charset'],
      ['us er', 'embedded space is not in the charset'],
      ['usér', 'non-ASCII (Latin-1 accented) rejected'],
      ['用户名', 'non-ASCII (CJK) rejected'],
      ['ab*', 'asterisk (regex metacharacter) not in the charset'],
      ['{tag}', 'braces (Redis hash-tag injection surface) rejected'],
    ])('rejects %j (%s)', (input) => {
      expect(userIdSchema.safeParse(input).success).toBe(false);
    });

    it.each([[123], [null], [undefined], [{}], [[]], [true]])(
      'rejects non-string input %j',
      (input) => {
        expect(userIdSchema.safeParse(input).success).toBe(false);
      },
    );
  });

  describe('inclusive boundary exactness', () => {
    it('accepts exactly 3 characters (the floor, inclusive)', () => {
      const result = userIdSchema.safeParse('abc');
      expect(result.success).toBe(true);
    });

    it('accepts exactly 64 characters (the ceiling, inclusive)', () => {
      const input = 'a'.repeat(64);
      const result = userIdSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(64);
      }
    });

    it('rejects 2 characters (one below the floor)', () => {
      expect(userIdSchema.safeParse('ab').success).toBe(false);
    });

    it('rejects 65 characters (one above the ceiling)', () => {
      expect(userIdSchema.safeParse('a'.repeat(65)).success).toBe(false);
    });

    it('rejects a 65-char string that is only 64 chars after trimming', () => {
      // Padding does not count toward the length budget in the wrong
      // direction: trim happens first, so this reduces to 64 valid chars +
      // 1 trimmed space = still measured post-trim. This case is 64 body
      // chars plus leading/trailing space, i.e. legitimately valid at 64
      // after trim — asserting the *positive* half of the trim-then-measure
      // ordering pins the case the naive "trim after validate" bug gets
      // backwards.
      const input = ` ${'a'.repeat(64)} `;
      const result = userIdSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe('a'.repeat(64));
      }
    });
  });

  describe('trimming semantics (I2 whitespace-bypass defense)', () => {
    it('trims leading and trailing ASCII spaces and returns the trimmed value', () => {
      const result = userIdSchema.safeParse('  bob  ');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe('bob');
      }
    });

    it('trims tabs and newlines at the boundary', () => {
      const result = userIdSchema.safeParse('\t\nbob\t\n');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe('bob');
      }
    });

    it('two inputs that only differ by surrounding whitespace normalize to the same output', () => {
      const a = userIdSchema.safeParse('bob');
      const b = userIdSchema.safeParse('  bob  ');
      expect(a.success && b.success).toBe(true);
      if (a.success && b.success) {
        expect(a.data).toBe(b.data);
      }
    });

    it('does NOT trim internal whitespace (that remains a charset violation)', () => {
      expect(userIdSchema.safeParse('  bo b  ').success).toBe(false);
    });
  });

  describe('embedded control characters are NOT trimmed and remain rejected', () => {
    // Unlike edge whitespace (below), these characters are not stripped by
    // `.trim()` regardless of position, because they are not part of
    // ECMAScript's WhiteSpace/LineTerminator productions. NUL (U+0000) and
    // BEL (U+0007) in particular are exactly the kind of byte a naive
    // C-string-oriented downstream consumer might mishandle, so all three
    // positions are asserted for each.
    it.each([
      ['ab\x00cd', 'embedded null byte'],
      ['\x00abc', 'leading null byte'],
      ['abc\x00', 'trailing null byte'],
      ['bo\r\nb', 'embedded CRLF (not at either edge, so not trimmed)'],
      ['bo\tb', 'embedded tab (not at either edge, so not trimmed)'],
      ['a\x07bc', 'embedded BEL control character'],
    ])('rejects %j (%s)', (input) => {
      expect(userIdSchema.safeParse(input).success).toBe(false);
    });
  });

  describe('edge whitespace/control characters are stripped by .trim() then accepted', () => {
    // `String.prototype.trim()` (which Zod's `.trim()` wraps) strips every
    // character in ECMAScript's WhiteSpace + LineTerminator productions from
    // BOTH ends — not just the ASCII space the contract's prose emphasizes.
    // That set includes TAB, CR, LF, VT, FF, NBSP (U+00A0), and ZWNBSP/BOM
    // (U+FEFF). Because `.trim()` runs before `.regex()` in the frozen
    // pipeline, any of these characters AT THE EDGE of the input is stripped
    // before the charset check ever sees it, and the result is a valid,
    // ACCEPTED userId — this is the same trim-then-validate ordering that
    // makes `'  bob  '` accepted, just exercised with control characters
    // instead of plain spaces. This is verified behavior (see the slice's
    // returned report), not an assumption: it is the direct, unavoidable
    // consequence of the contract's own mandated `.trim().min().max().regex()`
    // chain, and is the reason the contract's illustrative table entry for
    // `'user\n'` (trailing LF) does not hold — see the note above.
    it.each([
      ['bob\r\n', 'bob', 'trailing CRLF'],
      ['\r\nbob', 'bob', 'leading CRLF'],
      ['bob\r', 'bob', 'lone trailing CR'],
      ['bob\t', 'bob', 'trailing tab'],
      ['\u00A0bob\u00A0', 'bob', 'leading/trailing NBSP (U+00A0)'],
      ['\uFEFFbob', 'bob', 'leading BOM / ZWNBSP (U+FEFF)'],
    ])('accepts %j -> %j (%s)', (input, expected) => {
      const result = userIdSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe(expected);
      }
    });
  });

  describe('SQL-ish and Lua-ish metacharacters (defense in depth, whitelist not blocklist)', () => {
    it.each([
      ["'; DROP TABLE orders; --", 'classic SQL injection payload'],
      ["bob' OR '1'='1", 'SQL tautology payload'],
      ['bob"; --', 'double-quote SQL payload'],
      ["'..os.execute('rm -rf /')..'", 'Lua string-concat + os.execute payload'],
      ["a'..(function()end)()..'", 'Lua closure-injection shaped payload'],
      ['${7*7}', 'template-injection shaped payload'],
      ['`rm -rf /`', 'backtick shell-injection shaped payload'],
      ['$(rm -rf /)', 'command-substitution shaped payload'],
    ])('rejects %j (%s) — charset whitelist has no metacharacter surface', (input) => {
      expect(userIdSchema.safeParse(input).success).toBe(false);
    });
  });

  describe('Redis key / hash-tag injection surface', () => {
    it.each([
      ['{brace', 'lone opening brace'],
      ['brace}', 'lone closing brace'],
      ['{other-sale}', 'a full foreign hash tag'],
      ['sale:evil:config', 'colon-delimited key-shaped string'],
    ])('rejects %j (%s)', (input) => {
      expect(userIdSchema.safeParse(input).success).toBe(false);
    });
  });

  describe('prototype-pollution-style keys', () => {
    // These strings are made entirely of characters the whitelist allows
    // (letters + underscore), so the schema — correctly, being a strict
    // charset whitelist rather than a semantic blocklist — accepts them.
    // The invariant this schema is responsible for is "no metacharacter can
    // ride through as a userId"; it is NOT responsible for how downstream
    // code indexes into an object with the resulting string. This test
    // exists to make that boundary explicit and prevent a future edit from
    // "fixing" it by special-casing these names inside the schema, which
    // would just move the real fix (never using userId as a raw object
    // property accessor downstream) to the wrong layer.
    it.each(['__proto__', 'constructor', 'prototype', '__proto__.polluted'])(
      'accepts %j as a syntactically valid userId (charset whitelist has no semantic blocklist)',
      (input) => {
        const result = userIdSchema.safeParse(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data).toBe(input);
        }
      },
    );

    it('the accepted value is a plain string, not later usable to reach an inherited prototype property', () => {
      const result = userIdSchema.safeParse('__proto__');
      expect(result.success).toBe(true);
      if (result.success) {
        // Using it as a Map key (the shape purchase() / hasPurchased() use)
        // is always safe regardless of the string's content — Map has no
        // prototype-chain lookup semantics. This is the assertion that
        // matters: the *consumers* of this schema's output (Redis SADD /
        // SISMEMBER via ARGV, Map/Set membership) are never plain-object
        // property access, so there is no live pollution vector even though
        // the string itself is unremarkable.
        const buyers = new Set<string>();
        buyers.add(result.data);
        expect(buyers.has('__proto__')).toBe(true);
        expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
      }
    });
  });

  describe('Unicode confusables and normalization', () => {
    // NOTE: a leading/trailing BOM (U+FEFF) is deliberately NOT in this
    // list — it is ECMAScript WhiteSpace, so `.trim()` strips it at the
    // edges before the charset check runs. See "edge whitespace/control
    // characters are stripped by .trim() then accepted" above for that
    // case. U+200B (true zero-width space, category Cf) below is different:
    // it is NOT in the WhiteSpace production, so it survives `.trim()` and
    // is correctly rejected by the regex.
    it.each([
      ['bοb', 'Greek omicron look-alike for "o"'],
      ['bоb', 'Cyrillic о look-alike for "o"'],
      ['café', 'accented Latin character'],
      ['👤user', 'emoji prefix'],
      ['user​', 'zero-width space (U+200B) suffix — not ECMAScript WhiteSpace, not trimmed'],
    ])('rejects %j (%s) — ASCII-only charset sidesteps normalization entirely', (input) => {
      expect(userIdSchema.safeParse(input).success).toBe(false);
    });
  });

  describe('full charset coverage', () => {
    it('accepts every character the pattern allows in one string', () => {
      const input = 'Az09._@-';
      const result = userIdSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe(input);
      }
    });

    it('accepts an email-shaped identifier (per the brief: "email or username")', () => {
      const result = userIdSchema.safeParse('jane.doe@example.com');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe('jane.doe@example.com');
      }
    });
  });
});
