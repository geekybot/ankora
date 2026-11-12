/* Bento layer: a cursor spotlight on every card, and short product loops that run only while their
   section is on screen (never a scroll reveal: everything is visible at rest). Reduced motion: spotlight
   and loops are off, the page shows its resting state. */
(() => {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fine = matchMedia('(hover: hover) and (pointer: fine)').matches;

  /* 0. Questions: an accordion. Without this script every answer stays visible. The first starts open. */
  const faq = document.querySelector('#questions .faq');
  if (faq) {
    const items = [...faq.querySelectorAll('.faq__item')];
    const setOpen = (it, open) => { it.classList.toggle('is-open', open); it.querySelector('.faq__q').setAttribute('aria-expanded', String(open)); };
    items.forEach((it, i) => { setOpen(it, i === 0); it.querySelector('.faq__q').addEventListener('click', () => setOpen(it, !it.classList.contains('is-open'))); });
    faq.classList.add('is-js');
    requestAnimationFrame(() => requestAnimationFrame(() => faq.classList.add('is-ready')));
  }

  /* 1. Cells */
  const cells = document.querySelectorAll('#renewal .card, #lend .card, #lend .section-head, #dip .chart, #dip .lane, #vault .frame, .hero .d-win');
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

  /* One rAF clock per section, running only while it is on screen and the tab is visible */
  const clock = (fn) => {
    let raf = 0, t0 = 0;
    const frame = (t) => { if (!t0) t0 = t; fn(t - t0); raf = requestAnimationFrame(frame); };
    return { start() { if (!raf) { t0 = 0; raf = requestAnimationFrame(frame); } }, stop() { cancelAnimationFrame(raf); raf = 0; } };
  };
  const ease = (x) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);

  /* Renewal (9 s): the price read forks. Path A fills and card 1 lights; then path B runs
     72 h notice (card 2 counts down), 48 h grace and a 24 h auction (card 3's price falls 100% -> 50%). */
  const renewal = document.getElementById('renewal');
  if (renewal) {
    const cards = renewal.querySelectorAll('.card');
    const railA = renewal.querySelector('.rn__a .rn__rail'), railB = renewal.querySelector('.rn__b .rn__rail');
    const chip2 = cards[1]?.querySelector('.chip'), bar1 = cards[0]?.querySelector('.bar i'), bar2 = cards[1]?.querySelector('.bar i');
    const chip3 = cards[2]?.querySelector('.chip'), price3 = cards[2]?.querySelector('.steps-ui b'), bar3 = cards[2]?.querySelector('.bar i');
    const base = { c2: chip2?.textContent, c3: chip3?.textContent, p3: price3?.textContent };
    const on = (n) => cards.forEach((c, i) => c.classList.toggle('is-on', i === n));
    const set = (el, v) => el && el.style.setProperty(el.closest('.rn__rail') ? '--p' : '--b', String(v));
    const c = clock((ms) => {
      const t = ms % 9000;
      if (t < 3000) {
        const a = ease(t / 2500);
        set(railA.querySelector('i'), a); set(railB.querySelector('i'), 0); set(bar1, a); on(0);
        if (chip2) chip2.textContent = base.c2; set(bar2, 1);
        if (chip3) chip3.textContent = base.c3; if (price3) price3.textContent = base.p3; set(bar3, 1);
        return;
      }
      const b = Math.min(1, (t - 3000) / 5500);
      set(railA.querySelector('i'), 1); set(railB.querySelector('i'), b);
      if (b < 0.5) {
        const h = Math.max(1, Math.ceil(72 * (1 - b / 0.5)));
        on(1); if (chip2) chip2.textContent = `${h} h left`; set(bar2, h / 72);
      } else {
        on(2); if (chip2) chip2.textContent = '0 h left'; set(bar2, 0.02);
        const auction = (b - 5 / 6) / (1 / 6);
        const pct = auction < 0 ? 100 : Math.round(100 - 50 * Math.min(1, auction));
        if (chip3) chip3.textContent = auction < 0 ? 'Grace' : base.c3;
        if (price3) price3.textContent = `${pct}% of price`; set(bar3, pct / 100);
      }
    });
    loops.set(renewal, { start: () => c.start(), stop: () => {
      c.stop(); on(-1);
      [railA?.querySelector('i'), railB?.querySelector('i'), bar1, bar2, bar3].forEach((el) => el && el.style.removeProperty(el.closest('.rn__rail') ? '--p' : '--b'));
      if (chip2) chip2.textContent = base.c2; if (chip3) chip3.textContent = base.c3; if (price3) price3.textContent = base.p3;
    } });
    io.observe(renewal);
  }
  const lend = document.getElementById('lend'); if (lend) io.observe(lend);

  /* Dip (7.5 s): the price line draws itself. When it crosses below the line, the liquidation-line
     lender's card turns red; when it reaches renewal, Ankora's card lights. */
  const dip = document.getElementById('dip');
  const path = dip?.querySelector('.chart .px');
  if (dip && path) {
    const svg = path.ownerSVGElement, len = path.getTotalLength(), stage = dip.querySelector('.dip') || dip;
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('r', '7'); dot.setAttribute('class', 'bx-dot');
    svg.appendChild(dot);
    path.style.strokeDasharray = `${len}`;
    const place = (k) => {
      const p = path.getPointAtLength(len * k);
      dot.setAttribute('cx', p.x.toFixed(1)); dot.setAttribute('cy', p.y.toFixed(1));
      dot.classList.toggle('is-low', p.y > 322);
      return p;
    };
    const rest = () => { path.style.strokeDashoffset = '0'; place(1); stage.classList.remove('is-playing', 'hit-low', 'hit-end'); };
    rest();
    const c = clock((ms) => {
      const t = ms % 7500, k = Math.min(1, t / 5000);
      path.style.strokeDashoffset = `${len * (1 - k)}`;
      const p = place(k);
      stage.classList.toggle('hit-low', p.x >= 742);
      stage.classList.toggle('hit-end', k >= 1);
    });
    loops.set(dip, { start() { stage.classList.add('is-playing'); c.start(); }, stop() { c.stop(); rest(); } });
    io.observe(dip);
  }
  document.addEventListener('visibilitychange', () => loops.forEach((l, el) => (document.hidden || !el.classList.contains('is-live')) ? l.stop() : l.start()));
})();
