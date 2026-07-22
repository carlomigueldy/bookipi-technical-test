import { describe, expect, it } from 'vitest';
import { jitter, opsFailureDelay, saleFailureDelay, saleSuccessDelay } from './polling';

describe('polling delays', () => {
  it('hits exact jitter endpoints', () => {
    expect(jitter(2000, () => 0, 10000)).toBe(1400);
    expect(jitter(2000, () => 0.999999, 10000)).toBe(2600);
  });
  it('tightens in the final ten seconds', () =>
    expect(saleSuccessDelay(10_000, () => 0)).toBe(1000));
  it('backs off and caps after jitter', () => {
    expect(saleFailureDelay(1, () => 0.5)).toBe(2000);
    expect(saleFailureDelay(2, () => 0.5)).toBe(4000);
    expect(saleFailureDelay(10, () => 0.999)).toBe(10000);
    expect(opsFailureDelay(3, () => 0.999)).toBe(15000);
  });
});
