import { describe, expect, it } from 'vitest';
import {
  calculateServerOffset,
  countdownSeconds,
  derivePresentationState,
  formatCountdown,
} from './time';

const sale = { startsAtMs: 1000, endsAtMs: 3000, stockRemaining: 1 };
describe('server time', () => {
  it('uses request midpoint', () => expect(calculateServerOffset(100, 300, 500)).toBe(300));
  it('honors half-open boundaries and time precedence', () => {
    expect(derivePresentationState(sale, 999)).toBe('upcoming');
    expect(derivePresentationState(sale, 1000)).toBe('active');
    expect(derivePresentationState({ ...sale, stockRemaining: 0 }, 1000)).toBe('sold_out');
    expect(derivePresentationState({ ...sale, stockRemaining: 0 }, 3000)).toBe('ended');
  });
  it('ceil pads, allows >23h, and clamps', () => {
    expect(countdownSeconds(1001, 0)).toBe(2);
    expect(formatCountdown(90061)).toEqual({ hours: '25', minutes: '01', seconds: '01' });
    expect(formatCountdown(-2)).toEqual({ hours: '00', minutes: '00', seconds: '00' });
  });
});
