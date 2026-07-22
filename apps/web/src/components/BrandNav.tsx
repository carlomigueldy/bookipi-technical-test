import type { PresentationState } from '../lib/time';

const labels: Record<PresentationState, string> = {
  upcoming: 'Upcoming',
  active: 'Live now',
  sold_out: 'Sold out',
  ended: 'Ended',
};

export function BrandNav({
  state,
  serverNowMs,
}: {
  state: PresentationState | null;
  serverNowMs: number;
}) {
  return (
    <nav className="nav" aria-label="Aurora">
      <div className="brand">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" />
        </svg>
        <strong>aurora</strong>
        <span>/ founders drop</span>
      </div>
      <div className="nav-status">
        <span className="server-clock" title="Server-aligned time">
          SERVER {new Date(serverNowMs).toLocaleTimeString([], { hour12: false })}
        </span>
        <span className={`pill ${state ?? 'loading'}`}>
          <i aria-hidden="true" />
          {state ? labels[state] : 'Loading'}
        </span>
      </div>
    </nav>
  );
}
