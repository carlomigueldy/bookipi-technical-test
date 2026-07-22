import type { ReadinessResponse, SaleMetricsResponse } from '../api/contracts';

const value = (number: number | undefined) =>
  number === undefined ? '—' : number.toLocaleString();

export function OpsLedger({
  metrics,
  metricsStale,
  readiness,
  readinessStale,
  cadence,
  updatedAt,
  serverNowMs,
}: {
  metrics: SaleMetricsResponse | null;
  metricsStale: boolean;
  readiness: ReadinessResponse | null;
  readinessStale: boolean;
  cadence: string;
  updatedAt: number | null;
  serverNowMs: number;
}) {
  const badge = readiness
    ? readiness.status === 'ok'
      ? 'API ready'
      : 'API degraded'
    : readinessStale
      ? 'API unreachable'
      : 'Checking API';
  const checks = readiness?.checks;
  const summary = checks
    ? `Redis ${checks.redis.ok ? 'ready' : 'unavailable'} · Postgres ${checks.postgres.ok ? 'ready' : 'unavailable'} · Queue ${checks.queue.waiting} waiting / ${checks.queue.active} active / ${checks.queue.failed} failed`
    : 'Redis unavailable · Postgres unavailable · Queue unavailable';
  const age = updatedAt === null ? null : Math.max(0, Math.floor((serverNowMs - updatedAt) / 1000));
  return (
    <section className="ledger entrance" aria-labelledby="ops-title">
      <div className="ledger-heading">
        <h2 id="ops-title" className="oplabel">
          Ops ledger
        </h2>
        <span className={`ops-badge ${readiness?.status ?? 'unknown'}`}>
          <i aria-hidden="true" />
          {badge}
        </span>
        {metricsStale || readinessStale ? <span className="stale">stale</span> : null}
      </div>
      <div className="ops-grid">
        <div>
          <span>Confirmed</span>
          <strong>{value(metrics?.metrics.confirmed)}</strong>
        </div>
        <div>
          <span>Duplicate 409</span>
          <strong>{value(metrics?.metrics.already_purchased)}</strong>
        </div>
        <div>
          <span>Sold out 410</span>
          <strong>{value(metrics?.metrics.sold_out)}</strong>
        </div>
        <div>
          <span>Status poll</span>
          <strong>{cadence}</strong>
        </div>
      </div>
      <p className="protocol-line">
        REDIS LUA · ATOMIC DECIDE → BULLMQ → POSTGRES PERSIST · INVARIANTS I1–I4 ENFORCED
      </p>
      <p className="readiness-summary">
        {summary}
        {age === null ? '' : ` · Updated ${age}s ago`}
      </p>
    </section>
  );
}
