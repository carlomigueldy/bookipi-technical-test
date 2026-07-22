export function StockMeter({
  remaining,
  total,
}: {
  remaining: number | null;
  total: number | null;
}) {
  const count = total === null ? 0 : Math.min(50, total);
  const active = total && total > 0 ? Math.ceil((Math.max(0, remaining ?? 0) / total) * count) : 0;
  const low = total !== null && remaining !== null && remaining > 0 && remaining <= total * 0.2;
  const label =
    total !== null && total <= 50
      ? 'Supply — each tick is one card'
      : 'Supply — 50-segment allocation gauge';
  return (
    <div className="stock">
      <div className="stock-heading">
        <span className="eyebrow">{total === null ? 'Supply' : label}</span>
        <strong className="num">
          {remaining ?? '—'} / {total ?? '—'} remaining
        </strong>
      </div>
      <div className="ticks" aria-hidden="true">
        {Array.from({ length: count }, (_, index) => (
          <i
            key={index}
            className={
              index < active ? (low ? 'low' : 'available') : remaining === 0 ? 'none' : 'gone'
            }
          />
        ))}
      </div>
      <span className="sr-only" aria-live="polite">
        {remaining === null ? 'Supply unavailable' : `${remaining} of ${total} remaining`}
      </span>
    </div>
  );
}
