import type { SaleStatusResponse } from '../api/contracts';

export type PresentationState = 'upcoming' | 'active' | 'sold_out' | 'ended';

export function calculateServerOffset(
  sentAtMs: number,
  receivedAtMs: number,
  serverTimeMs: number,
): number {
  return serverTimeMs - (sentAtMs + (receivedAtMs - sentAtMs) / 2);
}

export function derivePresentationState(
  sale: Pick<SaleStatusResponse, 'startsAtMs' | 'endsAtMs' | 'stockRemaining'>,
  serverNowMs: number,
): PresentationState {
  if (serverNowMs < sale.startsAtMs) return 'upcoming';
  if (serverNowMs >= sale.endsAtMs) return 'ended';
  if (sale.stockRemaining <= 0) return 'sold_out';
  return 'active';
}

export function countdownSeconds(targetMs: number, serverNowMs: number): number {
  return Math.max(0, Math.ceil((targetMs - serverNowMs) / 1000));
}

export function formatCountdown(seconds: number): {
  hours: string;
  minutes: string;
  seconds: string;
} {
  const safe = Math.max(0, Math.floor(seconds));
  return {
    hours: String(Math.floor(safe / 3600)).padStart(2, '0'),
    minutes: String(Math.floor((safe % 3600) / 60)).padStart(2, '0'),
    seconds: String(safe % 60).padStart(2, '0'),
  };
}
