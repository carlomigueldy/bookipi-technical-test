import { useEffect, useState } from 'react';
import { HEALTH_PATH, SERVICE_NAMES, type HealthResponse } from '@flash/shared';
import { API_BASE_URL } from './env';

type HealthState =
  | { phase: 'loading' }
  | { phase: 'ok'; data: HealthResponse }
  | { phase: 'error'; message: string };

const healthUrl = `${API_BASE_URL}/${HEALTH_PATH}`;

function useApiHealth(): HealthState {
  const [state, setState] = useState<HealthState>({ phase: 'loading' });

  useEffect(() => {
    let cancelled = false;

    async function loadHealth() {
      try {
        const response = await fetch(healthUrl);
        if (!response.ok) {
          throw new Error(`API responded with ${response.status}`);
        }
        const data = (await response.json()) as HealthResponse;
        if (!cancelled) {
          setState({ phase: 'ok', data });
        }
      } catch (error) {
        if (!cancelled) {
          setState({
            phase: 'error',
            message: error instanceof Error ? error.message : 'API unreachable',
          });
        }
      }
    }

    void loadHealth();

    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}

export default function App() {
  const health = useApiHealth();

  return (
    <main className="app-shell">
      <section className="card" aria-labelledby="scaffold-title">
        <p className="eyebrow">@flash/web · phase 0 scaffold</p>
        <h1 id="scaffold-title">Token layer online</h1>
        <p className="lede">
          The design tokens extracted from the approved prototype resolve end to end, and the API
          client is wired to <code>VITE_API_BASE_URL</code>. Phase 4 replaces this shell with the
          buyer card, countdown, and ops panel.
        </p>

        <dl className="service-list" aria-label="Registered services">
          {SERVICE_NAMES.map((name) => (
            <div className="service-row" key={name}>
              <dt>{name}</dt>
              <dd>{name === 'web' ? 'this app' : 'scaffolded'}</dd>
            </div>
          ))}
        </dl>

        <div className="health" role="status" aria-live="polite">
          <p className="eyebrow">API health</p>
          {health.phase === 'loading' && <p className="health-line">Checking {healthUrl}…</p>}
          {health.phase === 'ok' && (
            <pre className="health-json num">{JSON.stringify(health.data, null, 2)}</pre>
          )}
          {health.phase === 'error' && (
            <p className="health-line health-error">API unreachable — {health.message}</p>
          )}
        </div>
      </section>
    </main>
  );
}
