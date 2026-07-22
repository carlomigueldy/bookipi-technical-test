import type { RefObject } from 'react';
import type { PresentationState } from '../lib/time';
import { Countdown } from './Countdown';
import { PurchaseForm } from './PurchaseForm';
import { PurchaseStatusCheck } from './PurchaseStatusCheck';
import { StockMeter } from './StockMeter';

export type Feedback = {
  tone: 'success' | 'warning' | 'error' | 'info';
  heading: string;
  body: string;
};

export function AcquisitionConsole(props: {
  state: PresentationState | null;
  serverNowMs: number;
  startsAt?: string;
  endsAt?: string;
  startsAtMs?: number;
  endsAtMs?: number;
  remaining: number | null;
  total: number | null;
  value: string;
  setValue: (value: string) => void;
  onSubmit: (event: React.FormEvent) => void;
  inputRef: RefObject<HTMLInputElement>;
  error: string | null;
  busy: boolean;
  buttonText: string;
  buttonDisabled: boolean;
  confirmed: boolean;
  feedback: Feedback | null;
  onCheck: () => void;
  checkBusy: boolean;
  checkDisabled: boolean;
  checkResult: string | null;
}) {
  const window =
    props.startsAt && props.endsAt ? (
      <span className="window">
        <time dateTime={props.startsAt}>{new Date(props.startsAt).toLocaleString()}</time> –{' '}
        <time dateTime={props.endsAt}>{new Date(props.endsAt).toLocaleString()}</time> local
      </span>
    ) : (
      <span className="window">—</span>
    );
  return (
    <section className="console-wrap entrance" aria-labelledby="console-title">
      <div className="console">
        <div className="console-heading">
          <h2 id="console-title" className="eyebrow">
            Acquisition console
          </h2>
          {window}
        </div>
        <Countdown
          state={props.state}
          startsAtMs={props.startsAtMs}
          endsAtMs={props.endsAtMs}
          serverNowMs={props.serverNowMs}
        />
        <StockMeter remaining={props.remaining} total={props.total} />
        <PurchaseForm
          value={props.value}
          setValue={props.setValue}
          onSubmit={props.onSubmit}
          inputRef={props.inputRef}
          error={props.error}
          busy={props.busy}
          buttonText={props.buttonText}
          disabled={props.buttonDisabled}
          confirmed={props.confirmed}
        />
        <div
          className={`feedback ${props.feedback ? props.feedback.tone : 'empty'}`}
          role="status"
          aria-live="polite"
        >
          {props.feedback ? (
            <>
              <strong>{props.feedback.heading}</strong>
              <span>{props.feedback.body}</span>
            </>
          ) : null}
        </div>
        <PurchaseStatusCheck
          onCheck={props.onCheck}
          busy={props.checkBusy}
          disabled={props.checkDisabled}
          result={props.checkResult}
        />
      </div>
    </section>
  );
}
