export function jitter(baseMs: number, rng: () => number, capMs: number): number {
  return Math.min(capMs, Math.round(baseMs * (0.7 + rng() * 0.6)));
}

export function saleSuccessDelay(untilStartMs: number, rng: () => number): number {
  return untilStartMs > 0 && untilStartMs <= 10_000 ? 1000 : jitter(2000, rng, 10_000);
}

export function saleFailureDelay(failure: number, rng: () => number): number {
  const base = Math.min(10_000, 2000 * 2 ** Math.max(0, failure - 1));
  return jitter(base, rng, 10_000);
}

export function opsSuccessDelay(rng: () => number): number {
  return jitter(5000, rng, 6500);
}

export function opsFailureDelay(failure: number, rng: () => number): number {
  const base = Math.min(15_000, 5000 * Math.max(1, failure));
  return jitter(base, rng, 15_000);
}
