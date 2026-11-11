/* Ankora UX prototype. Static, no build step. All balances, prices and names are demo data.
   Mechanism numbers come from research_docs/ (menu, notice/grace/auction windows, tranche returns). */
(() => {
  'use strict';

  // ---------- constants ----------
  const MIN = 6e4, HOUR = 36e5, DAY = 864e5;
  const NOW0 = Date.UTC(2026, 10, 10, 14, 0); // Tue 10 Nov 2026, 14:00 UTC
  const D = {
    wallet: 'alex.near',
    usdc: 2140,
    walletNear: { amt: 5000 }, // liquid NEAR in the wallet, demo (v1 collateral is plain NEAR only)
    native: { amt: 12000, pool: 'northstar.poolv1.near' }, // fictional validator
    price: 3.0, // NEAR in USD, demo; lower of Pyth spot and EMA
  };
  const MENU = [
    { ltv: 30, days: 30, rate: 9.7, key: 'l30' },
    { ltv: 40, days: 14, rate: 10.1, key: 'l40' },
    { ltv: 50, days: 7, rate: 11.3, key: 'l50' },
  ];
  const LIMIT = 50;
  const NOTICE_H = 72, GRACE_H = 48, AUCTION_H = 24, UNSTAKE_H = 28;

  const qs = new URLSearchParams(location.search);
  const EMBED = qs.has('embed');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- helpers ----------
  const $ = (s, r = document) => r.querySelector(s);
  const r2 = n => Math.round(n * 100) / 100;
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
  const money = (n, dp = 2) => n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  const num = (n, dp = 0) => n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  const pct = n => (Math.round(n * 10) / 10).toFixed(1) + '%';
  const fmt = (t, o) => new Date(t).toLocaleString('en-GB', { timeZone: 'UTC', ...o });
  const wd = t => fmt(t, { weekday: 'short' });
  const dayMon = t => fmt(t, { day: 'numeric', month: 'short' });
  const dateLong = t => `${wd(t)} ${dayMon(t)}`;
  const hm = t => fmt(t, { hour: '2-digit', minute: '2-digit', hour12: false });
  const stampDate = t => fmt(t, { day: '2-digit', month: 'short' }).toUpperCase();
  const yy = t => fmt(t, { year: 'numeric' });
  const bandFor = ltv => (ltv <= 30 ? MENU[0] : ltv <= 40 ? MENU[1] : ltv <= 50 ? MENU[2] : null);
  const symOf = () => 'NEAR';
  const valueOf = (col, amt, price) => amt * price;
  const RESERVE = 1.5; // NEAR held back for the vault's storage (copy: quote.reserve)
  const collAmt0 = col => (col === 'wallet' ? ((S && S.walletAmt) || D.walletNear.amt) : D.native.amt);
  const VAULT_ID = 'v-0417.ankora.near'; // fictional demo id
  const interestFor = (debt, band) => r2(debt * (band.rate / 100) * (band.days / 365));

  function quote(col, ltv, price) {
    const amt = collAmt0(col);
    const value = valueOf(col, amt, price);
    const debt = r2(value * ltv / 100);
    const band = bandFor(ltv);
    const interest = interestFor(debt, band);
    return { col, amt, value, debt, band, interest, receive: r2(debt - interest) };
  }

  function mkLoan(col, ltv, start, price) {
    const q = quote(col, ltv, price);
    return {
      col, collAmt: q.amt, debt: q.debt, band: q.band, start, due: start + q.band.days * DAY,
      firstInterest: q.interest, autoRenew: true,
      history: [{ t: start, kind: 'done', text: `Borrowed ${money(q.debt)} USDC`, sub: `${money(q.interest)} interest paid upfront` }],
    };
  }
  const loanValue = (L, price = S.price) => valueOf(L.col, L.collAmt, price);
  const loanLtv = (L, price = S.price) => (L.debt / loanValue(L, price)) * 100;
  // No late fee: after the term ends, interest just keeps running at the plan rate.
  const lateInterest = L => (S.now > L.due ? r2(L.debt * (L.band.rate / 100) * ((S.now - L.due) / DAY) / 365) : 0);
  // Repaying (including during an auction) settles the debt; late days are charged only when a loan renews late.
  const owed = L => L.debt;

  // ---------- icons (authored, 24 grid, 1.75 stroke) ----------
  const P = {
    arrowR: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
    arrowL: '<path d="M19 12H5"/><path d="m11 18-6-6 6-6"/>',
    chevR: '<path d="m9 18 6-6-6-6"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    renew: '<path d="M3 12a9 9 0 0 1 15.4-6.4L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.4 6.4L3 16"/><path d="M8 16H3v5"/>',
    shield: '<path d="M20 13c0 5-3.5 7.5-7.7 9a1 1 0 0 1-.6 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.2-2.7a1.2 1.2 0 0 1 1.6 0C14.5 3.8 17 5 19 5a1 1 0 0 1 1 1z"/>',
    wallet: '<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
    alert: '<path d="m21.7 18-8-14a2 2 0 0 0-3.5 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    layers: '<path d="M12.8 2.2a2 2 0 0 0-1.6 0L2.6 6.1a1 1 0 0 0 0 1.8l8.6 3.9a2 2 0 0 0 1.6 0l8.6-3.9a1 1 0 0 0 0-1.8Z"/><path d="m22 17.6-9.2 4.2a2 2 0 0 1-1.6 0L2 17.6"/><path d="m22 12.6-9.2 4.2a2 2 0 0 1-1.6 0L2 12.6"/>',
    lock: '<rect width="16" height="10" x="4" y="11" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    cal: '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>',
    hourglass: '<path d="M5 22h14"/><path d="M5 2h14"/><path d="M17 22v-4.2a2 2 0 0 0-.6-1.4L12 12l-4.4 4.4a2 2 0 0 0-.6 1.4V22"/><path d="M7 2v4.2a2 2 0 0 0 .6 1.4L12 12l4.4-4.4a2 2 0 0 0 .6-1.4V2"/>',
    note: '<rect width="20" height="12" x="2" y="6" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01M18 12h.01"/>',
    bank: '<path d="M3 21h18"/><path d="M6 18v-7"/><path d="M10 18v-7"/><path d="M14 18v-7"/><path d="M18 18v-7"/><path d="M12 3 20 8H4z"/>',
    pulse: '<path d="M22 12h-2.5a2 2 0 0 0-1.9 1.5l-2.4 8.3a.3.3 0 0 1-.5 0L9.2 2.2a.3.3 0 0 0-.5 0l-2.4 8.3A2 2 0 0 1 4.5 12H2"/>',
    receive: '<path d="M12 3v13"/><path d="m6 10 6 6 6-6"/><path d="M5 21h14"/>',
    send: '<path d="M12 21V8"/><path d="m6 14 6-6 6 6"/><path d="M5 3h14"/>',
    ok: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    ext: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    server: '<rect width="18" height="7" x="3" y="3" rx="1.5"/><rect width="18" height="7" x="3" y="14" rx="1.5"/><path d="M7 6.5h.01M7 17.5h.01"/>',
    gavel: '<path d="m14 13-8.4 8.4a2 2 0 0 1-2.8-2.8L11.2 10"/><path d="m16 16 6-6"/><path d="m8 8 6-6"/><path d="m9 7 8 8"/><path d="m21 11-8-8"/>',
  };
  const ic = (n, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${P[n] || ''}</svg>`;

  const MARK = {
    a: '<svg viewBox="0 0 28 24" aria-hidden="true"><rect x="2.5" y="4.5" width="23" height="15" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M7 10h14M7 14.5h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    b: '<svg viewBox="0 0 30 24" aria-hidden="true"><path d="M6 12h18" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><circle cx="6" cy="12" r="4.2" fill="var(--bg)" stroke="currentColor" stroke-width="2.6"/><circle cx="24" cy="12" r="4.2" fill="var(--bg)" stroke="currentColor" stroke-width="2.6"/></svg>',
    c: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="3" fill="var(--panel)"/><path d="M6 12h11M12.5 7l5 5-5 5" fill="none" stroke="var(--sign)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };
  const DIRS = { a: 'Due Date', b: 'Line', c: 'Next' };

  // ---------- state ----------
  let S;
  function baseState(dir) {
    return {
      dir: dir || 'b', pal: (S && S.pal) || qs.get('p') || 'petrol', now: NOW0, price: D.price, usdc: D.usdc,
      hasWallet: true, hasNative: true, col: 'wallet', ltv: 30, auction: null, claim: 0, repayPart: false,
      loan: null, notice: null, choice: 'cash', cashTarget: 50,
      native: { stage: 'none', startedAt: null, amt: D.native.amt },
      lend: { tranche: 'senior', amt: '', ack: false }, positions: [],
      last: null, fresh: {},
    };
  }
  const SCEN = {
    fresh: { label: 'No loan, holds NEAR and native stake', fn: s => s },
    'native-only': { label: 'No loan, native stake only', fn: s => { s.hasWallet = false; s.col = 'native'; return s; } },
    midterm: { label: 'Loan, day 15 of 30, NEAR $2.40', fn: s => { s.loan = mkLoan('wallet', 30, NOW0 - 15 * DAY, D.price); s.price = 2.4; s.usdc = D.usdc + 4464.12; return s; } },
    wick: { label: 'Loan during a wick, NEAR $1.60', fn: s => { s.loan = mkLoan('wallet', 30, NOW0 - 15 * DAY, D.price); s.price = 1.6; s.usdc = D.usdc + 4464.12; return s; } },
    notice: { label: 'Renewal check failed, NEAR $1.70', fn: s => { s.loan = mkLoan('wallet', 30, NOW0 - 30 * DAY, D.price); s.now = NOW0 + 18 * MIN; s.price = 1.7; s.usdc = 4800; s.notice = { at: NOW0, price: 1.7 }; return s; } },
    breaker: { label: 'New loans paused: price moving fast', fn: s => { s.paused = 'breaker'; return s; } },
    junior: { label: 'New loans paused: junior cover short', fn: s => { s.paused = 'junior'; return s; } },
    auction: { label: 'Auction running: repay to stop it', fn: s => { s.loan = mkLoan('wallet', 30, NOW0 - 30 * DAY, D.price); s.price = 1.2; s.notice = { at: NOW0, price: 1.7 }; s.auction = { start: NOW0 + 120 * HOUR }; s.now = NOW0 + 123 * HOUR; s.usdc = D.usdc + 4464.12; return s; } },
    surplus: { label: 'Loan auctioned: surplus to claim', fn: s => { s.claim = 1314.02; s.claimFrom = NOW0 + 144 * HOUR; s.now = NOW0 + 150 * HOUR; return s; } },
    unstaking: { label: 'Native: unstaking, 9 h in', fn: s => { s.hasWallet = false; s.col = 'native'; s.native = { stage: 'unstaking', startedAt: NOW0 - 9 * HOUR, amt: D.native.amt }; return s; } },
    ready: { label: 'Native: unstake finished', fn: s => { s.hasWallet = false; s.col = 'native'; s.native = { stage: 'ready', startedAt: NOW0 - 28 * HOUR, amt: D.native.amt }; return s; } },
  };
  function loadScenario(name, dir) {
    const s = baseState(dir || (S && S.dir) || qs.get('d') || 'a');
    S = (SCEN[name] || SCEN.fresh).fn(s);
    S.scen = SCEN[name] ? name : 'fresh';
  }

  // ---------- flows (tap counter) ----------
  const FLOWS = [
    { id: 'wallet', name: 'Borrow with NEAR in your wallet', scen: 'fresh', start: 'home', end: 'borrowed', target: 3 },
    { id: 'native', name: 'Borrow against native stake', scen: 'native-only', start: 'home', end: 'borrowed', target: null },
    { id: 'loan', name: 'Check your loan', scen: 'midterm', start: 'home', end: 'loan', target: 0 },
    { id: 'autorenew', name: 'Switch auto-renew off', scen: 'midterm', start: 'home', endAct: 'autorenew', target: 2 },
    { id: 'notice', name: 'Renewal notice: pay down', scen: 'notice', start: 'home', end: 'paid', target: null },
    { id: 'notice-repay', name: 'Renewal notice: repay in full', scen: 'notice', start: 'home', end: 'repaid', target: null },
    { id: 'auction', name: 'Auction: repay to stop it', scen: 'auction', start: 'home', end: 'repaid', target: null },
    { id: 'claim', name: 'Claim auction surplus', scen: 'surplus', start: 'home', end: 'claimed', target: null },
    { id: 'repay', name: 'Repay early', scen: 'midterm', start: 'home', end: 'repaid', target: 3 },
    { id: 'senior', name: 'Lend, senior', scen: 'fresh', start: 'home', end: 'lent', target: null },
    { id: 'junior', name: 'Lend, junior', scen: 'fresh', start: 'home', end: 'lent', target: null },
    { id: 'risk', name: 'See how it can fail', scen: 'midterm', start: 'home', end: 'risk', target: null },
  ];
  const T = { run: null, n: 0, done: null };
  function tap(el) {
    if (el && el.closest('[data-proto]')) return;
    T.n++;
    renderHud();
  }

  // ---------- routing ----------
  const cur = () => (location.hash.replace(/^#\/?/, '') || 'home');
  function resolveHome() {
    if (S.loan && S.auction) return 'auction';
    if (S.loan && S.notice) return 'notice';
    if (!S.loan && S.claim > 0) return 'surplus';
    if (S.loan) return 'loan';
    if (S.native.stage === 'unstaking') return 'wait';
    if (S.native.stage === 'ready') return 'ready';
    return 'borrow';
  }
  // Routes that need state fall back to home when it isn't there (e.g. after a reload).
  const NEEDS = {
    borrowed: () => S.loan, paid: () => S.loan, loan: () => S.loan, repay: () => S.loan,
    notice: () => S.loan && S.notice, auction: () => S.loan && S.auction, surplus: () => S.claim > 0, claimed: () => S.last && S.last.claimed, repaid: () => S.last && S.last.history,
    lent: () => S.positions.length, wait: () => S.native.stage === 'unstaking', ready: () => S.native.stage === 'ready',
  };
  const screenId = () => {
    const r = cur();
    if (r === 'home' || !SCR[r] || (NEEDS[r] && !NEEDS[r]())) return resolveHome();
    return r;
  };
  function go(r) {
    if (cur() === r) transition(render);
    else location.hash = '#/' + r;
  }

  // ---------- signature components ----------
  function sigTerm({ start, due, now, band, mode = 'live', fresh = false, label = 'Next price check' }) {
    const total = due - start, frac = clamp((now - start) / total, 0, 1);
    const daysLeft = Math.max(0, Math.ceil((due - now) / DAY));
    const elapsed = Math.floor((now - start) / DAY);
    if (S.dir === 'a') {
      const cells = Array.from({ length: band.days }, (_, i) => `<i class="${i < elapsed ? 'on' : ''}${i === elapsed ? ' today' : ''}"></i>`).join('');
      return `<div class="a-due is-${mode}">
        <div class="a-due-top"><span class="kick">${label}</span><span class="a-due-in">${mode === 'quote' ? `${band.days} days from today` : `in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`}</span></div>
        <div class="stamp stamp-xl${fresh ? ' land' : ''}" aria-label="${dateLong(due)}"><b>${stampDate(due)}</b><span>${yy(due)}</span></div>
        <div class="a-due-meta">${wd(due)} · ${hm(due)} UTC</div>
        <div class="a-strip" style="--n:${band.days}" aria-hidden="true">${cells}</div>
        <div class="a-strip-legend"><span>${dayMon(start)}</span><span>${mode === 'quote' ? `${band.days}-day term` : `day ${Math.min(elapsed + 1, band.days)} of ${band.days}`}</span><span>${dayMon(due)}</span></div>
      </div>`;
    }
    if (S.dir === 'b') {
      const x0 = 14, x1 = 268, x2 = 318, y = 40;
      const xh = x0 + (x1 - x0) * frac;
      const hereLabel = mode === 'quote' ? 'Today' : `Today · day ${Math.min(elapsed + 1, band.days)}`;
      const anchor = xh < 70 ? 'start' : xh > 220 ? 'end' : 'middle';
      return `<div class="b-term is-${mode}" style="--lc: var(--${band.key})">
        <svg class="b-svg${fresh ? ' draw' : ''}" viewBox="0 0 332 104" role="img" aria-label="Term from ${dayMon(start)} to price check on ${dayMon(due)}">
          <path class="b-future" d="M${x1} ${y} H${x2}" />
          <path class="b-branch" d="M${x1} ${y} v30 q0 12 12 12 h${x2 - x1 - 12}" />
          <path class="b-track" pathLength="1" d="M${x0} ${y} H${x1}" />
          <circle class="b-st" cx="${x0}" cy="${y}" r="8.5"/>
          <circle class="b-st b-st-check" cx="${x1}" cy="${y}" r="10"/>
          ${mode === 'quote' ? '' : `<circle class="b-halo" cx="${xh}" cy="${y}" r="13"/><circle class="b-here" cx="${xh}" cy="${y}" r="6.5"/>`}
          <text class="b-t b-t-here" x="${mode === 'quote' ? x0 : xh}" y="${y - 20}" text-anchor="${mode === 'quote' ? 'start' : anchor}">${hereLabel}</text>
          <text class="b-t" x="${x0}" y="${y + 30}">${dayMon(start)}</text>
          <text class="b-t b-t-strong" x="${x1 - 14}" y="${y + 30}" text-anchor="end">${dayMon(due)} price check</text>
          <text class="b-t b-t-dim" x="${x2}" y="${y - 20}" text-anchor="end">renews</text>
          <text class="b-t b-t-branch" x="${x2}" y="${y + 60}" text-anchor="end">only if LTV &gt; 50%: notice</text>
        </svg>
        <div class="b-term-big"><b>${mode === 'quote' ? band.days : daysLeft}</b><span>days ${mode === 'quote' ? 'until the first price check' : 'to the next station'}<br><em>${dateLong(due)} · ${hm(due)} UTC</em></span></div>
      </div>`;
    }
    // c
    return `<div class="c-gate is-${mode}">
      <div class="c-gate-num${fresh ? ' land' : ''}">${mode === 'quote' ? band.days : daysLeft}</div>
      <div class="c-gate-side">
        <div class="c-gate-unit">days to ${mode === 'quote' ? 'first' : 'next'} price check</div>
        <div class="c-sign">${ic('clock', 'picto')}<span>${dateLong(due)} · ${hm(due)}</span></div>
      </div>
      <div class="c-bar" aria-hidden="true"><i style="width:${(mode === 'quote' ? 0 : frac) * 100}%"></i></div>
    </div>`;
  }

  // A sequence of events: [{t, title, sub, kind: done|next|future|danger, dur?(hours for scaling)}]
  function sigPath(items, { scaled = false, line = 'l30' } = {}) {
    const maxDur = Math.max(...items.map(i => i.dur || 0), 1);
    if (S.dir === 'a') {
      return `<ol class="a-slip">${items.map(i => `
        <li class="a-slip-row k-${i.kind}">
          <span class="stamp stamp-s">${i.stamp || (i.t ? stampDate(i.t) : '')}</span>
          <span class="a-slip-txt"><b>${i.title}</b>${i.sub ? `<small>${i.sub}</small>` : ''}${scaled && i.dur ? `<span class="a-dur" style="--w:${(i.dur / maxDur) * 100}%"><i></i><em>${i.dur} h</em></span>` : ''}</span>
        </li>`).join('')}</ol>`;
    }
    if (S.dir === 'b') {
      return `<ol class="b-stations" style="--lc: var(--${line})">${items.map(i => `
        <li class="b-stn k-${i.kind}" style="${scaled && i.dur ? `--seg:${Math.round(28 + (i.dur / maxDur) * 64)}px` : ''}">
          <span class="b-dot" aria-hidden="true"></span>
          <span class="b-stn-txt"><b>${i.title}</b>${i.sub ? `<small>${i.sub}</small>` : ''}</span>
          <span class="b-stn-when">${i.when || (i.t ? `${dayMon(i.t)}<br>${hm(i.t)}` : '')}</span>
        </li>`).join('')}</ol>`;
    }
    return `<ol class="c-signs">${items.map(i => `
      <li class="c-signrow k-${i.kind}">
        ${ic(i.icon || 'clock', 'picto')}
        <span class="c-signrow-txt"><b>${i.title}</b>${i.sub ? `<small>${i.sub}</small>` : ''}</span>
        <span class="c-signrow-when">${i.when || (i.t ? `${dayMon(i.t)} · ${hm(i.t)}` : '')}</span>
        ${scaled && i.dur ? `<span class="c-dur" style="--w:${(i.dur / maxDur) * 100}%"></span>` : ''}
      </li>`).join('')}</ol>`;
  }

  function meter(ltv, { state = 'ok' } = {}) {
    const max = 60, pos = v => `${clamp(v, 0, max) / max * 100}%`;
    return `<div class="meter is-${state}" role="img" aria-label="LTV ${pct(ltv)}, renewal limit 50%">
      <div class="meter-track">
        <span class="meter-band" style="left:0;width:${pos(30)}"></span>
        <span class="meter-band b2" style="left:${pos(30)};width:${pos(10)}"></span>
        <span class="meter-band b3" style="left:${pos(40)};width:${pos(10)}"></span>
        <span class="meter-fill" style="width:${pos(ltv)}"></span>
        <span class="meter-limit" style="left:${pos(LIMIT)}"></span>
        <span class="meter-mark" style="left:${pos(ltv)}"></span>
      </div>
      <div class="meter-scale"><span style="left:${pos(30)}">30</span><span style="left:${pos(40)}">40</span><span class="lim" style="left:${pos(LIMIT)}">50 limit</span></div>
    </div>`;
  }

  const brandHtml = () => `${MARK[S.dir]}<span>Ankora</span>`;

  // New loans can pause; existing loans and renewals never do.
  const PAUSE = {
    breaker: { title: 'New loans are paused for a moment.', body: 'New loans are paused while the spot price and the average price are more than 3% apart. Renewals continue at the lower price. Replayed over the past three years, this pause would have been on in about 0.37% of hours.', hint: 'Paused while the prices settle. Try again shortly.' },
    junior: { title: 'New loans are paused.', body: 'This pool has lent as much as its first-loss cover allows. New loans resume when junior lenders add capital or loans are repaid.', hint: 'Paused until junior cover is back.' },
  };
  const pauseNote = () => (S.paused ? `<div class="pause" role="status">${ic('info')}<div><b>${PAUSE[S.paused].title}</b><span>${PAUSE[S.paused].body}</span></div></div>` : '');
  const pauseCta = cta => (S.paused ? { ...cta, disabled: true, hint: PAUSE[S.paused].hint } : cta);

  // ---------- screens ----------
  const SCR = {};

  SCR.borrow = () => {
    if (S.col === 'native') {
      const q = quote('native', 30, S.price);
      return {
        html: `
          <h1 class="h1">Borrow dollars against your staked NEAR.</h1>
          <div class="asset">
            <span class="asset-ic">${ic('server')}</span>
            <span class="asset-txt"><b>${num(D.native.amt)} NEAR staked</b><small>with ${D.native.pool}</small></span>
            <span class="asset-val">≈ $${num(q.value)}</span>
          </div>
          <div class="offer">
            <span class="offer-k">Up to</span>
            <span class="offer-v num">${money(q.receive)} <small>USDC</small></span>
            <span class="offer-s">30 days · about ${q.band.rate}% · priced when you borrow</span>
          </div>
          <ul class="facts">
            <li>${ic('server')}<span><b>Keep your validator.</b> Unstake once (about 28 hours); your vault then re-stakes with ${D.native.pool}.</span></li>
            <li>${ic('shield')}<span>A wick can't liquidate this loan. The price is read only when a term starts or renews.</span></li>
          </ul>
          ${S.hasWallet ? `<button class="link" data-act="col" data-col="wallet">Use the ${num(D.walletNear.amt)} NEAR in your wallet instead (no unstaking)</button>` : ''}
          <p class="demo">Demo balances and price.</p>`,
        cta: { label: 'Continue', go: 'native' },
        ctx: ctxHowItRuns(q),
      };
    }
    const q = quote('wallet', 30, S.price);
    return {
      html: `
        <h1 class="h1">Borrow dollars. Keep your NEAR staked.</h1>
        ${pauseNote()}
        <div class="asset">
          <span class="asset-ic tok">N</span>
          <span class="asset-txt"><b>${num(D.walletNear.amt)} NEAR in your wallet</b><small>your vault stakes it with ${D.native.pool}</small></span>
          <span class="asset-val">≈ $${num(q.value)}</span>
        </div>
        <div class="offer">
          <span class="offer-k">You can get</span>
          <span class="offer-v num">${money(q.receive)} <small>USDC</small></span>
          <span class="offer-s">30% plan · 30-day term · ${q.band.rate}% a year, fixed for this term</span>
        </div>
        <ul class="facts">
          <li>${ic('shield')}<span><b>A wick can't liquidate you.</b> The price is read when a term starts or renews, never in between.</span></li>
          <li>${ic('server')}<span>Staked with the validator you already use. Rewards stay in your vault.</span></li>
        </ul>
        ${S.hasNative ? `<button class="link" data-act="col" data-col="native">Use your ${num(D.native.amt)} staked NEAR instead</button>` : ''}
        <p class="demo">Demo balances and price.</p>`,
      cta: pauseCta({ label: 'Continue', go: 'review' }),
      ctx: ctxHowItRuns(q),
    };
  };

  function reviewNumbers() {
    const q = quote(S.col, S.ltv, S.price);
    return q;
  }
  SCR.review = () => {
    const q = reviewNumbers();
    const due = S.now + q.band.days * DAY;
    const isN = S.col === 'native';
    return {
      back: 'home',
      title: `Against ${num(q.amt)} ${symOf(S.col)}`,
      html: `
        ${pauseNote()}
        <div class="recv">
          <span class="recv-k">You receive</span>
          <span class="recv-v num" data-b="recv">${money(q.receive)}</span>
          <span class="recv-u">USDC</span>
        </div>
        <div class="amount">
          <div class="amount-top"><label for="ltv">Borrow <b class="num" data-b="debt">${money(q.debt)}</b> USDC</label><span class="amount-pct num" data-b="ltv">${S.ltv}% LTV</span></div>
          <input id="ltv" class="range" type="range" min="10" max="50" step="1" value="${S.ltv}" aria-describedby="ltv-help">
          <div class="menu" role="radiogroup" aria-label="Term">
            ${MENU.map(b => `<button class="menu-cell ${b.key}" role="radio" aria-checked="${q.band === b}" data-act="band" data-ltv="${b.ltv}">
              <b>${b.ltv}% plan</b><span>${b.days}-day term</span><small>${b.rate}% a year</small></button>`).join('')}
          </div>
          <p class="amount-help" id="ltv-help">Higher LTV, shorter term. Nothing above 50%. In a volatile market new terms can be shortened; a running term never changes.</p>
        </div>
        <ul class="facts">
          <li>${ic('note')}<span data-b="f1">${money(q.debt)} loan, minus <b class="num">${money(q.interest)}</b> interest for the first ${q.band.days} days, paid upfront. ${q.band.rate}% a year, fixed for this term.</span></li>
          <li>${ic('clock')}<span data-b="f2">Renews <b>${dateLong(due)} at ${hm(due)} UTC</b> if your LTV is 50% or lower then. No price is read before that.</span></li>
          <li>${ic('wallet')}<span>Send <b class="num">${num(q.amt + RESERVE, 1)} NEAR</b>: ${num(q.amt)} as collateral, plus 1.5 NEAR held back for your vault's storage.</span></li>
          <li>${ic('server')}<span>Your ${num(q.amt)} NEAR goes into your own vault, staked with <b>${D.native.pool}</b>. <button class="link inline" data-act="toast" data-msg="Validator picker: any pool on lockup-whitelist.near. Defaults to the one you already use.">Change</button></span></li>
        </ul>`,
      cta: pauseCta({ label: `Borrow ${money(q.receive)} USDC`, act: 'borrow', b: 'cta' }),
      ctx: ctxHowItRuns(q),
    };
  };
  function updateReview() {
    const q = reviewNumbers();
    const due = S.now + q.band.days * DAY;
    const set = (k, v) => { const n = document.querySelector(`[data-b="${k}"]`); if (n) n.innerHTML = v; };
    set('recv', money(q.receive));
    set('debt', money(q.debt));
    set('ltv', `${S.ltv}% LTV`);
    set('f1', `${money(q.debt)} loan, minus <b class="num">${money(q.interest)}</b> interest for the first ${q.band.days} days, paid upfront. ${q.band.rate}% a year, fixed for this term.`);
    set('f2', `Renews <b>${dateLong(due)} at ${hm(due)} UTC</b> if your LTV is 50% or lower then. No price is read before that.`);
    document.querySelectorAll('.menu-cell').forEach(c => c.setAttribute('aria-checked', String(+c.dataset.ltv === q.band.ltv)));
    setCta(`Borrow ${money(q.receive)} USDC`);
    document.documentElement.style.setProperty('--line-cur', `var(--${q.band.key})`);
    $('#context').innerHTML = ctxHowItRuns(q);
  }

  SCR.borrowed = () => {
    const L = S.loan;
    const recv = S.last && S.last.received;
    return {
      html: `
        <div class="done">
          <span class="done-ic">${ic('check')}</span>
          <h1 class="h1">Done. <span class="num">${money(recv || 0)}</span> USDC is in your wallet.</h1>
        </div>
        ${sigTerm({ start: L.start, due: L.due, now: S.now, band: L.band, mode: 'quote', fresh: true })}
        <p class="lede">Your NEAR is staked with ${D.native.pool}. Your term ends ${dateLong(L.due)} at ${hm(L.due)} UTC. Nothing to do until then.</p>`,
      cta: { label: 'See your loan', go: 'home' },
      ctx: ctxLoan(L),
    };
  };

  SCR.loan = () => {
    const L = S.loan;
    const ltv = loanLtv(L);
    const nb = bandFor(ltv);
    const warn = ltv > LIMIT;
    const v = loanValue(L);
    const payTo50 = Math.max(0, L.debt - 0.5 * v);
    return {
      html: `
        ${sigTerm({ start: L.start, due: L.due, now: S.now, band: L.band, mode: warn ? 'warn' : 'live', fresh: !!S.fresh.loan })}
        <h1 class="h1">Nothing to do until ${dateLong(L.due)}.</h1>
        <p class="lede">That's your next price check. Until then no price move can change this loan${warn ? ', including this one' : ''}.</p>
        <section class="ltv ${warn ? 'is-warn' : ''}">
          <div class="ltv-top"><span>LTV now</span><b class="num">${pct(ltv)}</b></div>
          ${meter(ltv, { state: warn ? 'warn' : 'ok' })}
          <p class="ltv-if">${warn
            ? `${ic('alert')}<span>If NEAR is still at this price on ${dayMon(L.due)}, you'll get 72 hours to pay down about <b class="num">${money(payTo50, 0)} USDC</b>. Nothing happens before then.</span>`
            : `${ic('renew')}<span>If checked today it would renew for <b>${nb.days} days at about ${nb.rate}%</b>.</span>`}</p>
          <p class="ltv-src">NEAR $${S.price.toFixed(2)} (demo; lower of Pyth spot and EMA). Shown for information only.</p>
        </section>
        <dl class="rows">
          <div><dt>You owe</dt><dd class="num">${money(L.debt)} USDC</dd></div>
          <div><dt>Collateral</dt><dd><span class="num">${num(L.collAmt, L.collAmt % 1 ? 2 : 0)}</span> ${symOf(L.col)} <small>≈ $${num(v)}</small></dd></div>
          <div><dt>Staking rewards</dt><dd>Stay in your vault</dd></div>
          <div class="row-switch"><dt id="ar-l">Renew automatically</dt><dd><button class="switch" role="switch" aria-checked="${L.autoRenew}" aria-labelledby="ar-l" data-act="autorenew"><i></i></button></dd></div>
        </dl>
        <p class="note">${ic('info')}<span>${L.autoRenew ? `At ${hm(L.due)} UTC on ${dayMon(L.due)} anyone can trigger the renewal, so it happens even if you're offline.` : `Repay ${money(L.debt)} USDC by ${dateLong(L.due)}, ${hm(L.due)} UTC. If you don't, a 48-hour grace period starts straight away, then the auction.`}</span></p>
        <div class="actions">
          <button class="btn btn-2" data-go="repay">${ic('send')}<span>Repay</span></button>
          <button class="btn btn-2" data-act="part">${ic('note')}<span>Pay down part</span></button>
        </div>
        <button class="link" data-go="risk">How this can fail</button>`,
      cta: { quiet: true, label: `Nothing to do until ${dateLong(L.due)}`, icon: 'clock' },
      ctx: ctxLoan(L),
    };
  };

  function noticeNums() {
    const L = S.loan, v = loanValue(L), price = S.price;
    const cash = t => r2(Math.max(0, L.debt - (t / 100) * v));
    const payBy = S.notice.at + NOTICE_H * HOUR, graceEnd = payBy + GRACE_H * HOUR, aucEnd = graceEnd + AUCTION_H * HOUR;
    return { L, v, ltv: loanLtv(L), cash, payBy, graceEnd, aucEnd };
  }
  SCR.notice = () => {
    const n = noticeNums();
    const left = n.payBy - S.now;
    const h = Math.floor(left / HOUR), m = Math.floor((left % HOUR) / MIN);
    const canRepay = S.usdc >= n.L.debt;
    const cashAmt = n.cash(S.cashTarget);
    const canCash = S.usdc >= cashAmt;
    const tgt = MENU.find(b => b.ltv === S.cashTarget);
    const opt = (id, title, sub, extra = '', disabled = false) => `
      <div class="opt ${S.choice === id ? 'on' : ''} ${disabled ? 'off' : ''}">
        <button class="opt-btn" role="radio" aria-checked="${S.choice === id}" data-act="choice" data-c="${id}" ${disabled ? 'aria-disabled="true"' : ''}>
          <span class="opt-radio" aria-hidden="true"></span>
          <span class="opt-txt"><b>${title}</b><small>${sub}</small></span>
        </button>${extra}</div>`;
    const chips = `<div class="chips" role="radiogroup" aria-label="Pay down to">${MENU.slice().reverse().map(b => `
      <button class="chip" role="radio" aria-checked="${S.cashTarget === b.ltv}" data-act="target" data-t="${b.ltv}"><b class="num">${money(n.cash(b.ltv), 0)}</b><small>to ${b.ltv}%</small><small>${b.days}-day term</small></button>`).join('')}</div>`;
    let cta;
    if (S.choice === 'cash') cta = { label: `Repay ${money(cashAmt, 0)} USDC`, act: 'paydown', danger: true, disabled: !canCash };
    else cta = { label: `Repay all ${money(n.L.debt)} USDC`, act: 'repayAll', danger: true, disabled: !canRepay };
    return {
      html: `
        <div class="notice-head">
          ${S.dir === 'c' ? `<div class="c-gate is-danger"><div class="c-gate-num">${h}</div><div class="c-gate-side"><div class="c-gate-unit">hours left to pay down</div><div class="c-sign">${ic('alert', 'picto')}<span>by ${dateLong(n.payBy)} · ${hm(n.payBy)} UTC</span></div></div></div>`
          : S.dir === 'a' ? `<div class="a-due is-danger"><div class="a-due-top"><span class="kick">Pay down by</span><span class="a-due-in num">${h} h ${m} m left</span></div><div class="stamp stamp-xl"><b>${stampDate(n.payBy)}</b><span>${hm(n.payBy)} UTC</span></div></div>`
          : `<div class="b-alert"><span class="b-alert-dot"></span><div><b class="num">${h} h ${String(m).padStart(2, '0')} m</b><span>left to pay down · ${dateLong(n.payBy)}, ${hm(n.payBy)} UTC</span></div></div>`}
        </div>
        <h1 class="h1">Pay down by ${dateLong(n.payBy)}, ${hm(n.payBy)} UTC</h1>
        <p class="lede">At renewal your LTV was <b class="num">${pct(n.ltv)}</b>, above the 50% limit (NEAR $${S.notice.price.toFixed(2)}, demo). Repay <b class="num">${money(n.cash(50), 0)} USDC</b> to bring it to 50%, and the loan renews at the next check. If NEAR's price recovers before the deadline, it can renew without a payment.</p>
        <div class="opts" role="radiogroup" aria-label="How to pay down">
          ${opt('cash', `Repay ${money(cashAmt, 0)} USDC`, `Part of the debt. Renews on the ${tgt.ltv}% plan, ${tgt.days}-day term. Paying down further means fewer requests later. You have ${money(S.usdc, 0)} USDC.`, S.choice === 'cash' ? chips : '', !canCash)}
          ${opt('repay', `Repay all ${money(n.L.debt)} USDC`, canRepay ? `Closes the loan. The vault becomes yours, with the NEAR still staked.` : `Needs ${money(n.L.debt, 0)} USDC; you have ${money(S.usdc, 0)}.`, '', !canRepay)}
        </div>
        <section class="ifnot">
          <h2 class="h2">If you do nothing</h2>
          ${sigPath([
            { t: n.payBy, stamp: stampDate(n.payBy), title: 'Notice ends', sub: '72 hours to repay part or all of the debt', kind: 'danger', dur: NOTICE_H, icon: 'alert', when: `${dayMon(n.payBy)} · ${hm(n.payBy)}` },
            { t: n.graceEnd, stamp: stampDate(n.graceEnd), title: 'Grace ends', sub: '48 more hours on the same terms. No late fee.', kind: 'future', dur: GRACE_H, icon: 'hourglass' },
            { t: n.aucEnd, stamp: stampDate(n.aucEnd), title: 'Auction', sub: '24-hour Dutch auction: the price starts at the vault\'s value and falls to half. You can repay in full until a bid lands. Anything above your debt goes to you.', kind: 'future', dur: AUCTION_H, icon: 'gavel' },
          ], { scaled: true, line: 'danger' })}
        </section>
        <p class="note">${ic('info')}<span>There's no late fee. If the loan renews after its end date, the extra days are charged at the new plan's rate.</span></p>`,
      cta,
      ctx: ctxNotice(n),
    };
  };

  SCR.paid = () => {
    const L = S.loan, last = S.last || {};
    return {
      html: `
        <div class="done"><span class="done-ic">${ic('check')}</span>
          <h1 class="h1">${last.title || 'Done.'}</h1></div>
        ${sigTerm({ start: L.start, due: L.due, now: last.partial ? S.now : L.start, band: L.band, mode: last.partial ? 'live' : 'quote', fresh: true, label: last.partial ? 'Next price check' : 'Renewed · next price check' })}
        <p class="lede">${last.sub || ''}</p>`,
      cta: { label: 'See your loan', go: 'home' },
      ctx: ctxLoan(L),
    };
  };

  function repayAmount() {
    const L = S.loan, full = owed(L);
    if (!S.repayPart) return { amt: full, part: false };
    const amt = S.repayAmt === 'half' ? r2(L.debt / 2) : 1000;
    return { amt: Math.min(amt, full), part: true };
  }
  SCR.repay = () => {
    const L = S.loan;
    if (!L) return SCR.borrow();
    const { amt, part } = repayAmount();
    const ok = S.usdc >= amt;
    const chips = `<div class="chips flat" role="radiogroup" aria-label="Amount">
      <button class="chip" role="radio" aria-checked="${!S.repayPart}" data-act="ramt" data-v="full"><b class="num">${money(owed(L), 0)}</b><small>all of it</small></button>
      <button class="chip" role="radio" aria-checked="${S.repayPart && S.repayAmt === 'half'}" data-act="ramt" data-v="half"><b class="num">${money(L.debt / 2, 0)}</b><small>half</small></button>
      <button class="chip" role="radio" aria-checked="${S.repayPart && S.repayAmt !== 'half'}" data-act="ramt" data-v="1000"><b class="num">1,000</b><small>part</small></button></div>`;
    return {
      back: 'home', title: part ? 'Pay down part' : 'Repay',
      html: `
        <div class="recv"><span class="recv-k">You pay</span><span class="recv-v num">${money(amt)}</span><span class="recv-u">USDC</span></div>
        ${chips}
        <ul class="facts">
          ${part
            ? `<li>${ic('note')}<span>Your debt drops to <b class="num">${money(L.debt - amt)} USDC</b>. The term and the next price check stay the same; a lower LTV means a longer next term.</span></li>`
            : `<li>${ic('receive')}<span><b>The vault becomes yours</b>, with your ${num(L.collAmt)} NEAR still staked with ${D.native.pool}. No unstaking wait.</span></li>`}
          <li>${ic('note')}<span>You can repay any time. This term's interest isn't refunded.</span></li>
          <li>${ic('wallet')}<span>You have <b class="num">${money(S.usdc)}</b> USDC.</span></li>
        </ul>`,
      cta: { label: `${part ? 'Pay down' : 'Repay'} ${money(amt)} USDC`, act: 'repay', disabled: !ok, hint: ok ? '' : `You need ${money(amt - S.usdc)} more USDC.` },
      ctx: ctxLoan(L),
    };
  };

  SCR.auction = () => {
    const L = S.loan, end = S.auction.start + AUCTION_H * HOUR, left = end - S.now;
    const h = Math.floor(left / HOUR), m = Math.floor((left % HOUR) / MIN);
    const startValue = r2(loanValue(L)), frac = clamp((S.now - S.auction.start) / (AUCTION_H * HOUR), 0, 1);
    const priceNow = r2(startValue * (1 - 0.5 * frac));
    const ok = S.usdc >= L.debt;
    return {
      html: `
        <div class="notice-head">
          ${S.dir === 'c' ? `<div class="c-gate is-danger"><div class="c-gate-num">${h}</div><div class="c-gate-side"><div class="c-gate-unit">hours left in the auction</div><div class="c-sign">${ic('gavel', 'picto')}<span>ends ${dateLong(end)} · ${hm(end)}</span></div></div></div>`
          : S.dir === 'a' ? `<div class="a-due is-danger"><div class="a-due-top"><span class="kick">Auction ends</span><span class="a-due-in num">${h} h ${m} m left</span></div><div class="stamp stamp-xl"><b>${stampDate(end)}</b><span>${hm(end)} UTC</span></div></div>`
          : `<div class="b-alert"><span class="b-alert-dot"></span><div><b class="num">${h} h ${String(m).padStart(2, '0')} m</b><span>left in the auction · ends ${dateLong(end)}, ${hm(end)} UTC</span></div></div>`}
        </div>
        <h1 class="h1">Your vault is at auction until ${dateLong(end)}, ${hm(end)} UTC</h1>
        <p class="lede">It's a 24-hour Dutch auction. The price started at your vault's value and falls to half of that by the end. The lenders are repaid first, and anything above your ${money(L.debt)} USDC debt is sent to you.</p>
        <dl class="rows">
          <div><dt>Started at</dt><dd class="num">${money(startValue)} USDC</dd></div>
          <div><dt>Price now</dt><dd class="num">${money(priceNow)} USDC</dd></div>
          <div><dt>Your debt</dt><dd class="num">${money(L.debt)} USDC</dd></div>
        </dl>
        <p class="note">${ic('info')}<span>You can repay in full until a bid lands. Demo prices.</span></p>`,
      cta: { label: `Repay ${money(L.debt)} USDC and stop the auction`, act: 'repay', danger: true, disabled: !ok, hint: ok ? '' : `You need ${money(L.debt - S.usdc)} more USDC.` },
      ctx: ctxLoan(L),
    };
  };

  SCR.surplus = () => ({
    html: `
      <div class="done"><span class="done-ic">${ic('receive')}</span><h1 class="h1">Auction closed. <span class="num">${money(S.claim)}</span> USDC is yours.</h1></div>
      <p class="lede">We couldn't send it because ${D.wallet} isn't registered with USDC. Claim it here.</p>
      <p class="demo">Demo numbers.</p>`,
    cta: { label: `Claim ${money(S.claim)} USDC`, act: 'claim' },
    ctx: '',
  });
  SCR.claimed = () => ({
    html: `<div class="done"><span class="done-ic">${ic('check')}</span><h1 class="h1"><span class="num">${money(S.last.claimed)}</span> USDC is in your wallet.</h1></div>
      <p class="lede">That closes this loan for good. You can borrow again whenever you like.</p>`,
    cta: { label: 'Done', go: 'home' },
    ctx: '',
  });

  SCR.repaid = () => {
    const h = S.last || {};
    return {
      html: `
        <div class="done"><span class="done-ic">${ic('check')}</span><h1 class="h1">Repaid.</h1></div>
        <p class="lede">${h.sub || ''}</p>
        ${sigPath(h.history || [], { line: 'l30' })}`,
      cta: { label: 'Done', go: 'home' },
      ctx: '',
    };
  };

  SCR.native = () => {
    const ready = S.now + UNSTAKE_H * HOUR;
    return {
      back: 'home', title: 'Move your stake: about 28 hours',
      html: `
        <div class="validator">
          <span class="asset-ic">${ic('server')}</span>
          <span class="asset-txt"><b>${D.native.pool}</b><small>${ic('ok', 'sm')} On NEAR Foundation's lockup whitelist. Your vault can stake with it.</small></span>
        </div>
        ${sigPath([
          { title: '1. Unstake', sub: `Sign an unstake on ${D.native.pool}. Your NEAR stays with your account; Ankora can't touch it until you borrow.`, kind: 'next', stamp: 'STEP 1', when: 'now', icon: 'send' },
          { title: '2. Wait four epochs', sub: 'Usually about 28 hours; they have taken from 21 to 35. You can close this page.', kind: 'future', stamp: 'STEP 2', when: 'about 28 h', icon: 'hourglass' },
          { title: '3. Withdraw', sub: 'Sign the withdraw to move the NEAR to your wallet balance.', kind: 'future', stamp: 'STEP 3', when: `from ${dayMon(ready)}`, icon: 'receive' },
          { title: '4. Borrow', sub: `Your vault stakes it with ${D.native.pool}. If the price check fails, your NEAR comes straight back.`, kind: 'future', stamp: 'STEP 4', when: 'fresh quote', icon: 'note' },
        ], { line: 'l30' })}
        <dl class="rows">
          <div><dt>Amount</dt><dd><span class="num">${num(S.native.amt)}</span> NEAR <button class="link inline" data-act="toast" data-msg="Partial amount: not built in this prototype.">Change</button></dd></div>
          <div><dt>Rewards you miss</dt><dd>≈ <span class="num">${num(S.native.amt * 0.00017, 0)}</span> NEAR <small>0.017%</small></dd></div>
        </dl>
        <p class="note">${ic('info')}<span>Your validator is without this stake for 4 to 5 epochs.</span></p>`,
      cta: { label: `Start unstaking ${num(S.native.amt)} NEAR`, act: 'unstake' },
      ctx: ctxNative(),
    };
  };

  SCR.wait = () => {
    const st = S.native.startedAt, ready = st + UNSTAKE_H * HOUR;
    const el = clamp(S.now - st, 0, UNSTAKE_H * HOUR);
    const epochs = Math.floor(el / (7 * HOUR));
    const leftH = Math.ceil((ready - S.now) / HOUR);
    const sig = S.dir === 'a'
      ? `<div class="a-due"><div class="a-due-top"><span class="kick">Ready about</span><span class="a-due-in">in ${leftH} h</span></div><div class="stamp stamp-xl"><b>${stampDate(ready)}</b><span>${hm(ready)} UTC</span></div><div class="a-strip ep" style="--n:4">${[0, 1, 2, 3].map(i => `<i class="${i < epochs ? 'on' : ''}${i === epochs ? ' today' : ''}"></i>`).join('')}</div><div class="a-strip-legend"><span>Started ${hm(st)}</span><span>epoch ${Math.min(epochs + 1, 4)} of 4</span><span>${hm(ready)}</span></div></div>`
      : S.dir === 'b'
        ? `<ol class="b-stations" style="--lc: var(--l30)">${[0, 1, 2, 3].map(i => `<li class="b-stn k-${i < epochs ? 'done' : i === epochs ? 'next' : 'future'}"><span class="b-dot"></span><span class="b-stn-txt"><b>Epoch ${i + 1}</b><small>${i < epochs ? 'done' : i === epochs ? 'in progress' : ''}</small></span><span class="b-stn-when">${hm(st + (i + 1) * 7 * HOUR)}</span></li>`).join('')}<li class="b-stn k-future"><span class="b-dot"></span><span class="b-stn-txt"><b>Ready to borrow</b></span><span class="b-stn-when">${dayMon(ready)}</span></li></ol>`
        : `<div class="c-gate"><div class="c-gate-num">${leftH}</div><div class="c-gate-side"><div class="c-gate-unit">hours until your NEAR is ready</div><div class="c-sign">${ic('hourglass', 'picto')}<span>${dateLong(ready)} · ${hm(ready)} UTC</span></div></div><div class="c-bar"><i style="width:${(el / (UNSTAKE_H * HOUR)) * 100}%"></i></div></div>`;
    return {
      html: `
        ${sig}
        <h1 class="h1">Unstaking. Come back ${dateLong(ready)}.</h1>
        <p class="lede">Epoch ${Math.min(epochs + 1, 4)} of 4. About ${leftH} hours left. You can close this page; Ankora opens on the next step when you're back.</p>
        <p class="note">${ic('info')}<span>Your rate isn't held during the wait. You'll get a fresh quote when you borrow.</span></p>
        <div class="actions">
          <button class="btn btn-2" data-act="toast" data-msg="Would download a calendar reminder (.ics).">${ic('cal')}<span>Add reminder</span></button>
          <button class="btn btn-2" data-act="toast" data-msg="Re-stake: calls stake_unstaked on your pool. Not built here.">${ic('renew')}<span>Re-stake instead</span></button>
        </div>
        <button class="link proto-link" data-proto data-act="skipwait">Skip the 28-hour wait (prototype only)</button>`,
      cta: { quiet: true, label: `Nothing to do until ${dayMon(ready)}, ${hm(ready)}`, icon: 'hourglass' },
      ctx: ctxNative(epochs),
    };
  };

  SCR.ready = () => ({
    html: `
      <div class="done"><span class="done-ic">${ic('check')}</span><h1 class="h1">Your ${num(S.native.amt)} NEAR is unlocked.</h1></div>
      <p class="lede">Sign the withdraw to move it to your wallet balance. Then you'll see a fresh quote, and your vault stakes it again with ${D.native.pool}.</p>`,
    cta: { label: `Withdraw ${num(S.native.amt)} NEAR`, act: 'withdraw' },
    ctx: ctxNative(4),
  });

  const RISK = {
    senior: { head: 'Senior: fixed 6.5% a year, paid first', intro: "You're paid before the junior tranche, and you lose money only after it's gone. The rate is fixed. Your deposit can still lose money.", items: [
      ['A fast crash.', "If NEAR fell 80% in one move during a term, senior lenders would lose 14–21% on loans at 20–40% LTV. If the loans had drifted to 30–65% LTV, they'd lose 42–46%. Since 2020, NEAR's worst falls were 52% in 3 days and 70% in 35 days."],
      ['Slow sales.', 'Staked NEAR takes about 28 hours to free up. In our one out-of-sample crash test with 5-day sales at a 10% discount, senior was paid in full in 94.3% of weeks.'],
      ['Crashes hit everything at once.', 'Losses come when the rest of crypto is also down.'],
      ['Slow exits.', "Withdrawals are paid only from cash the pool isn't lending. When cash is short, the first to withdraw is paid first; v1 has no queue."],
      ['Unsold auctions are handled by hand.', 'If nobody bids, the team sells the vault\'s NEAR and books the USDC back to the pool. You rely on them to do it.'],
      ['New code.', "Ankora hasn't been audited, and in v1 its deployer can still upgrade the pool contract."],
    ], ack: 'I understand senior deposits can lose money in a fast NEAR crash and may not be withdrawable until borrowers repay.' },
    junior: { head: 'Junior: first loss', intro: 'You take losses before anyone else. In a bad enough crash you lose everything you deposit.', items: [
      ['Return:', "whatever the pool earns after the senior's 6.5% and Ankora's fee. Replays of 2021–22 on these plans gave 18.1–21.0% a year in-sample. The same pricing rule fitted only on 2023–26 prices gave 11.3% on 2021–22, with losses in 4.8% of weeks."],
      ['Use matters.', 'In our model the junior earns about 16% when 90% of the pool is lent and nothing at about 61%.'],
      ['Locked in.', "Your deposit is locked for 36 days from your latest junior deposit, and adding more restarts the lock. After that, you can't withdraw if it would leave junior cover below 15% of loans outstanding."],
      ['Who it\'s for:', 'holders already long NEAR, whose junior losses land in crashes they already carry.'],
    ], ack: 'I understand I can lose my entire junior deposit.' },
  };
  SCR.lend = () => {
    const L = S.lend;
    const amt = parseFloat(String(L.amt).replace(/,/g, '')) || 0;
    const jr = L.tranche === 'junior';
    const R = RISK[L.tranche];
    const ok = amt > 0 && amt <= S.usdc && L.ack;
    const pos = S.positions.length ? `<div class="positions">${S.positions.map(p => `<div class="pos"><b>${p.tranche === 'senior' ? 'Senior' : 'Junior'}</b><span class="num">${money(p.amt)} USDC</span><small>${p.tranche === 'senior' ? 'In the pool · fixed 6.5% a year' : `In the pool · locked until ${dateLong(p.at + 36 * DAY)}`}</small></div>`).join('')}</div>` : '';
    return {
      title: 'Lend USDC',
      html: `
        ${pos}
        <h1 class="h1">Lend dollars, and choose how much of the loss you take.</h1>
        <div class="opts" role="radiogroup" aria-label="Tranche">
          <div class="opt ${!jr ? 'on' : ''}"><button class="opt-btn" role="radio" aria-checked="${!jr}" data-act="tranche" data-t="senior"><span class="opt-radio"></span><span class="opt-txt"><b>Senior <em class="num">fixed 6.5%</em></b><small>Paid before the junior earns anything.</small></span></button></div>
          <div class="opt ${jr ? 'on' : ''}"><button class="opt-btn" role="radio" aria-checked="${jr}" data-act="tranche" data-t="junior"><span class="opt-radio"></span><span class="opt-txt"><b>Junior <em>first loss</em></b><small>Keeps what's left after the senior. Can lose all of it.</small></span></button></div>
        </div>
        <section class="risktext">
          <h2 class="h2">${R.head}</h2>
          <p class="lede">${R.intro}</p>
          <ul class="facts tight">${R.items.map(([b, t]) => `<li>${ic('alert')}<span><b>${b}</b> ${t}</span></li>`).join('')}</ul>
          <button class="check" role="checkbox" aria-checked="${L.ack}" data-act="ack"><span class="check-box">${ic('check')}</span><span>${R.ack}</span></button>
        </section>
        <div class="field">
          <label for="amt">Amount</label>
          <div class="field-row"><input id="amt" class="input num" inputmode="decimal" placeholder="0.00" value="${L.amt}" autocomplete="off"><span class="field-u">USDC</span><button class="chip sm" data-act="max">Max</button></div>
          <small>You have <span class="num">${money(S.usdc)}</span> USDC on NEAR. Deposits go straight into the pool.</small>
        </div>`,
      cta: { label: amt > 0 ? `Deposit ${money(amt)} to ${jr ? 'Junior' : 'Senior'}` : `Deposit to ${jr ? 'Junior' : 'Senior'}`, act: 'deposit', disabled: !ok, hint: !L.ack ? 'Tick the box above first.' : '' },
      ctx: ctxLend(),
    };
  };

  SCR.lent = () => {
    const p = S.positions[S.positions.length - 1];
    return {
      html: `
        <div class="done"><span class="done-ic">${ic('check')}</span><h1 class="h1"><span class="num">${money(p.amt)}</span> USDC is in ${p.tranche === 'senior' ? 'Senior' : 'Junior'}.</h1></div>
        <p class="lede">${p.tranche === 'senior' ? "It's in the pool and earns a fixed 6.5% a year. Withdrawals are paid from cash the pool isn't lending." : `It's in the pool. It's locked until ${dateLong(p.at + 36 * DAY)}, 36 days from this deposit.`}</p>`,
      cta: { label: 'Done', go: 'lend' },
      ctx: ctxLend(),
    };
  };

  SCR.risk = () => ({
    title: 'Risk',
    html: `
      <h1 class="h1">How you can lose money here.</h1>
      <p class="lede">A wick can't liquidate your NEAR: the price is read only when a term starts or renews. In our backtest 60–68% of liquidations were wicks. Everything below can still go wrong.</p>
      <section class="risk"><h2 class="h2">Borrowers</h2><ul class="facts">
        <li>${ic('alert')}<span>If your LTV is above 50% at a renewal and you don't pay down within 72 hours plus the 48-hour grace period, your vault is auctioned. The auction price can fall to half the vault's value before someone bids.</span></li>
        <li>${ic('alert')}<span>In a crash you'll be asked to act about as often as on Rhea: 53–81% of passive borrowers in our 2021–22 replay, against 55–85% liquidated on Rhea. Each request came with five days to respond.</span></li>
        <li>${ic('alert')}<span>Repaying early doesn't refund the current term's interest. After NEAR's issuance cut, staking covers less of your interest.</span></li>
      </ul></section>
      <section class="risk"><h2 class="h2">Lenders</h2><ul class="facts">
        <li>${ic('alert')}<span>Senior and junior can both lose money in a fast NEAR crash, and the junior can lose all of it.</span></li>
        <li>${ic('alert')}<span>Collateral sells slowly: unstaking takes about 28 hours. Every loan is backed by the same asset, so they all fall together. Since 2020 NEAR has fallen 52% in 3 days and 70% in 35 days.</span></li>
        <li>${ic('alert')}<span>Getting your money out depends on borrowers repaying, and v1 pays withdrawals first come, first served. If an auction gets no bid, the team sells the NEAR by hand.</span></li>
      </ul></section>
      <section class="risk"><h2 class="h2">Everyone</h2><ul class="facts">
        <li>${ic('alert')}<span>Ankora is new code and hasn't been audited. In v1 the pool contract can still be upgraded by its deployer, and the team switches to the stressed terms by hand. The loan vaults can't be upgraded.</span></li>
        <li>${ic('alert')}<span>Prices come from Pyth. If the feed is stale or unsure, loans don't start. Rates come from a model fitted on six years of data; fitted on the calm years alone, it underpriced the 2021–22 crash.</span></li>
        <li>${ic('alert')}<span>We haven't tested whether enough lenders, junior buyers or auction bidders will show up.</span></li>
      </ul></section>
      <p class="demo">Ankora is not affiliated with Spectra Finance.</p>`,
    ctx: `<div class="ctx-block"><h3 class="h3">When Rhea is the better choice</h3><ul class="facts tight">
      <li>${ic('info')}<span>You want more than 50% LTV, or a loan with no end date.</span></li>
      <li>${ic('info')}<span>You hold a liquid staking token. Ankora v1 takes plain NEAR only.</span></li>
      <li>${ic('info')}<span>You want the lowest rate in an ordinary year: at Rhea's 7.8% median, Ankora costs 2 to 3.5 points more.</span></li></ul></div>`,
  });

  // ---------- context panels (desktop) ----------
  function ctxHowItRuns(q) {
    const due = S.now + q.band.days * DAY;
    return `<div class="ctx-block">
      <h3 class="h3">How this loan runs</h3>
      ${sigTerm({ start: S.now, due, now: S.now, band: q.band, mode: 'quote' })}
      ${sigPath([
        { t: S.now, title: 'Today', sub: `You get ${money(q.receive)} USDC. Interest for the first term is paid upfront.`, kind: 'done', icon: 'receive' },
        { t: due, title: 'Price check', sub: 'LTV 50% or lower: renews automatically. Next term\'s interest is added to the debt.', kind: 'next', icon: 'clock' },
        { title: 'Only if LTV is above 50%', sub: '72 h to top up or repay, then 48 h grace (no late fee), then a 24 h auction you can still stop by repaying. Surplus is yours to claim.', kind: 'future', stamp: 'IF', when: '72 h + 48 h', icon: 'alert' },
      ], { line: q.band.key })}
    </div>`;
  }
  function ctxLoan(L) {
    const items = L.history.map(h => ({ ...h, title: h.title || h.text, kind: h.kind || 'done', icon: h.kind === 'danger' ? 'alert' : 'ok' }));
    items.push({ t: L.due, title: 'Price check', sub: L.autoRenew ? 'Renews automatically if LTV is 50% or lower.' : 'Auto-renew is off: repay by this time.', kind: 'next', icon: 'clock' });
    return `<div class="ctx-block"><h3 class="h3">This loan</h3>${sigPath(items, { line: L.band.key })}</div>
      <div class="ctx-block"><h3 class="h3">During a term</h3><p class="ctx-p">No price check, no margin call, no liquidation. Staking rewards accrue to your vault. You can repay any time; this term's interest isn't refunded.</p></div>`;
  }
  function ctxNotice(n) {
    return `<div class="ctx-block"><h3 class="h3">Why you're seeing this</h3><p class="ctx-p">The renewal check on ${dateLong(S.notice.at)} read NEAR at $${S.notice.price.toFixed(2)}. This is the only kind of moment Ankora reads a price. Nothing was sold.</p></div>
      <div class="ctx-block"><h3 class="h3">Lower LTV, longer next term</h3>
      <table class="tbl"><thead><tr><th>Pay down to</th><th>Pay</th><th>Next term</th></tr></thead><tbody>
      ${MENU.slice().reverse().map(b => `<tr><td>${b.ltv}%</td><td class="num">${money(n.cash(b.ltv), 0)} USDC</td><td>${b.days} days · ≈ ${b.rate}%</td></tr>`).join('')}
      </tbody></table></div>`;
  }
  function ctxNative(epochs = -1) {
    return `<div class="ctx-block"><h3 class="h3">Why unstake?</h3><p class="ctx-p">NEAR staking pools have no transfer method: stake can only leave through unstake, which takes 4 epochs (about 28 hours). Rhea needs the same step. The difference: Ankora re-stakes with the validator you already chose, any pool on lockup-whitelist.near.</p></div>
      <div class="ctx-block"><h3 class="h3">What it costs</h3><p class="ctx-p">About 28 hours without rewards: 0.017% of the stake. Your validator is without that stake for 4–5 epochs.</p></div>`;
  }
  function ctxLend() {
    return `<div class="ctx-block"><h3 class="h3">Who takes a loss first</h3>
      <div class="tranche" role="img" aria-label="Senior paid first; junior, at least 15 percent cover, takes losses first">
        <div class="tr-s"><b>Senior</b><span>fixed 6.5%, paid first</span></div>
        <div class="tr-j"><b>Junior ≥ 15%</b><span>first loss</span></div>
      </div>
      <p class="ctx-p">If an auction can't cover a debt, the pool takes the vault and the loss hits the junior first, then the senior pro rata. Interest is earned into the share price day by day.</p></div>
      <div class="ctx-block"><h3 class="h3">Withdrawals</h3><p class="ctx-p">Paid only from cash the pool isn't lending. When cash is short, the first to withdraw is paid first; v1 has no queue.</p></div>`;
  }

  // ---------- render ----------
  let lastCta = '';
  function setCta(label) {
    const el = $('#dock .cta-label');
    if (!el) return;
    if (S.dir === 'c' && label !== lastCta && !reduceMotion) {
      el.innerHTML = [...label].map((ch, i) => `<span class="flap" style="animation-delay:${Math.min(i * 8, 240)}ms">${ch === ' ' ? '&nbsp;' : ch}</span>`).join('');
    } else el.textContent = label;
    el.setAttribute('aria-label', label);
    lastCta = label;
  }
  function renderDock(cta) {
    const dock = $('#dock');
    if (!cta) { dock.innerHTML = ''; dock.className = 'dock empty'; lastCta = ''; return; }
    if (cta.quiet) {
      dock.className = 'dock quiet';
      dock.innerHTML = `<div class="cta cta-quiet">${ic(cta.icon || 'clock', 'cta-ic')}<span class="cta-label"></span></div>`;
      setCta(cta.label);
      return;
    }
    dock.className = 'dock';
    const attrs = cta.go ? `data-go="${cta.go}"` : `data-act="${cta.act}"`;
    dock.innerHTML = `${cta.hint ? `<p class="cta-hint">${cta.hint}</p>` : ''}<button class="cta ${cta.danger ? 'is-danger' : ''}" ${attrs} ${cta.disabled ? 'disabled' : ''}>
      <span class="cta-pic" aria-hidden="true">${ic('arrowR')}</span><span class="cta-label"></span></button>`;
    setCta(cta.label);
  }

  function renderNav(id) {
    const sec = ['lend', 'lent'].includes(id) ? 'lend' : id === 'risk' ? 'risk' : 'home';
    const items = [['home', 'Borrow', 'note'], ['lend', 'Lend', 'bank'], ['risk', 'Risk', 'shield']];
    const html = items.map(([r, l, i]) => `<button class="nav-i ${sec === r ? 'on' : ''}" data-go="${r}" ${sec === r ? 'aria-current="page"' : ''}>${ic(i)}<span>${l}</span></button>`).join('');
    $('#tabbar').innerHTML = html;
    $('#rail-nav').innerHTML = html;
    $('#rail-foot').innerHTML = `<button class="wallet-chip" data-act="toast" data-msg="Wallet Selector would open here."><span class="dot"></span><span>${D.wallet}</span></button><p class="demo">Prototype · demo data</p>`;
    document.querySelectorAll('.brand').forEach(b => (b.innerHTML = brandHtml()));
  }

  function render() {
    const id = screenId();
    const scr = (SCR[id] || SCR.borrow)();
    const head = scr.back ? `<div class="subhead"><button class="back" data-go="${scr.back}" aria-label="Back">${ic('arrowL')}</button><span>${scr.title || ''}</span></div>` : '';
    $('#screen').innerHTML = head + scr.html;
    $('#screen').dataset.screen = id;
    document.documentElement.dataset.screen = id;
    $('#context').innerHTML = scr.ctx || '';
    $('#context').hidden = !scr.ctx;
    const bandKey = (S.loan && S.loan.band.key) || (bandFor(S.ltv) || MENU[0]).key;
    document.documentElement.style.setProperty('--line-cur', `var(--${bandKey})`);
    renderDock(scr.cta);
    renderNav(id);
    S.fresh = {};
    if (T.run && T.run.end === id) finishFlow();
    renderHud();
    const range = $('#ltv');
    if (range) bindRange(range);
    const amt = $('#amt');
    if (amt) amt.addEventListener('input', () => { S.lend.amt = amt.value; const pos = amt.selectionStart; refreshLend(); const a2 = $('#amt'); a2.focus(); a2.setSelectionRange(pos, pos); });
  }
  function refreshLend() { render(); }

  function bindRange(range) {
    const paint = () => range.style.setProperty('--v', ((range.value - range.min) / (range.max - range.min)) * 100 + '%');
    paint();
    range.addEventListener('input', () => { S.ltv = +range.value; paint(); updateReview(); });
    range.addEventListener('change', () => tap(range));
  }

  function transition(fn) {
    if (!document.startViewTransition || reduceMotion || S.dir === 'c' || EMBED || document.visibilityState !== 'visible') { fn(); window.scrollTo(0, 0); return; }
    let ran = false;
    const run = () => { if (ran) return; ran = true; fn(); window.scrollTo(0, 0); };
    const vt = document.startViewTransition(run);
    // Safety net: if the transition stalls (seen once after first load), render anyway.
    setTimeout(() => { if (!ran) { if (vt.skipTransition) vt.skipTransition(); run(); } }, 150);
    // A newer transition skips the older one; that's expected, not an error.
    [vt.ready, vt.finished, vt.updateCallbackDone].forEach(p => p && p.catch(e => { if (!e || e.name !== 'AbortError') console.error(e); }));
  }

  // ---------- wallet sheet ----------
  function openWallet({ txs, onApprove }) {
    const layer = $('#sheet-layer');
    layer.hidden = false;
    layer.innerHTML = `<div class="backdrop" data-act="walletReject"></div>
      <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="w-t">
        <div class="sheet-grip" aria-hidden="true"></div>
        <div class="w-head"><span class="w-logo">${ic('wallet')}</span><div><b id="w-t">Wallet</b><small>${D.wallet} · mock</small></div></div>
        <p class="w-ask">ankora.utpal.dev asks you to approve ${txs.length} transaction${txs.length > 1 ? 's' : ''} in one batch.</p>
        <ol class="w-txs">${txs.map(t => `<li><span>${t[0]}</span><small>${t[1]}</small></li>`).join('')}</ol>
        <div class="w-btns"><button class="w-btn" data-act="walletReject">Reject</button><button class="w-btn w-ok" data-act="walletApprove">Approve</button></div>
      </div>`;
    requestAnimationFrame(() => layer.classList.add('open'));
    W.onApprove = onApprove;
    setTimeout(() => { const b = layer.querySelector('.w-ok'); if (b) b.focus(); }, 50);
  }
  const W = { onApprove: null };
  function closeWallet(cb) {
    const layer = $('#sheet-layer');
    layer.classList.remove('open');
    setTimeout(() => { layer.hidden = true; layer.innerHTML = ''; cb && cb(); }, reduceMotion ? 0 : 200);
  }

  // ---------- actions ----------
  const A = {
    col: el => { S.col = el.dataset.col; transition(render); },
    band: el => { S.ltv = +el.dataset.ltv; const r = $('#ltv'); if (r) { r.value = S.ltv; r.dispatchEvent(new Event('input')); } },
    borrow: () => {
      const q = reviewNumbers();
      const isN = S.col === 'native';
      const txs = isN
        ? [['Update NEAR price', 'Pyth via Hermes, max 60 s old'], [`Create your vault and deposit ${num(q.amt + RESERVE, 1)} NEAR`, '1.5 NEAR held back for storage'], [`Vault stakes ${num(q.amt)} NEAR`, `with ${D.native.pool}`], [`Borrow ${money(q.debt)} USDC`, `${q.band.days}-day term · ${q.band.rate}% · ${money(q.interest)} upfront`]]
        : [['Update NEAR price', 'Pyth via Hermes, max 60 s old'], [`Create your vault and deposit ${num(q.amt + RESERVE, 1)} NEAR`, '1.5 NEAR held back for storage'], [`Vault stakes ${num(q.amt)} NEAR`, `with ${D.native.pool}`], [`Borrow ${money(q.debt)} USDC`, `${q.band.days} days · about ${q.band.rate}% · ${money(q.interest)} upfront`]];
      openWallet({
        txs, onApprove: () => {
          S.loan = mkLoan(S.col, S.ltv, S.now, S.price);
          if (isN) S.native.stage = 'none';
          S.loan.history[0].sub += ` · staked with ${D.native.pool}`;
          S.usdc = r2(S.usdc + q.receive);
          S.last = { received: q.receive };
          go('borrowed');
        },
      });
    },
    autorenew: () => {
      const on = !S.loan.autoRenew;
      openWallet({
        txs: [[on ? 'Switch auto-renew on' : 'Switch auto-renew off', on ? 'the loan renews at each price check if LTV is 50% or lower' : `repay by ${dateLong(S.loan.due)}, ${hm(S.loan.due)} UTC`]],
        onApprove: () => { S.loan.autoRenew = on; render(); if (T.run && T.run.endAct === 'autorenew') finishFlow(); },
      });
    },
    part: () => { S.repayPart = true; go('repay'); },
    choice: el => { if (el.getAttribute('aria-disabled') === 'true') return; S.choice = el.dataset.c; render(); },
    target: el => { S.cashTarget = +el.dataset.t; render(); },
    paydown: () => {
      const n = noticeNums(); const amt = n.cash(S.cashTarget);
      openWallet({
        txs: [[`Repay ${money(amt)} USDC`, `part of the debt · brings LTV to ${S.cashTarget}%`], ['Renew', `${bandFor(S.cashTarget).days} days at about ${bandFor(S.cashTarget).rate}%`]],
        onApprove: () => renewAfter(amt, 0, `Repaid ${money(amt, 0)} USDC. Renewed.`),
      });
    },
    repayAll: () => { S.repayPart = false; A.repay(); },
    ramt: el => { const v = el.dataset.v; S.repayPart = v !== 'full'; S.repayAmt = v; render(); },
    repay: () => {
      const L = S.loan;
      const { amt, part } = S.auction ? { amt: owed(L), part: false } : repayAmount();
      openWallet({
        txs: [[`Repay ${money(amt)} USDC`, part ? 'partial repay · the loan stays open' : (S.auction ? 'closes the loan and ends the auction' : 'closes the loan')], ...(part ? [] : [['Vault account control returns to you', 'your stake stays with your validator']])],
        onApprove: () => {
          S.usdc = r2(S.usdc - amt);
          if (part) {
            L.debt = r2(L.debt - amt);
            L.history.push({ t: S.now, kind: 'done', text: `Paid down ${money(amt)} USDC`, sub: `debt now ${money(L.debt)} USDC` });
            S.repayPart = false;
            S.last = { partial: true, title: `Paid down ${money(amt)} USDC.`, sub: `Your debt is now ${money(L.debt)} USDC. The next price check is still ${dateLong(L.due)}.` };
            go('paid');
            return;
          }
          const hist = L.history.concat([{ t: S.now, kind: 'done', title: 'Repaid', stamp: 'REPAID', sub: `${money(amt)} USDC` }]).map(h => ({ ...h, title: h.title || h.text }));
          S.last = { sub: `${S.auction ? 'The auction has ended. ' : ''}You now own the vault ${VAULT_ID}, with ${num(L.collAmt)} NEAR still staked with ${D.native.pool}. Add your own key to it, or unstake when you're ready.`, history: hist };
          S.loan = null; S.notice = null; S.auction = null;
          go('repaid');
        },
      });
    },
    claim: () => openWallet({
      txs: [[`Claim ${money(S.claim)} USDC`, 'auction surplus from your vault']],
      onApprove: () => { S.usdc = r2(S.usdc + S.claim); S.last = { claimed: S.claim }; S.claim = 0; go('claimed'); },
    }),
    unstake: () => openWallet({
      txs: [[`Unstake ${num(S.native.amt)} NEAR`, `on ${D.native.pool} · about 28 h`]],
      onApprove: () => { S.native.stage = 'unstaking'; S.native.startedAt = S.now; go('home'); },
    }),
    skipwait: () => { S.native.stage = 'ready'; transition(render); },
    withdraw: () => openWallet({
      txs: [[`Withdraw ${num(S.native.amt)} NEAR`, `from ${D.native.pool} to your wallet balance`]],
      onApprove: () => { S.native.stage = 'none'; S.hasNative = false; S.hasWallet = true; S.walletAmt = S.native.amt; S.col = 'wallet'; S.ltv = 30; go('review'); },
    }),
    tranche: el => { if (S.lend.tranche !== el.dataset.t) S.lend.ack = false; S.lend.tranche = el.dataset.t; render(); },
    ack: () => { S.lend.ack = !S.lend.ack; render(); },
    max: () => { S.lend.amt = money(S.usdc).replace(/,/g, ''); render(); },
    deposit: () => {
      const amt = parseFloat(String(S.lend.amt).replace(/,/g, '')) || 0;
      const t = S.lend.tranche;
      openWallet({
        txs: [[`Deposit ${money(amt)} USDC`, `to Ankora ${t === 'senior' ? 'Senior · fixed 6.5%' : 'Junior · first loss · locked 36 days'}`]],
        onApprove: () => { S.positions.push({ tranche: t, amt, at: S.now }); S.usdc = r2(S.usdc - amt); S.lend = { tranche: 'senior', amt: '', ack: false }; go('lent'); },
      });
    },
    walletApprove: el => {
      el.textContent = 'Signing…'; el.disabled = true;
      const fn = W.onApprove; W.onApprove = null;
      setTimeout(() => closeWallet(fn), reduceMotion ? 50 : 650);
    },
    walletReject: () => { W.onApprove = null; closeWallet(); },
    toast: el => toast(el.dataset.msg),
  };

  function renewAfter(payUsd, soldUnits, title) {
    const L = S.loan;
    L.debt = r2(L.debt - payUsd);
    if (soldUnits) L.collAmt = r2(L.collAmt - soldUnits); else S.usdc = r2(S.usdc - payUsd);
    const ltv = loanLtv(L, S.notice.price);
    const band = bandFor(Math.round(ltv * 10) / 10) || MENU[2];
    const add = interestFor(L.debt, band);
    L.history.push({ t: S.notice.at, kind: 'danger', stamp: stampDate(S.notice.at), text: 'Price check: paydown needed', sub: `LTV ${pct(loanLtv({ ...L, debt: L.debt + payUsd, collAmt: L.collAmt + soldUnits }, S.notice.price))}` });
    L.history.push({ t: S.now, kind: 'done', text: soldUnits ? `Vault sold ≈ ${num(soldUnits, 0)} ${symOf(L.col)}` : `Paid down ${money(payUsd, 0)} USDC`, sub: `Renewed · ${band.days} days · ${money(add)} interest added to debt` });
    L.debt = r2(L.debt + add);
    L.band = band; L.start = S.notice.at; L.due = S.notice.at + band.days * DAY;
    S.notice = null;
    S.last = { title, sub: `${band.days} days at about ${band.rate}%. The next term's interest (${money(add)} USDC) was added to your debt, which is now ${money(L.debt)} USDC.` };
    go('paid');
  }

  let toastT;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.classList.add('on');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2600);
  }

  // ---------- HUD (prototype controls, not part of the product) ----------
  function renderHud() {
    const hud = $('#hud');
    if (!hud) return;
    if (EMBED) { hud.remove(); return; }
    const f = T.run;
    const res = T.done ? `<span class="hud-res ${T.done.pass === false ? 'miss' : ''}">${T.done.name}: <b>${T.done.n} tap${T.done.n === 1 ? '' : 's'}</b>${T.done.target != null ? ` · target ${T.done.target === 0 ? '0' : '≤ ' + T.done.target}` : ''}</span>` : '';
    hud.innerHTML = `
      <span class="hud-t">Ankora prototype</span>
      <div class="hud-seg" role="radiogroup" aria-label="Direction">${Object.entries(DIRS).map(([k, v]) => `<button role="radio" aria-checked="${S.dir === k}" data-hud="dir" data-v="${k}">${k.toUpperCase()} ${v}</button>`).join('')}</div>
      <label class="hud-l">Palette <select data-hud="pal">${[['petrol', 'Ink · Petrol · Lemon'], ['day', 'Day · Petrol · Lemon'], ['cobalt', 'Ink · Cobalt · Tangerine'], ['off', 'Original']].map(([k, v]) => `<option value="${k}" ${S.pal === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label class="hud-l">State <select data-hud="scen">${Object.entries(SCEN).map(([k, v]) => `<option value="${k}" ${S.scen === k ? 'selected' : ''}>${v.label}</option>`).join('')}</select></label>
      <label class="hud-l">Run a flow <select data-hud="flow"><option value="">Choose…</option>${FLOWS.map(x => `<option value="${x.id}" ${f && f.id === x.id ? 'selected' : ''}>${x.name}</option>`).join('')}</select></label>
      <span class="hud-n" aria-live="polite">${f ? `${f.name}: <b>${T.n}</b> tap${T.n === 1 ? '' : 's'}` : `Taps: <b>${T.n}</b>`}</span>
      ${res}
      <a class="hud-a" href="../index.html">All directions</a>`;
    document.documentElement.style.setProperty('--hud-h', hud.offsetHeight + 'px');
  }
  function startFlow(id) {
    const f = FLOWS.find(x => x.id === id);
    if (!f) return;
    loadScenario(f.scen);
    T.run = f; T.n = 0; T.done = null;
    if (cur() !== f.start) location.hash = '#/' + f.start; else render();
    if (f.end && screenId() === f.end) finishFlow();
  }
  function finishFlow() {
    const f = T.run; if (!f) return;
    T.done = { name: f.name, n: T.n, target: f.target, pass: f.target == null ? null : T.n <= f.target };
    T.run = null;
    renderHud();
  }

  // ---------- events ----------
  document.addEventListener('click', e => {
    const hb = e.target.closest('[data-hud]');
    if (hb) {
      if (hb.dataset.hud === 'dir') {
        S.dir = hb.dataset.v;
        document.documentElement.dataset.dir = S.dir;
        const u = new URL(location.href); u.searchParams.set('d', S.dir); history.replaceState(null, '', u);
        render();
      }
      return;
    }
    const el = e.target.closest('[data-go],[data-act]');
    if (!el || el.disabled) return;
    if (el.closest('#app') || el.closest('#sheet-layer')) {
      if (!(el.dataset.act === 'toast' || el.dataset.act === 'walletReject')) tap(el);
    }
    if (el.dataset.go) { e.preventDefault(); go(el.dataset.go); return; }
    const fn = A[el.dataset.act];
    if (fn) fn(el);
  });
  document.addEventListener('change', e => {
    const s = e.target.closest('[data-hud]');
    if (!s) return;
    if (s.dataset.hud === 'pal') { S.pal = s.value; setPal(); const u = new URL(location.href); u.searchParams.set('p', S.pal); history.replaceState(null, '', u); render(); return; }
    if (s.dataset.hud === 'scen') { loadScenario(s.value); T.n = 0; T.run = null; T.done = null; location.hash = '#/home'; render(); }
    if (s.dataset.hud === 'flow') { if (s.value) startFlow(s.value); }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('#sheet-layer').hidden) A.walletReject();
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.brand')) { e.preventDefault(); go('home'); }
  });
  window.addEventListener('hashchange', () => transition(render));
  window.addEventListener('resize', () => { const h = $('#hud'); if (h && h.isConnected) document.documentElement.style.setProperty('--hud-h', h.offsetHeight + 'px'); });

  function setPal() { const h = document.documentElement; if (S.pal && S.pal !== 'off') h.dataset.pal = S.pal; else h.removeAttribute('data-pal'); }

  // ---------- boot ----------
  const dir0 = ['a', 'b', 'c'].includes(qs.get('d')) ? qs.get('d') : 'b';
  loadScenario(qs.get('s') || 'fresh', dir0);
  if (qs.get('ltv')) S.ltv = clamp(+qs.get('ltv'), 10, 50);
  if (qs.get('col') === 'native') S.col = 'native';
  document.documentElement.dataset.dir = S.dir;
  setPal();
  if (EMBED) document.documentElement.classList.add('embed');
  render();
})();
