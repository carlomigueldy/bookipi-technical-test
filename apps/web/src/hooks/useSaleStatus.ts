import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../api/client';
import { apiClient } from '../api/client';
import type { SaleStatusResponse } from '../api/contracts';
import { saleFailureDelay, saleSuccessDelay } from '../lib/polling';
import { calculateServerOffset, derivePresentationState } from '../lib/time';

export type SalePollState = {
  sale: SaleStatusResponse | null;
  offsetMs: number;
  unavailable: boolean;
  failureCount: number;
  lastResponseAtMs: number | null;
};

export function useSaleStatus(client: ApiClient = apiClient, rng: () => number = Math.random) {
  const [state, setState] = useState<SalePollState>({
    sale: null,
    offsetMs: 0,
    unavailable: false,
    failureCount: 0,
    lastResponseAtMs: null,
  });
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const inFlight = useRef(false);
  const queued = useRef(false);
  const controller = useRef<AbortController>();

  const poll = useCallback(async () => {
    if (document.visibilityState === 'hidden') {
      queued.current = true;
      return;
    }
    if (inFlight.current) {
      queued.current = true;
      return;
    }
    inFlight.current = true;
    queued.current = false;
    const ownGeneration = generation.current;
    const abort = new AbortController();
    controller.current = abort;
    let delay = 2000;
    try {
      const result = await client.getSaleStatus(abort.signal);
      if (ownGeneration !== generation.current) return;
      const offsetMs = calculateServerOffset(
        result.sentAtMs,
        result.receivedAtMs,
        result.data.serverTimeMs,
      );
      const now = Date.now() + offsetMs;
      const presentation = derivePresentationState(result.data, now);
      delay = saleSuccessDelay(presentation === 'upcoming' ? result.data.startsAtMs - now : 0, rng);
      setState({
        sale: result.data,
        offsetMs,
        unavailable: false,
        failureCount: 0,
        lastResponseAtMs: Date.now(),
      });
    } catch {
      if (ownGeneration !== generation.current || abort.signal.aborted) return;
      setState((previous) => {
        const failureCount = previous.failureCount + 1;
        delay = saleFailureDelay(failureCount, rng);
        return { ...previous, unavailable: true, failureCount };
      });
    } finally {
      const ownsFlight = controller.current === abort;
      if (ownsFlight) {
        inFlight.current = false;
        controller.current = undefined;
      }
      if (ownsFlight && ownGeneration === generation.current) {
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => void poll(), queued.current ? 0 : delay);
      }
    }
  }, [client, rng]);

  const refresh = useCallback(() => {
    queued.current = true;
    if (timer.current) clearTimeout(timer.current);
    void poll();
  }, [poll]);

  const applySnapshot = useCallback(
    (
      saleId: string,
      stockRemaining: number,
      serverTimeMs: number,
      sentAtMs: number,
      receivedAtMs: number,
    ) => {
      setState((previous) =>
        previous.sale?.saleId === saleId
          ? {
              ...previous,
              sale: { ...previous.sale, stockRemaining },
              offsetMs: calculateServerOffset(sentAtMs, receivedAtMs, serverTimeMs),
              lastResponseAtMs: Date.now(),
            }
          : previous,
      );
    },
    [],
  );

  useEffect(() => {
    generation.current += 1;
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisibility);
    void poll();
    return () => {
      generation.current += 1;
      if (timer.current) clearTimeout(timer.current);
      timer.current = undefined;
      controller.current?.abort();
      controller.current = undefined;
      inFlight.current = false;
      queued.current = false;
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [poll, refresh]);

  return { ...state, refresh, applySnapshot };
}
