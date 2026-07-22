import { useEffect, useMemo, useRef, useState } from 'react';
import type { AttemptOutcome } from '@flash/shared';
import { ApiClientError, apiClient, type ApiClient } from './api/client';
import type { PurchaseStatusResponse } from './api/contracts';
import { AcquisitionConsole, type Feedback } from './components/AcquisitionConsole';
import { BrandNav } from './components/BrandNav';
import { OpsLedger } from './components/OpsLedger';
import { ProductStory } from './components/ProductStory';
import { ProtocolSteps } from './components/ProtocolSteps';
import { useOpsSnapshot } from './hooks/useOpsSnapshot';
import { useSaleStatus } from './hooks/useSaleStatus';
import { derivePresentationState } from './lib/time';
import { USER_ID_ERROR, normalizeUserId, validateUserId } from './lib/user-id';

type Interaction =
  | 'idle'
  | 'submitting'
  | 'confirmed'
  | 'duplicate'
  | 'sold_out'
  | 'not_started'
  | 'ended'
  | 'rate_limited'
  | 'invalid'
  | 'unavailable'
  | 'unknown';

type CorrelatedStatusResult = { userId: string; copy: string };

function outcomeFeedback(
  outcome: AttemptOutcome,
  userId: string,
  retry: number,
): { interaction: Interaction; feedback: Feedback } {
  const map: Record<AttemptOutcome, { interaction: Interaction; feedback: Feedback }> = {
    CONFIRMED: {
      interaction: 'confirmed',
      feedback: {
        tone: 'success',
        heading: 'Card secured',
        body: `Reserved for ${userId}. Persistence may take a few seconds.`,
      },
    },
    ALREADY_PURCHASED: {
      interaction: 'duplicate',
      feedback: {
        tone: 'warning',
        heading: 'You already hold a reservation',
        body: 'One per customer — check the original reservation below.',
      },
    },
    SOLD_OUT: {
      interaction: 'sold_out',
      feedback: {
        tone: 'error',
        heading: 'Sold out',
        body: 'Supply reached zero before this attempt landed.',
      },
    },
    SALE_NOT_STARTED: {
      interaction: 'not_started',
      feedback: {
        tone: 'info',
        heading: 'Not open yet',
        body: 'The server has not opened this sale.',
      },
    },
    SALE_ENDED: {
      interaction: 'ended',
      feedback: {
        tone: 'error',
        heading: 'This drop is closed',
        body: 'The sale window has ended.',
      },
    },
    NOT_INITIALIZED: {
      interaction: 'unavailable',
      feedback: {
        tone: 'warning',
        heading: 'Sale temporarily unavailable',
        body: 'The sale is not ready. Try refreshing live status.',
      },
    },
    INVALID_USER_ID: {
      interaction: 'invalid',
      feedback: { tone: 'error', heading: 'Check your identifier', body: USER_ID_ERROR },
    },
    RATE_LIMITED: {
      interaction: 'rate_limited',
      feedback: { tone: 'warning', heading: 'Too many attempts', body: `Try again in ${retry}s.` },
    },
    UPSTREAM_UNAVAILABLE: {
      interaction: 'unavailable',
      feedback: {
        tone: 'warning',
        heading: 'Service temporarily unavailable',
        body: 'No purchase result was confirmed. Check status before trying again.',
      },
    },
  };
  return map[outcome];
}

function statusCopy(result: PurchaseStatusResponse, active: boolean): string {
  if (result.purchased && result.order?.status === 'reserved')
    return 'Reservation found — reserved and waiting for durable persistence.';
  if (result.purchased && result.order?.status === 'persisted')
    return `Reservation found — persisted to the permanent record.${result.order.createdAt ? ` Created ${new Date(result.order.createdAt).toLocaleString()}.` : ''}`;
  if (!result.purchased && result.order?.status === 'compensated')
    return `Reservation released — persistence failed safely and the stock was returned.${active ? ' You may try again.' : ''}`;
  return `No reservation found for ${result.userId}.${active ? ' Supply may still be available.' : ''}`;
}

