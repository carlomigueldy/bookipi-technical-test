const steps = [
  [
    '01',
    'Window opens',
    'The console unlocks at the scheduled second — verified against server time, not your clock.',
  ],
  [
    '02',
    'One per customer',
    'The ledger accepts a single reservation per identifier. Retries return your original result.',
  ],
  [
    '03',
    'Reservation is final',
    'A confirmed reservation is yours. Your order persists to the permanent record within seconds.',
  ],
] as const;
export function ProtocolSteps() {
  return (
    <div className="protocol">
      {steps.map(([number, title, copy]) => (
        <article key={number}>
          <span className="num">{number}</span>
          <h3>{title}</h3>
          <p>{copy}</p>
        </article>
      ))}
    </div>
  );
}
