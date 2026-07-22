export function PurchaseStatusCheck({
  onCheck,
  busy,
  disabled,
  result,
}: {
  onCheck: () => void;
  busy: boolean;
  disabled: boolean;
  result: string | null;
}) {
  return (
    <div className="status-check" aria-busy={busy}>
      <div className="status-check-row">
        <span>Already attempted? Verify your reservation.</span>
        <button type="button" onClick={onCheck} disabled={disabled}>
          {busy ? 'Checking…' : 'Check my status'}
        </button>
      </div>
      {result ? (
        <div className="check-result" role="status" aria-live="polite">
          {result}
        </div>
      ) : null}
    </div>
  );
}