export default function App({ client = apiClient }: { client?: ApiClient }) {
  const salePoll = useSaleStatus(client);
  const ops = useOpsSnapshot(client);
  const [tick, setTick] = useState(Date.now());
  const [userId, setUserId] = useState('');
  const [attemptedId, setAttemptedId] = useState<string | null>(null);
  const [interaction, setInteraction] = useState<Interaction>('idle');
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checkBusy, setCheckBusy] = useState(false);
  const [checkResult, setCheckResult] = useState<CorrelatedStatusResult | null>(null);
  const [rateUntil, setRateUntil] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const purchaseController = useRef<AbortController | null>(null);
  const statusGeneration = useRef(0);
  const statusController = useRef<AbortController | null>(null);
  const currentNormalizedUserId = useRef('');
  const serverNowMs = tick + salePoll.offsetMs;
  const state = salePoll.sale ? derivePresentationState(salePoll.sale, serverNowMs) : null;
  const rateSeconds = Math.max(0, Math.ceil((rateUntil - tick) / 1000));

  useEffect(() => {
    const timer = setInterval(() => setTick(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);
  useEffect(
    () => () => {
      statusGeneration.current += 1;
      purchaseController.current?.abort();
      purchaseController.current = null;
      statusController.current?.abort();
      statusController.current = null;
    },
    [],
  );
  useEffect(() => {
    if (interaction === 'rate_limited' && rateSeconds === 0) setInteraction('idle');
  }, [interaction, rateSeconds]);

  const changeUserId = (value: string) => {
    const normalized = normalizeUserId(value);
    if (normalized !== currentNormalizedUserId.current) {
      currentNormalizedUserId.current = normalized;
      statusGeneration.current += 1;
      statusController.current?.abort();
      statusController.current = null;
      setCheckResult(null);
      setCheckBusy(false);
    }
    setUserId(value);
    setError(null);
    if (attemptedId !== null && normalizeUserId(value) !== attemptedId) {
      setInteraction('idle');
      setFeedback(null);
      setCheckResult(null);
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (interaction === 'submitting') return;
    const valid = validateUserId(userId);
    if (!valid.ok) {
      setError(valid.message);
      setInteraction('invalid');
      inputRef.current?.focus();
      return;
    }
    setError(null);
    setAttemptedId(valid.value);
    setInteraction('submitting');
    setFeedback(null);
    const controller = new AbortController();
    purchaseController.current = controller;
    try {
      const response = await client.purchase(valid.value, controller.signal);
      const retry = response.retryAfterSeconds ?? 0;
      const next = outcomeFeedback(response.data.status, valid.value, retry);
      setInteraction(next.interaction);
      setFeedback(next.feedback);
      if (response.data.status === 'INVALID_USER_ID') {
        setError(USER_ID_ERROR);
        inputRef.current?.focus();
      }
      if (response.data.status === 'RATE_LIMITED') setRateUntil(Date.now() + retry * 1000);
      if (response.data.stockRemaining !== null)
        salePoll.applySnapshot(
          response.data.saleId,
          response.data.stockRemaining,
          response.data.serverTimeMs,
          response.sentAtMs,
          response.receivedAtMs,
        );
      if (
        response.data.status !== 'ALREADY_PURCHASED' &&
        response.data.status !== 'INVALID_USER_ID' &&
        response.data.status !== 'RATE_LIMITED'
      )
        salePoll.refresh();
      ops.refresh();
    } catch (caught) {
      if (controller.signal.aborted) return;
      setInteraction('unknown');
      const ambiguous =
        caught instanceof ApiClientError &&
        (caught.kind === 'network' || caught.kind === 'timeout');
      setFeedback({
        tone: 'warning',
        heading: ambiguous ? 'Result unknown' : 'We could not verify the result',
        body: 'The request may have reached the sale. Check your reservation before trying again.',
      });
    } finally {
      if (purchaseController.current === controller) purchaseController.current = null;
    }
  };

  const check = async () => {
    const valid = validateUserId(userId);
    if (!valid.ok) {
      setError(valid.message);
      inputRef.current?.focus();
      return;
    }
    statusGeneration.current += 1;
    const ownGeneration = statusGeneration.current;
    statusController.current?.abort();
    const controller = new AbortController();
    statusController.current = controller;
    const requestedUserId = valid.value;
    currentNormalizedUserId.current = requestedUserId;
    const ownsLookup = () =>
      ownGeneration === statusGeneration.current &&
      statusController.current === controller &&
      !controller.signal.aborted &&
      currentNormalizedUserId.current === requestedUserId;
    setCheckBusy(true);
    setCheckResult(null);
    try {
      const response = await client.getPurchaseStatus(requestedUserId, controller.signal);
      if (!ownsLookup()) return;
      const matches = normalizeUserId(response.data.userId) === requestedUserId;
      setCheckResult({
        userId: requestedUserId,
        copy: matches
          ? statusCopy(response.data, state === 'active')
          : 'Reservation status is temporarily unavailable. Try again.',
      });
    } catch {
      if (!ownsLookup()) return;
      setCheckResult({
        userId: requestedUserId,
        copy: 'Reservation status is temporarily unavailable. Try again.',
      });
    } finally {
      if (ownsLookup()) {
        statusController.current = null;
        setCheckBusy(false);
      }
    }
  };

  const button = useMemo(() => {
    if (!salePoll.sale) return ['Loading sale…', true] as const;
    if (interaction === 'submitting') return ['Securing…', true] as const;
    if (interaction === 'confirmed' && attemptedId === normalizeUserId(userId))
      return ['✓ Card secured', true] as const;
    if (rateSeconds > 0) return [`Try again in ${rateSeconds}s`, true] as const;
    if (state === 'upcoming') return ['Opens soon', true] as const;
    if (state === 'sold_out') return ['Sold out', true] as const;
    if (state === 'ended') return ['Sale ended', true] as const;
    return ['Secure your card', false] as const;
  }, [attemptedId, interaction, rateSeconds, salePoll.sale, state, userId]);

  const cadence =
    salePoll.failureCount > 0
      ? 'backing off ≤10s'
      : state === 'upcoming' && salePoll.sale && salePoll.sale.startsAtMs - serverNowMs <= 10_000
        ? '1s'
        : '2s ±30%';
  const updatedAt = Math.max(ops.metrics.updatedAt ?? 0, ops.readiness.updatedAt ?? 0) || null;
  return (
    <>
      <div className="page">
        <BrandNav state={state} serverNowMs={serverNowMs} />
        {salePoll.unavailable ? (
          <div className="api-banner" role="alert">
            <span>
              Live status is temporarily unreachable. Showing the last confirmed snapshot.
            </span>
            <button
              onClick={() => {
                salePoll.refresh();
                ops.refresh();
              }}
            >
              Retry
            </button>
          </div>
        ) : null}
        <main>
          <ProductStory totalStock={salePoll.sale?.totalStock ?? null} />
          <div>
            <AcquisitionConsole
              state={state}
              serverNowMs={serverNowMs}
              startsAt={salePoll.sale?.startsAt}
              endsAt={salePoll.sale?.endsAt}
              startsAtMs={salePoll.sale?.startsAtMs}
              endsAtMs={salePoll.sale?.endsAtMs}
              remaining={salePoll.sale?.stockRemaining ?? null}
              total={salePoll.sale?.totalStock ?? null}
              value={userId}
              setValue={changeUserId}
              onSubmit={submit}
              inputRef={inputRef}
              error={error}
              busy={interaction === 'submitting'}
              buttonText={button[0]}
              buttonDisabled={button[1]}
              confirmed={interaction === 'confirmed'}
              feedback={feedback}
              onCheck={() => void check()}
              checkBusy={checkBusy}
              checkDisabled={checkBusy || interaction === 'submitting'}
              checkResult={
                checkResult?.userId === normalizeUserId(userId) ? checkResult.copy : null
              }
            />
            <ProtocolSteps />
          </div>
        </main>
        <OpsLedger
          metrics={ops.metrics.value}
          metricsStale={ops.metrics.stale}
          readiness={ops.readiness.value}
          readinessStale={ops.readiness.stale}
          cadence={cadence}
          updatedAt={updatedAt}
          serverNowMs={tick}
        />
        <footer>
          <span>bookipi-technical-test · reference prototype · not a real offer</span>
          <span>React · Vite · accessible by design</span>
        </footer>
      </div>
    </>
  );
}
