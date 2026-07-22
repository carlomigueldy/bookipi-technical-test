import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../api/client';
import { apiClient } from '../api/client';
import type { ReadinessResponse, SaleMetricsResponse } from '../api/contracts';
import { opsFailureDelay, opsSuccessDelay } from '../lib/polling';

type Resource<T> = {
  value: T | null;
  stale: boolean;
  failures: number;
  updatedAt: number | null;
  dueAt: number;
};
const initial = <T>(): Resource<T> => ({
  value: null,
  stale: false,
  failures: 0,
  updatedAt: null,
  dueAt: 0,
});

export function useOpsSnapshot(client: ApiClient = apiClient, rng: () => number = Math.random) {
  const [metrics, setMetrics] = useState(() => initial<SaleMetricsResponse>());
  const [readiness, setReadiness] = useState(() => initial<ReadinessResponse>());
  const refs = useRef({
    metrics: initial<SaleMetricsResponse>(),
    readiness: initial<ReadinessResponse>(),
  });
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const generation = useRef(0);
  const running = useRef(false);
  const controller = useRef<AbortController>();

  const poll = useCallback(
    async (force = false) => {
      if (document.visibilityState === 'hidden' || running.current) return;
      running.current = true;
      const ownGeneration = generation.current;
      const abort = new AbortController();
      controller.current = abort;
      const ownsPoll = () =>
        ownGeneration === generation.current &&
        controller.current === abort &&
        !abort.signal.aborted;
      const now = Date.now();
      const needMetrics = force || refs.current.metrics.dueAt <= now;
      const needReadiness = force || refs.current.readiness.dueAt <= now;
      const jobs: Promise<void>[] = [];
      if (needMetrics)
        jobs.push(
          client
            .getSaleMetrics(abort.signal)
            .then((result) => {
              if (!ownsPoll()) return;
              const updatedAt = Date.now();
              const next = {
                value: result.data,
                stale: false,
                failures: 0,
                updatedAt,
                dueAt: updatedAt + opsSuccessDelay(rng),
              };
              refs.current.metrics = next;
              setMetrics(next);
            })
            .catch(() => {
              if (!ownsPoll()) return;
              const failures = refs.current.metrics.failures + 1;
              const failedAt = Date.now();
              const next = {
                ...refs.current.metrics,
                stale: true,
                failures,
                dueAt: failedAt + opsFailureDelay(failures, rng),
              };
              refs.current.metrics = next;
              setMetrics(next);
            }),
        );
      if (needReadiness)
        jobs.push(
          client
            .getReadiness(abort.signal)
            .then((result) => {
              if (!ownsPoll()) return;
              const updatedAt = Date.now();
              const next = {
                value: result.data,
                stale: false,
                failures: 0,
                updatedAt,
                dueAt: updatedAt + opsSuccessDelay(rng),
              };
              refs.current.readiness = next;
              setReadiness(next);
            })
            .catch(() => {
              if (!ownsPoll()) return;
              const failures = refs.current.readiness.failures + 1;
              const failedAt = Date.now();
              const next = {
                ...refs.current.readiness,
                stale: true,
                failures,
                dueAt: failedAt + opsFailureDelay(failures, rng),
              };
              refs.current.readiness = next;
              setReadiness(next);
            }),
        );
      await Promise.allSettled(jobs);
      if (!ownsPoll()) return;
      running.current = false;
      controller.current = undefined;
      const nextDue = Math.min(refs.current.metrics.dueAt, refs.current.readiness.dueAt);
      timer.current = setTimeout(() => void poll(), Math.max(0, nextDue - Date.now()));
    },
    [client, rng],
  );

  const refresh = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = undefined;
    void poll(true);
  }, [poll]);

  useEffect(() => {
    generation.current += 1;
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisibility);
    void poll(true);
    return () => {
      generation.current += 1;
      if (timer.current) clearTimeout(timer.current);
      timer.current = undefined;
      controller.current?.abort();
      controller.current = undefined;
      running.current = false;
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [poll, refresh]);

  return { metrics, readiness, refresh };
}
