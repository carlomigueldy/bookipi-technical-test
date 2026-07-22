import type { RefObject } from 'react';

export function PurchaseForm({
  value,
  setValue,
  onSubmit,
  inputRef,
  error,
  busy,
  buttonText,
  disabled,
  confirmed,
}: {
  value: string;
  setValue: (value: string) => void;
  onSubmit: (event: React.FormEvent) => void;
  inputRef: RefObject<HTMLInputElement>;
  error: string | null;
  busy: boolean;
  buttonText: string;
  disabled: boolean;
  confirmed: boolean;
}) {
  return (
    <form className="purchase-form" noValidate onSubmit={onSubmit} aria-busy={busy}>
      <div className="field-heading">
        <label htmlFor="user-id">Email or username</label>
        <span id="user-id-hint">3–64 chars · a–z 0–9 . _ @ -</span>
      </div>
      <div className="form-grid">
        <div>
          <input
            ref={inputRef}
            id="user-id"
            name="userId"
            type="text"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            autoComplete="username"
            spellCheck={false}
            minLength={3}
            maxLength={64}
            inputMode="email"
            placeholder="mia@example.com"
            aria-describedby={`user-id-hint${error ? ' user-id-error' : ''}`}
            aria-invalid={Boolean(error)}
            disabled={busy}
          />
          {error ? (
            <p id="user-id-error" className="field-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <button className={`buy-button${confirmed ? ' confirmed' : ''}`} disabled={disabled}>
          {busy ? <span className="spinner" aria-hidden="true" /> : null}
          {buttonText}
        </button>
      </div>
    </form>
  );
}
