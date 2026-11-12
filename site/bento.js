/* Bento layer: a cursor spotlight on every card, and short product loops that run only while their
   section is on screen (never a scroll reveal: everything is visible at rest). Reduced motion: spotlight
   and loops are off, the page shows its resting state. */
(() => {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fine = matchMedia('(hover: hover) and (pointer: fine)').matches;

  /* 1. Cells */
  const cells = document.querySelectorAll('#renewal .card, #lend .card, #lend .section-head, .faq > .faq__item, #dip .chart, #dip .lane, #vault .frame, .hero .d-win');
  cells.forEach((el) => el.classList.add('bx'));
  if (reduce) return;
  if (fine) cells.forEach((el) => el.addEventListener('pointermove', (e) => {
    const r = el.getBoundingClientRect();
    el.style.setProperty('--mx', `${e.clientX - r.left}px`);
    el.style.setProperty('--my', `${e.clientY - r.top}px`);
  }, { passive: true }));

  /* 2. Loops run while their section is on screen */
  const loops = new Map();
  const io = new IntersectionObserver((entries) => entries.forEach((en) => {
    en.target.classList.toggle('is-live', en.isIntersecting);
    const l = loops.get(en.target); if (l) en.isIntersecting ? l.start() : l.stop();
  }), { threshold: 0.25 });
  const every = (ms, fn) => { let t = 0; return { start() { if (!t) { fn(); t = setInterval(fn, ms); } }, stop() { clearInterval(t); t = 0; } }; };

  /* Renewal: the notice counts down, the auction price falls, in step with their bars (4 s loops) */
  const renewal = document.getElementById('renewal');
  if (renewal) {
    const [, notice, auction] = renewal.querySelectorAll('.card');
    const chip = notice?.querySelector('.chip'), price = auction?.querySelector('.steps-ui b');
    let i = 0;
    const base = { chip: chip?.textContent, price: price?.textContent };
    const tick = every(800, () => {
      const k = i++ % 5;
      if (chip) chip.textContent = `${72 - k} h left`;
      if (price) price.textContent = `${100 - k}% of price`;
    });
    loops.set(renewal, { start: () => { i = 0; tick.start(); }, stop: () => { tick.stop(); if (chip) chip.textContent = base.chip; if (price) price.textContent = base.price; } });
    io.observe(renewal);
  }
  const lend = document.getElementById('lend'); if (lend) io.observe(lend);

  /* Dip: a price dot runs along the path; it turns red on the day below the line (6 s loop) */
  const dip = document.getElementById('dip');
  const path = dip?.querySelector('.chart .px');
  if (dip && path) {
    const svg = path.ownerSVGElement, len = path.getTotalLength();
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('r', '6'); dot.setAttribute('class', 'bx-dot'); dot.setAttribute('aria-hidden', 'true');
    svg.appendChild(dot);
    let raf = 0, t0 = 0;
    const PERIOD = 6000;
    const frame = (t) => {
      if (!t0) t0 = t;
      const k = ((t - t0) % PERIOD) / PERIOD, p = path.getPointAtLength(len * k);
      dot.setAttribute('cx', p.x.toFixed(1)); dot.setAttribute('cy', p.y.toFixed(1));
      dot.classList.toggle('is-low', p.y > 210);
      raf = requestAnimationFrame(frame);
    };
    const end = path.getPointAtLength(len); dot.setAttribute('cx', end.x); dot.setAttribute('cy', end.y);
    loops.set(dip, { start() { if (!raf) { t0 = 0; raf = requestAnimationFrame(frame); } }, stop() { cancelAnimationFrame(raf); raf = 0; } });
    document.addEventListener('visibilitychange', () => { if (document.hidden) loops.get(dip).stop(); else if (dip.classList.contains('is-live')) loops.get(dip).start(); });
    io.observe(dip);
  }
})();
