/* Kinetic grid: a fixed dot-and-line grid behind the page, pulled toward the pointer.
   Adapted from Originkit's Kinetic Grid, bounded for a landing page:
   - lines and dots are batched into a few paths per frame (not one stroke per segment);
   - the loop runs only while the pointer moves, a trail is fading or dots are settling, then stops;
   - it stops while the tab is hidden; touch-only devices and reduced motion get one static frame. */
(() => {
  const canvas = document.querySelector('[data-kinetic-grid]');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const css = getComputedStyle(canvas);
  const LINE = css.getPropertyValue('--kg-line').trim() || '#fda856';
  const DOT = css.getPropertyValue('--kg-dot').trim() || '#fafafa';
  const TRAIL = css.getPropertyValue('--kg-trail').trim() || '#fda856';
  const GAP = 36, R = 220, PULL = 1.4, BANDS = 6, TRAIL_MS = 260;
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches || !matchMedia('(hover: hover) and (pointer: fine)').matches;

  let W = 1, H = 1, cols = 0, rows = 0, dots = [], raf = 0;
  const mouse = { x: -1e4, y: -1e4, active: false };
  const trail = [];

  const build = () => {
    W = innerWidth; H = innerHeight;
    const dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = Math.floor(W * dpr); canvas.height = Math.floor(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cols = Math.floor(W / GAP) + 2; rows = Math.floor(H / GAP) + 2;
    const ox = (W - (cols - 1) * GAP) / 2, oy = (H - (rows - 1) * GAP) / 2;
    dots = new Array(cols * rows);
    for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) {
      const hx = ox + c * GAP, hy = oy + r * GAP;
      dots[c * rows + r] = { hx, hy, x: hx, y: hy, vx: 0, vy: 0, p: 0 };
    }
  };

  /* One frame: physics, then base mesh in one stroke, then near-pointer segments in BANDS strokes. */
  const draw = (step) => {
    let energy = 0;
    for (const d of dots) {
      let ax = (d.hx - d.x) * 0.08, ay = (d.hy - d.y) * 0.08, p = 0;
      if (mouse.active) {
        const dx = mouse.x - d.x, dy = mouse.y - d.y, dist = Math.hypot(dx, dy);
        if (dist < R && dist > 0.001) { p = 1 - dist / R; ax += (dx / dist) * p * PULL; ay += (dy / dist) * p * PULL; }
      }
      d.p = p;
      if (step) {
        d.vx = (d.vx + ax) * 0.82; d.vy = (d.vy + ay) * 0.82; d.x += d.vx; d.y += d.vy;
        energy += Math.abs(d.vx) + Math.abs(d.vy) + Math.abs(d.hx - d.x) + Math.abs(d.hy - d.y);
      }
    }
    ctx.clearRect(0, 0, W, H);
    const base = new Path2D(), near = Array.from({ length: BANDS }, () => new Path2D());
    const seg = (a, b) => {
      const p = Math.max(a.p, b.p);
      const path = p > 0 ? near[Math.min(BANDS - 1, Math.floor(p * BANDS))] : base;
      path.moveTo(a.x, a.y); path.lineTo(b.x, b.y);
    };
    for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) {
      const d = dots[c * rows + r];
      if (c + 1 < cols) seg(d, dots[(c + 1) * rows + r]);
      if (r + 1 < rows) seg(d, dots[c * rows + r + 1]);
    }
    ctx.strokeStyle = LINE;
    ctx.globalAlpha = 0.09; ctx.lineWidth = 0.6; ctx.stroke(base);
    near.forEach((path, i) => { const p = (i + 0.5) / BANDS; ctx.globalAlpha = 0.09 + p * 0.6; ctx.lineWidth = 0.5 + p * 1.2; ctx.stroke(path); });

    const dotBase = new Path2D(), dotNear = Array.from({ length: BANDS }, () => new Path2D());
    for (const d of dots) {
      if (d.p > 0) { const i = Math.min(BANDS - 1, Math.floor(d.p * BANDS)), rad = 0.8 + ((i + 0.5) / BANDS) * 1.8; dotNear[i].moveTo(d.x + rad, d.y); dotNear[i].arc(d.x, d.y, rad, 0, 2 * Math.PI); }
      else { dotBase.moveTo(d.x + 0.8, d.y); dotBase.arc(d.x, d.y, 0.8, 0, 2 * Math.PI); }
    }
    ctx.fillStyle = DOT;
    ctx.globalAlpha = 0.26; ctx.fill(dotBase);
    dotNear.forEach((path, i) => { ctx.globalAlpha = 0.26 + ((i + 0.5) / BANDS) * 0.7; ctx.fill(path); });

    let trailLive = false;
    if (step && trail.length > 1) {
      const now = performance.now();
      ctx.strokeStyle = TRAIL; ctx.lineWidth = 2; ctx.lineCap = 'round';
      for (let i = 1; i < trail.length; i++) {
        const age = now - trail[i].t;
        if (age > TRAIL_MS) continue;
        trailLive = true;
        ctx.globalAlpha = (1 - age / TRAIL_MS) * 0.7;
        ctx.beginPath(); ctx.moveTo(trail[i - 1].x, trail[i - 1].y); ctx.lineTo(trail[i].x, trail[i].y); ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    return mouse.active || trailLive || energy > 0.5;
  };

  const loop = () => { raf = draw(true) ? requestAnimationFrame(loop) : 0; };
  const wake = () => { if (!raf && !document.hidden) raf = requestAnimationFrame(loop); };

  build(); draw(false);
  addEventListener('resize', () => { build(); draw(false); }, { passive: true });
  if (still) return;

  addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    mouse.x = e.clientX; mouse.y = e.clientY; mouse.active = true;
    trail.push({ x: e.clientX, y: e.clientY, t: performance.now() });
    if (trail.length > 60) trail.shift();
    wake();
  }, { passive: true });
  document.documentElement.addEventListener('pointerleave', () => { mouse.active = false; wake(); });
  addEventListener('blur', () => { mouse.active = false; wake(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { cancelAnimationFrame(raf); raf = 0; } else wake(); });
  /* The page scrolls over a fixed grid: the pointer's grid position changes, so wake on scroll too. */
  addEventListener('scroll', () => { if (mouse.active) wake(); }, { passive: true });
})();
