import { countdownSeconds, formatCountdown, type PresentationState } from '../lib/time';

export function Countdown({
  state,
  startsAtMs,
  endsAtMs,
  serverNowMs,
}: {
  state: PresentationState | null;
  startsAtMs?: number;
  endsAtMs?: number;
  serverNowMs: number;
}) {
  const seconds =
    state === 'upcoming' && startsAtMs
      ? countdownSeconds(startsAtMs, serverNowMs)
      : state === 'active' && endsAtMs
        ? countdownSeconds(endsAtMs, serverNowMs)
        : 0;
  const parts = formatCountdown(seconds);
  const copy =
    state === 'upcoming'
      ? ['Opens in', 'Button unlocks automatically.']
      : state === 'active'
        ? ['Closes in', 'Live — good luck.']
        : state === 'sold_out'
          ? ['Allocation', 'All available cards are claimed.']
          : ['Window', state === 'ended' ? 'This drop is closed.' : 'Waiting for live status.'];
  return (
    <div
      className="countdown"
      role="timer"
      aria-label={`${copy[0]} ${parts.hours} hours ${parts.minutes} minutes ${parts.seconds} seconds`}
    >
      {(
        [
          ['hours', 'hrs'],
          ['minutes', 'min'],
          ['seconds', 'sec'],
        ] as const
      ).map(([key, label], index) => (
        <div className="countdown-part-wrap" key={key}>
          <div className={`countdown-part ${key}`}>
            <strong className="num">{parts[key]}</strong>
            <span className="eyebrow">{label}</span>
          </div>
          {index < 2 ? (
            <span className="colon" aria-hidden="true">
              :
            </span>
          ) : null}
        </div>
      ))}
      <div className="countdown-hint">
        <span className="eyebrow">{copy[0]}</span>
        <span>{copy[1]}</span>
      </div>
    </div>
  );
}
