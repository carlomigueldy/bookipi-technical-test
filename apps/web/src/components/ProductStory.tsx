import { useEffect, useRef } from 'react';

const pad = (value: number) => String(value).padStart(3, '0');

export function ProductStory({ totalStock }: { totalStock: number | null }) {
  const card = useRef<HTMLDivElement>(null);
  const total = totalStock ?? 0;
  useEffect(() => {
    const node = card.current;
    const fine = matchMedia('(pointer: fine)').matches;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!node || !fine || reduced) return;
    const move = (event: PointerEvent) => {
      const box = node.getBoundingClientRect();
      const rx = ((event.clientY - box.top) / box.height - 0.5) * -8;
      const ry = ((event.clientX - box.left) / box.width - 0.5) * 10;
      node.style.transform = `perspective(900px) rotateX(${rx}deg) rotateY(${ry}deg)`;
    };
    const leave = () => {
      node.style.transform = 'perspective(900px) rotateX(0deg) rotateY(0deg)';
    };
    node.addEventListener('pointermove', move);
    node.addEventListener('pointerleave', leave);
    return () => {
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerleave', leave);
    };
  }, []);
  return (
    <section className="product-story entrance" aria-labelledby="product-title">
      <p className="eyebrow">Founders edition · {totalStock ?? '—'} units · No restock</p>
      <h1 id="product-title">
        The last card
        <br />
        we&apos;ll ever mint
        <br />
        this way.
      </h1>
      <p className="editorial">
        One card. One customer. <strong>{totalStock ?? '—'} ever.</strong>
      </p>
      <div className="metal-card" ref={card} aria-hidden="true">
        <div className="metal-content">
          <div className="metal-top">
            <svg viewBox="0 0 24 24">
              <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" />
            </svg>
            <span>FOUNDERS · 001–{pad(total)}</span>
          </div>
          <div>
            <div className="chip" />
            <div className="card-number">
              5299&nbsp; 01••&nbsp; ••••&nbsp; {pad(total).padStart(4, '0')}
            </div>
            <div className="metal-bottom">
              <b>M. FOUNDER</b>
              <span>18G · BRUSHED TITANIUM</span>
            </div>
          </div>
        </div>
      </div>
      <dl className="product-details">
        <div>
          <dt>Price</dt>
          <dd className="num">
            $249 <small>AUD</small>
          </dd>
        </div>
        <div>
          <dt>Material</dt>
          <dd>Titanium</dd>
        </div>
        <div>
          <dt>Numbered</dt>
          <dd>001–{pad(total)}</dd>
        </div>
      </dl>
    </section>
  );
}
