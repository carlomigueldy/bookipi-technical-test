import { describe, expect, it } from 'vitest';
import {
  SALE_ID_PATTERN,
  assertSaleId,
  saleBuyersKey,
  saleConfigKey,
  saleHashTag,
  saleKeys,
  saleMetricsKey,
  saleReservationsKey,
  saleStockKey,
} from './keys';

const SALE_ID = 'flash-2026';

describe('key builders — literal strings for saleId = "flash-2026"', () => {
  it('saleHashTag wraps the id in literal braces', () => {
    expect(saleHashTag(SALE_ID)).toBe('{flash-2026}');
  });

  it('saleConfigKey', () => {
    expect(saleConfigKey(SALE_ID)).toBe('sale:{flash-2026}:config');
  });

  it('saleStockKey', () => {
    expect(saleStockKey(SALE_ID)).toBe('sale:{flash-2026}:stock');
  });

  it('saleBuyersKey', () => {
    expect(saleBuyersKey(SALE_ID)).toBe('sale:{flash-2026}:buyers');
  });

  it('saleMetricsKey', () => {
    expect(saleMetricsKey(SALE_ID)).toBe('sale:{flash-2026}:metrics');
  });

  it('saleReservationsKey', () => {
    expect(saleReservationsKey(SALE_ID)).toBe('sale:{flash-2026}:reservations');
  });

  it('saleKeys returns all five as one object', () => {
    expect(saleKeys(SALE_ID)).toEqual({
      config: 'sale:{flash-2026}:config',
      stock: 'sale:{flash-2026}:stock',
      buyers: 'sale:{flash-2026}:buyers',
      metrics: 'sale:{flash-2026}:metrics',
      reservations: 'sale:{flash-2026}:reservations',
    });
  });
});

describe('cluster-correctness: every key of one sale shares one hash tag', () => {
  it('extracts an identical {tag} from all five keys, equal to the saleId', () => {
    const keys = saleKeys(SALE_ID);
    const tagPattern = /\{([^}]*)\}/;

    const tags = Object.values(keys).map((key) => {
      const match = tagPattern.exec(key);
      expect(match, `key "${key}" must contain a {tag}`).not.toBeNull();
      return match![1];
    });

    // every captured tag is identical...
    expect(new Set(tags).size).toBe(1);
    // ...and equals the saleId, i.e. all four keys hash to the same cluster slot.
    expect(tags[0]).toBe(SALE_ID);
  });
});

describe('SALE_ID_PATTERN / assertSaleId', () => {
  it.each([
    ['flash-2026', true],
    ['a', true],
    ['a'.repeat(64), true],
    ['', false],
    ['a b', false],
    ['has{brace', false],
    ['has}brace', false],
    ['has:colon', false],
    ['UPPER', false],
    ['a'.repeat(65), false],
  ])('SALE_ID_PATTERN.test(%j) === %s', (input, expected) => {
    expect(SALE_ID_PATTERN.test(input)).toBe(expected);
  });

  it('accepts a valid saleId without throwing', () => {
    expect(() => assertSaleId('flash-2026')).not.toThrow();
  });

  it('rejects an empty string', () => {
    expect(() => assertSaleId('')).toThrow(TypeError);
  });

  it('rejects a saleId containing a space', () => {
    expect(() => assertSaleId('a b')).toThrow(TypeError);
  });

  it('rejects a saleId containing an opening brace (would split the hash tag)', () => {
    expect(() => assertSaleId('has{brace')).toThrow(TypeError);
  });

  it('rejects a saleId containing a closing brace (would split the hash tag)', () => {
    expect(() => assertSaleId('has}brace')).toThrow(TypeError);
  });

  it('rejects a saleId containing a colon', () => {
    expect(() => assertSaleId('has:colon')).toThrow(TypeError);
  });

  it('rejects an uppercase saleId', () => {
    expect(() => assertSaleId('UPPER')).toThrow(TypeError);
  });

  it('rejects a 65-character saleId (over the 64-char ceiling)', () => {
    expect(() => assertSaleId('a'.repeat(65))).toThrow(TypeError);
  });

  it('every key builder rejects an invalid saleId before building anything', () => {
    expect(() => saleConfigKey('has{brace')).toThrow(TypeError);
    expect(() => saleStockKey('has{brace')).toThrow(TypeError);
    expect(() => saleBuyersKey('has{brace')).toThrow(TypeError);
    expect(() => saleMetricsKey('has{brace')).toThrow(TypeError);
    expect(() => saleReservationsKey('has{brace')).toThrow(TypeError);
    expect(() => saleKeys('has{brace')).toThrow(TypeError);
  });
});
