import { describe, expect, it } from 'vitest';
import { deriveSaleState, isWithinSaleWindow, msUntilNextTransition } from './sale-state';

/**
 * §3.3's boundary table is normative and asserted verbatim here, as explicit
 * named cases — not a loop that would obscure which boundary failed. `S` and
 * `E` below are literal `startsAtMs` / `endsAtMs`, stock defaults to 5 unless
 * a row overrides it, exactly as the contract specifies.
 */
describe('deriveSaleState — half-open window [startsAt, endsAt) boundary table (§3.3)', () => {
  const S = 1_000_000; // startsAtMs
  const E = 2_000_000; // endsAtMs
  const DEFAULT_STOCK = 5;

  it('S - 1  ->  upcoming', () => {
    expect(
      deriveSaleState({ nowMs: S - 1, startsAtMs: S, endsAtMs: E, stockRemaining: DEFAULT_STOCK }),
    ).toBe('upcoming');
  });

  it('S (exact)  ->  active  (inclusive lower bound)', () => {
    expect(
      deriveSaleState({ nowMs: S, startsAtMs: S, endsAtMs: E, stockRemaining: DEFAULT_STOCK }),
    ).toBe('active');
  });

  it('S + 1  ->  active', () => {
    expect(
      deriveSaleState({ nowMs: S + 1, startsAtMs: S, endsAtMs: E, stockRemaining: DEFAULT_STOCK }),
    ).toBe('active');
  });

  it('E - 1  ->  active', () => {
    expect(
      deriveSaleState({ nowMs: E - 1, startsAtMs: S, endsAtMs: E, stockRemaining: DEFAULT_STOCK }),
    ).toBe('active');
  });

  it('E (exact)  ->  ended  (exclusive upper bound)', () => {
    expect(
      deriveSaleState({ nowMs: E, startsAtMs: S, endsAtMs: E, stockRemaining: DEFAULT_STOCK }),
    ).toBe('ended');
  });

  it('E + 1  ->  ended', () => {
    expect(
      deriveSaleState({ nowMs: E + 1, startsAtMs: S, endsAtMs: E, stockRemaining: DEFAULT_STOCK }),
    ).toBe('ended');
  });

  // CONTRACT DEFECT (reported, not silently deviated from — see slice return
  // value): §3.3's table literally lists this row's `deriveSaleState` cell as
  // `upcoming`, but that contradicts (a) §3.2's frozen ordered-precedence
  // rules — rule 1 is `nowMs < startsAtMs`, a STRICT inequality, so at
  // `nowMs === startsAtMs` it does not fire, regardless of stock; (b) the same
  // row's other two columns (`isWithinSaleWindow: true`, `purchase.lua:
  // SOLD_OUT`), both of which agree the window is open; and (c) the sibling
  // row `S (exact)` (stock 5) two rows above, which uses the identical nowMs
  // and correctly derives `active`. Implemented per the unambiguous §3.2
  // algorithm, corroborated by 3 of the row's 4 cells: `sold_out`.
  it('S (exact), stock 0  ->  sold_out (window open at the inclusive lower bound, stock exhausted)', () => {
    expect(deriveSaleState({ nowMs: S, startsAtMs: S, endsAtMs: E, stockRemaining: 0 })).toBe(
      'sold_out',
    );
  });

  it('E - 1, stock 0  ->  sold_out', () => {
    expect(deriveSaleState({ nowMs: E - 1, startsAtMs: S, endsAtMs: E, stockRemaining: 0 })).toBe(
      'sold_out',
    );
  });

  it('E, stock 0  ->  ended (ended beats sold_out)', () => {
    expect(deriveSaleState({ nowMs: E, startsAtMs: S, endsAtMs: E, stockRemaining: 0 })).toBe(
      'ended',
    );
  });
});

describe('isWithinSaleWindow — same boundary table (§3.3)', () => {
  const S = 1_000_000;
  const E = 2_000_000;

  it('S - 1  ->  false', () => {
    expect(isWithinSaleWindow(S - 1, S, E)).toBe(false);
  });

  it('S (exact)  ->  true', () => {
    expect(isWithinSaleWindow(S, S, E)).toBe(true);
  });

  it('S + 1  ->  true', () => {
    expect(isWithinSaleWindow(S + 1, S, E)).toBe(true);
  });

  it('E - 1  ->  true', () => {
    expect(isWithinSaleWindow(E - 1, S, E)).toBe(true);
  });

  it('E (exact)  ->  false', () => {
    expect(isWithinSaleWindow(E, S, E)).toBe(false);
  });

  it('E + 1  ->  false', () => {
    expect(isWithinSaleWindow(E + 1, S, E)).toBe(false);
  });

  it('ignores stock entirely: window-open regardless of stockRemaining', () => {
    // isWithinSaleWindow has no stock parameter at all — this pins that the
    // window question and the stock question are answered independently.
    expect(isWithinSaleWindow(S, S, E)).toBe(true);
    expect(isWithinSaleWindow(E - 1, S, E)).toBe(true);
  });
});

describe('deriveSaleState — precedence beyond the boundary table', () => {
  it('upcoming beats sold_out: mid-window-in-the-future sale with 0 stock is still upcoming', () => {
    expect(
      deriveSaleState({ nowMs: 500, startsAtMs: 1_000, endsAtMs: 2_000, stockRemaining: 0 }),
    ).toBe('upcoming');
  });

  it('negative stockRemaining is treated as 0 (sold_out), not as "unlimited" or an error', () => {
    expect(
      deriveSaleState({ nowMs: 1_500, startsAtMs: 1_000, endsAtMs: 2_000, stockRemaining: -3 }),
    ).toBe('sold_out');
  });

  it('positive stock inside an open window is active', () => {
    expect(
      deriveSaleState({ nowMs: 1_500, startsAtMs: 1_000, endsAtMs: 2_000, stockRemaining: 1 }),
    ).toBe('active');
  });
});

describe('input validation — throws RangeError, never returns a default', () => {
  it.each([
    ['nowMs is NaN', { nowMs: Number.NaN, startsAtMs: 1_000, endsAtMs: 2_000, stockRemaining: 1 }],
    [
      'startsAtMs is Infinity',
      { nowMs: 1_500, startsAtMs: Number.POSITIVE_INFINITY, endsAtMs: 2_000, stockRemaining: 1 },
    ],
    [
      'endsAtMs is -Infinity',
      { nowMs: 1_500, startsAtMs: 1_000, endsAtMs: Number.NEGATIVE_INFINITY, stockRemaining: 1 },
    ],
    [
      'endsAtMs === startsAtMs (zero-length window)',
      { nowMs: 1_000, startsAtMs: 1_000, endsAtMs: 1_000, stockRemaining: 1 },
    ],
    [
      'endsAtMs < startsAtMs (inverted window)',
      { nowMs: 1_000, startsAtMs: 2_000, endsAtMs: 1_000, stockRemaining: 1 },
    ],
  ])('deriveSaleState throws RangeError when %s', (_label, input) => {
    expect(() => deriveSaleState(input)).toThrow(RangeError);
  });

  it('isWithinSaleWindow throws RangeError on a non-finite nowMs', () => {
    expect(() => isWithinSaleWindow(Number.NaN, 1_000, 2_000)).toThrow(RangeError);
  });

  it('isWithinSaleWindow throws RangeError when endsAtMs <= startsAtMs', () => {
    expect(() => isWithinSaleWindow(1_000, 2_000, 2_000)).toThrow(RangeError);
  });

  it('msUntilNextTransition throws RangeError on an invalid window (delegates to deriveSaleState)', () => {
    expect(() =>
      msUntilNextTransition({
        nowMs: 1_000,
        startsAtMs: 2_000,
        endsAtMs: 1_000,
        stockRemaining: 1,
      }),
    ).toThrow(RangeError);
  });
});

describe('msUntilNextTransition', () => {
  const S = 1_000_000;
  const E = 2_000_000;

  it('upcoming -> startsAtMs - nowMs', () => {
    expect(
      msUntilNextTransition({ nowMs: S - 400, startsAtMs: S, endsAtMs: E, stockRemaining: 5 }),
    ).toBe(400);
  });

  it('active -> endsAtMs - nowMs', () => {
    expect(
      msUntilNextTransition({ nowMs: S + 100, startsAtMs: S, endsAtMs: E, stockRemaining: 5 }),
    ).toBe(E - (S + 100));
  });

  it('sold_out -> endsAtMs - nowMs (same rule as active)', () => {
    expect(
      msUntilNextTransition({ nowMs: S + 100, startsAtMs: S, endsAtMs: E, stockRemaining: 0 }),
    ).toBe(E - (S + 100));
  });

  it('ended -> null', () => {
    expect(
      msUntilNextTransition({ nowMs: E, startsAtMs: S, endsAtMs: E, stockRemaining: 5 }),
    ).toBeNull();
  });

  it('ended (well past) -> null', () => {
    expect(
      msUntilNextTransition({ nowMs: E + 999_999, startsAtMs: S, endsAtMs: E, stockRemaining: 5 }),
    ).toBeNull();
  });
});
