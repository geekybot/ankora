// Ankora app: live screens over the testnet pool. Numbers come from the chain through chain.ts.
// Every screen is rebuilt from chain state after each transaction, never from local callbacks.
// Messages: one status banner at the top of the screen carries every transaction from "confirm in your
// wallet" to its result; errors stay until dismissed and always say what happened to the user's funds.
import "./styles/base.css";
import "./styles/directions.css";
import "./styles/palettes.css";
import "./styles/zinc.css";
import "./styles/one.css";
import "./app.css";
import * as C from "./chain.ts";
import { quoteBorrow, maxPrincipal, paydownToRenew, NEAR as YOCTO, type PlanName } from "../../client/src/quote.ts";

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const U = 1_000_000n; // USDC has 6 decimals
const usdc = (v: bigint | string, dp = 2) => (Number(BigInt(v)) / 1e6).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
const near = (y: bigint | string, dp = 2) => (Number(BigInt(y) / 10n ** 18n) / 1e6).toLocaleString("en-US", { maximumFractionDigits: dp });
const toYocto = (s: string): bigint => { const [i, f = ""] = s.trim().replace(/,/g, "").split("."); return BigInt(i || "0") * YOCTO + BigInt((f + "0".repeat(24)).slice(0, 24) || "0"); };
const toUsdc = (s: string): bigint => { const [i, f = ""] = s.trim().replace(/,/g, "").split("."); return BigInt(i || "0") * U + BigInt((f + "000000").slice(0, 6) || "0"); };
const safe = <T,>(f: () => T, d: T) => { try { return f(); } catch { return d; } };
const when = (secs: number) => new Date(secs * 1000).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";
const left = (secs: number) => { const d = secs - C.nowSecs(); if (d <= 0) return "now"; const h = Math.floor(d / 3600); return h >= 48 ? `${Math.floor(h / 24)} days` : `${h} h ${Math.floor((d % 3600) / 60)} m`; };
const planLabel = (p: string) => `${p.slice(1)}% plan`;
const VAULT_EXTRA = 24n * YOCTO / 100n; // 1.5 NEAR reserve minus ~1.26 NEAR of vault storage, measured on the local sandbox
const GAS_SPARE = YOCTO / 10n;
const ASSET = `${import.meta.env.BASE_URL}assets/`;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

type Status = { kind: "pending" | "ok" | "error" | "info"; title: string; body?: string; hash?: string; act?: { label: string; act: string } };
const S = {
  plans: [] as C.PlanView[], price: null as C.PriceRead | null, all: [] as C.LoanView[], vaults: [] as C.MyVault[],
  nearBal: 0n, usdcBal: 0n, lender: null as Awaited<ReturnType<typeof C.pool.lender>>, ledger: null as Awaited<ReturnType<typeof C.pool.ledger>> | null, claimable: 0n,
  tab: "borrow" as "borrow" | "lend" | "auctions", details: false, stake: "10", plan: "P30" as PlanName, validator: C.CFG.validator, tranche: "senior" as "senior" | "junior", ack: false, lendAmt: "", busy: false, error: "",
};
const mine = () => S.all.filter((l) => l.borrower === C.account && l.state !== "Closed");

// ---------- data ----------
async function load(soft = false) {
  if (!C.configured()) return render();
  try {
    const [plans, price, ledger, all] = await Promise.all([C.pool.plans(), C.readPrice(), C.pool.ledger(), C.allLoans()]);
    Object.assign(S, { plans, price, ledger, all, error: "" });
    if (C.account) {
      const [nb, ub, lender, cl, vaults] = await Promise.all([C.nearBalance(C.account), C.usdcBalance(C.account), C.pool.lender(C.account), C.pool.claimable(C.account), C.myVaults(all, C.account)]);
      Object.assign(S, { nearBal: nb, usdcBal: ub, lender, claimable: BigInt(cl ?? "0"), vaults });
    }
  } catch (e) { S.error = human((e as Error).message ?? ""); }
  if (soft) softRender(); else render();
}

// ---------- messages: what happened, in words, and what to do next ----------
const ORACLE: Record<string, string> = {
  Stale: "the price was over 90 seconds old", WideConfidence: "the price feed was too unsure of the price",
  Breaker: "NEAR moved more than 3% from its one-hour average, so new loans are paused", Missing: "there was no price",
  ExpoMismatch: "the price feed was malformed", Invalid: "the price was invalid",
};
const CANCELLED: Record<string, string> = {
  ...ORACLE,
  "LTV above plan cap": "the price fell between your quote and the transaction, so the loan was over the plan's limit",
  "vault creation failed": "the vault account couldn't be created", "validator rejected or stake failed": "the validator didn't accept the stake",
  "staked amount below estimate": "the validator staked less than expected", "payout failed": "the USDC payout bounced",
};
/** A raw wallet, RPC or contract error, as one sentence a borrower or lender can act on. */
function human(raw: string): string {
  const m = raw.replace(/\\"/g, '"');
  const rules: [RegExp, string | ((x: RegExpExecArray) => string)][] = [
    [/reject|cancel|denied|closed|User (?:didn't|did not)/i, "You cancelled in the wallet."],
    [/Connect a wallet/i, "Connect a wallet first."],
    [/attach at least 5 NEAR/, "A loan needs at least 5 NEAR attached: 1.5 NEAR of it pays for your vault account. Bring more NEAR."],
    [/attach at least 250 Tgas/, "The wallet sent too little gas. Try again; if your wallet lets you set gas, allow 300 Tgas."],
    [/NotEnoughBalance|Exceeded the account balance|LackBalanceForState|not enough balance to cover/i, "This wallet doesn't have enough NEAR for that plus gas. Keep about 0.1 NEAR spare."],
    [/junior cover or free cash too low/, "The pool doesn't have enough free cash or First-loss cover for this loan right now. Try a smaller loan."],
    [/minimum deposit is 10 USDC/, "The minimum deposit is 10 USDC."],
    [/\bLocked\b/, "First-loss deposits stay locked for 36 days after your latest First-loss deposit."],
    [/CoverBreach/, "Withdrawing that would leave First-loss cover under 15% of loans. Withdraw less, or wait for borrowers to repay."],
    [/InsufficientCash/, "The pool's free cash is lent out right now. Withdraw less, or wait for borrowers to repay."],
    [/JuniorWiped/, "First-loss deposits were used up by losses, so there's nothing left to withdraw from First-loss."],
    [/NoShares|no position|more shares than you hold/, "You don't have that much deposited in this tranche."],
    [/OverRepay/, "That's more than the loan owes."],
    [/LoanClosed/, "This loan is already closed."],
    [/NotInAuction|AuctionOver/, "This loan isn't at auction any more."],
    [/BidTooLow/, "The bid was below the auction price. Try again at the current price."],
    [/oracle unavailable \((\w+)\)/, (x) => `The renewal check can't run: ${ORACLE[x[1]!] ?? "the price is unavailable"}. Try again in a minute.`],
    [/only the borrower/, "Only the borrower of this loan can do that."],
    [/nothing to claim/, "There's nothing to claim."],
    [/whitelist/i, "That validator isn't on the lockup whitelist. Pick a validator from the whitelist."],
    [/doesn't have enough balance|The account doesn't have enough balance|Insufficient balance/i, "Not enough test USDC. Get 1,000 from the faucet first."],
    [/not registered|storage_deposit/i, "Your account isn't registered with test USDC yet. Use the faucet once: it registers you."],
    [/Failed to fetch|NetworkError|timeout|ECONN|Load failed|503|502/i, "Couldn't reach NEAR testnet. Check your connection and try again."],
  ];
  for (const [re, out] of rules) { const x = re.exec(m); if (x) return typeof out === "string" ? out : out(x); }
  const clean = m.replace(/^.*?(?:Smart contract panicked: |panic_msg":")/, "").replace(/["}\]]+$/, "").slice(0, 160);
  return clean ? `The chain refused it: ${clean}.` : "Something went wrong and nothing was sent.";
}
type Msg = { doing: string; done: string; doneBody?: string; refused?: string };
/** What the chain said about a transaction, as a status. */
function judge(o: C.Outcome, a: C.Action, msg: Msg): Status {
  if (!o.ok) return { kind: "error", title: human(o.failure ?? ""), body: "Nothing moved from your wallet.", hash: o.hash };
  const cancelled = o.logs.map((l) => /borrow \d+ cancelled: (.+)/.exec(l)?.[1]).find(Boolean);
  if (a.methodName === "borrow" && (o.value === false || cancelled)) {
    const why = cancelled ?? "the pool refused it";
    if (/vault handed to the borrower/.test(why)) return { kind: "error", title: "The validator wouldn't take the stake, so the loan didn't start.", body: "Your vault and its NEAR are yours: see the vault card below.", hash: o.hash };
    return { kind: "error", title: `The loan didn't start: ${CANCELLED[why] ?? why}.`, body: "Your NEAR was refunded to your wallet.", hash: o.hash };
  }
  if (a.methodName === "ft_transfer_call" && (o.value === "0" || o.value === 0)) {
    const why = msg.refused ?? o.failures.map(human).find(Boolean) ?? "The pool refused it.";
    return { kind: "error", title: why, body: "Your USDC was returned to your wallet.", hash: o.hash };
  }
  return { kind: "ok", title: msg.done, body: msg.doneBody, hash: o.hash };
}
async function run(a: C.Action, msg: Msg): Promise<Status> {
  S.busy = true; render();
  const id = toasts.push({ kind: "pending", title: "Confirm in your wallet", body: `${msg.doing} Nothing is sent until you approve it there.` });
  let st: Status;
  try { st = judge(await C.send(a), a, msg); }
  catch (e) {
    const t = human((e as Error).message ?? ""), unsent = /cancelled|Couldn't reach|Connect a wallet/.test(t);
    st = { kind: /cancelled/.test(t) ? "info" : "error", title: t, body: unsent ? "Nothing was sent." : "Nothing changed in your wallet." };
  }
  toasts.update(id, st);
  S.busy = false; await load();
  setTimeout(() => load(true), 3000);
  return st;
}

// ---------- toasts: a stack at the bottom right (bottom centre on phones) ----------
/** One toast per transaction: it opens as "Confirm in your wallet" and turns into the result in place.
 *  Success and info leave on their own; errors stay until dismissed. Hover pauses the timers. */
const EXPLORER = (h: string) => `https://testnet.nearblocks.io/txns/${h}`;
const toasts = (() => {
  const host = () => $("#toasts");
  let seq = 0; const timers = new Map<number, number>();
  const ICON: Record<Status["kind"], string> = {
    pending: `<span class="st-spin" aria-hidden="true"></span>`,
    ok: `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`,
    error: `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.01"/></svg>`,
    info: `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.5v.01"/></svg>`,
  };
  const body = (t: Status) => {
    const link = t.hash && !C.DEV_LOCAL ? `<a class="st-link" href="${EXPLORER(t.hash)}" target="_blank" rel="noopener">View on NearBlocks</a>` : "";
    const extra = t.act ? `<button class="st-link" data-act="${t.act.act}">${esc(t.act.label)}</button>` : "";
    const x = t.kind === "pending" ? "" : `<button class="st-x" data-toast-x aria-label="Dismiss"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg></button>`;
    return `${ICON[t.kind]}<div class="st-txt"><b>${esc(t.title)}</b>${t.body ? `<span>${esc(t.body)}</span>` : ""}${link || extra ? `<span class="st-links">${link}${extra}</span>` : ""}</div>${x}`;
  };
  const life = (k: Status["kind"]) => (k === "ok" ? 5200 : k === "info" ? 6500 : 0);
  const arm = (id: number, el: HTMLElement, k: Status["kind"]) => {
    clearTimeout(timers.get(id)); el.onmouseenter = el.onmouseleave = null;
    const ms = life(k); if (!ms) return;
    timers.set(id, window.setTimeout(() => dismiss(id), ms));
    el.onmouseenter = () => clearTimeout(timers.get(id));
    el.onmouseleave = () => timers.set(id, window.setTimeout(() => dismiss(id), 2000));
  };
  function dismiss(id: number) {
    const el = host()?.querySelector<HTMLElement>(`[data-toast="${id}"]`); if (!el || el.classList.contains("is-out")) return;
    clearTimeout(timers.get(id)); el.classList.add("is-out");
    setTimeout(() => el.remove(), 320);
  }
  function push(t: Status): number {
    const id = ++seq, el = document.createElement("div");
    el.className = `toast st-${t.kind}`; el.dataset.toast = String(id);
    el.setAttribute("role", t.kind === "error" ? "alert" : "status");
    el.innerHTML = body(t); host()?.prepend(el);
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("is-in")));
    const live = [...(host()?.querySelectorAll<HTMLElement>(".toast:not(.is-out)") ?? [])];
    live.slice(3).forEach((x) => dismiss(Number(x.dataset.toast))); // at most 3 on screen
    arm(id, el, t.kind);
    return id;
  }
  function update(id: number, t: Status) {
    const el = host()?.querySelector<HTMLElement>(`[data-toast="${id}"]`); if (!el) { push(t); return; }
    el.className = `toast st-${t.kind} is-in is-morph`; el.setAttribute("role", t.kind === "error" ? "alert" : "status");
    el.innerHTML = body(t); setTimeout(() => el.classList.remove("is-morph"), 260);
    arm(id, el, t.kind);
  }
  document.addEventListener("click", (e) => { const x = (e.target as HTMLElement).closest("[data-toast-x]"); if (x) dismiss(Number(x.closest<HTMLElement>("[data-toast]")!.dataset.toast)); });
  addEventListener("keydown", (e) => { if (e.key === "Escape") { const top = host()?.querySelector<HTMLElement>(".toast:not(.st-pending):not(.is-out)"); if (top) dismiss(Number(top.dataset.toast)); } });
  return { push, update, dismiss };
})();
/** Small, passing confirmations (demo controls). */
const toast = (m: string) => toasts.push({ kind: "info", title: m });

// ---------- one page: pool stats, the action card (Borrow · Lend · Auctions), your account ----------
type Tab = "borrow" | "lend" | "auctions";
const TABS: [Tab, string][] = [["borrow", "Borrow"], ["lend", "Lend"], ["auctions", "Auctions"]];
const tabFromHash = (): Tab => { const h = location.hash.replace(/^#\/?/, ""); return h === "lend" || h === "auctions" ? h : "borrow"; };
const auctions = () => S.all.filter((l) => l.state === "Auction");
const ICON = {
  near: () => `<img class="coin" src="${ASSET}near-coin.svg" alt="">`,
  usdc: () => `<img class="coin" src="${ASSET}usdc.svg" alt="">`,
  down: `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M6 13l6 6 6-6"/></svg>`,
  chev: `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 10l4 4 4-4"/></svg>`,
};

/** The one button of a panel. Its label names the next step, or what blocks it (no hint paragraph). */
function btn(label: string, act: string, ok: boolean, tone = "") {
  return `<button class="cta ${tone}" data-act="${act}" ${ok && !S.busy ? "" : "disabled"}><span class="cta-label">${S.busy ? "Confirm in your wallet…" : label}</span></button>`;
}
const connectBtn = () => `<button class="cta" data-act="connect"><span class="cta-label">Connect wallet</span></button>`;

function stats() {
  const L = S.ledger, p = S.price;
  const age = p && Number.isFinite(p.ageSecs) ? `${p.ageSecs} s ago` : "–";
  const stale = !!p && (!p.ok || !p.fresh);
  const cell = (k: string, v: string, sub = "", cls = "") => `<div class="stat ${cls}"><span class="stat-k">${k}</span><span class="stat-v num">${v}</span>${sub ? `<span class="stat-s">${sub}</span>` : ""}</div>`;
  return `<div class="stats-row">
    ${cell("Available to borrow", L ? `${usdc(L.cash, 0)}` : "–", "USDC")}
    ${cell("Lent out", L ? `${usdc(L.outstanding, 0)}` : "–", "USDC")}
    ${cell("Utilisation", L ? `${(L.utilisation_bps / 100).toFixed(1)}%` : "–", L ? `<span class="util"><i style="width:${Math.min(100, L.utilisation_bps / 100)}%"></i></span>` : "")}
    ${cell("NEAR price", p ? `$${p.price.toFixed(3)}` : "–", `<span class="live ${stale ? "is-stale" : ""}"><i></i>${stale ? "stale · " : ""}${age}</span>`)}
  </div>`;
}


function quoteNow() {
  const p = S.price, stake = safe(() => toYocto(S.stake), 0n), plan = S.plans.find((x) => x.plan === S.plan);
  if (!p?.ok || p.priceRaw === undefined || !plan || stake <= 0n) return null;
  const menu = S.plans.map((x) => ({ plan: x.plan, ltvCapBps: x.ltv_cap_bps, termSecs: x.term_secs, rateBps: x.rate_bps }));
  const principal = maxPrincipal(stake, { price: p.priceRaw, expo: p.expo! }, plan.ltv_cap_bps) * C.QUOTE_CAP_SHARE_BPS / 10_000n;
  return { plan, stake, principal, q: quoteBorrow({ stakeYocto: stake, principal, plan: S.plan, price: { price: p.priceRaw, expo: p.expo! }, menu }) };
}

function borrowPanel() {
  const p = S.price, Q = quoteNow(), q = Q?.q, plan = Q?.plan;
  const days = plan ? Math.round(plan.term_secs / 86400) : 0;
  const due = plan ? C.nowSecs() + plan.term_secs : 0;
  const amt = safe(() => toYocto(S.stake), 0n);
  const button = !C.account ? connectBtn()
    : !p ? btn("Reading the price…", "noop", false)
    : !p.fresh ? btn("Refresh the price", "refresh", true)
    : amt <= 0n ? btn("Enter an amount", "noop", false)
    : !q?.ok ? btn(q?.reason ?? "Can't quote this", "noop", false)
    : S.nearBal < q.attachedYocto + GAS_SPARE ? btn("Not enough NEAR", "noop", false)
    : btn(`Borrow ${usdc(q.payout)} USDC`, "borrow", true);
  return `
    <div class="box">
      <div class="box-top"><label for="stake">You stake</label>${C.account ? `<button class="bal" data-act="stake-max">Balance <span class="num">${near(S.nearBal)}</span> · Max</button>` : ""}</div>
      <div class="box-in">${ICON.near()}<input id="stake" class="input num" inputmode="decimal" value="${esc(S.stake)}" autocomplete="off" placeholder="0"><span class="unit">NEAR</span></div>
    </div>
    <div class="plans" role="radiogroup" aria-label="Plan">
      ${S.plans.map((x) => `<button class="plan" role="radio" aria-checked="${x.plan === S.plan}" data-act="plan" data-v="${x.plan}"><b class="num">${x.plan.slice(1)}%</b><span>${Math.round(x.term_secs / 86400)} days</span><small class="num">${(x.rate_bps / 100).toFixed(1)}% APR</small></button>`).join("")}
    </div>
    <div class="flow" aria-hidden="true">${ICON.down}</div>
    <div class="box out">
      <div class="box-top"><span>You get</span></div>
      <div class="box-in">${ICON.usdc()}<output class="out-v num">${q?.ok ? usdc(q.payout) : "0.00"}</output><span class="unit">USDC</span></div>
    </div>
    ${q?.ok ? `<dl class="terms">
      <div><dt>Interest, paid upfront</dt><dd class="num">${usdc(q.termInterest)} USDC</dd></div>
      <div><dt>Next price check</dt><dd>${when(due).replace(" UTC", "")} <small>UTC</small></dd></div>
      <div><dt>To close the loan</dt><dd class="num">${usdc(q.payout + q.termInterest)} USDC</dd></div>
    </dl>` : ""}
    ${button}
    <p class="fine">Your NEAR stays staked. No price check for ${days || "7 to 30"} days.</p>
    <details class="more" ${S.details ? "open" : ""} data-details><summary>Details ${ICON.chev}</summary>
      <dl class="terms sm">
        ${q?.ok ? `<div><dt>NEAR sent</dt><dd class="num">${near(q.attachedYocto)} NEAR</dd></div><div><dt>Staked as collateral</dt><dd class="num">≈ ${near(Q!.stake + VAULT_EXTRA, 1)} NEAR</dd></div><div><dt>Vault storage</dt><dd>Rest of the 1.5 NEAR reserve</dd></div>` : ""}
        <div><dt>Validator</dt><dd><input id="val" class="val num" value="${esc(S.validator)}" autocomplete="off" spellcheck="false" aria-label="Validator account"></dd></div>
        <div><dt>Above 50% LTV at renewal</dt><dd>72 h notice, 48 h grace, then a 24 h auction</dd></div>
      </dl>
      ${C.account && q?.ok && S.nearBal < q.attachedYocto + GAS_SPARE ? `<p class="fine">Need testnet NEAR? <a href="https://near-faucet.io/" target="_blank" rel="noopener">near-faucet.io</a></p>` : ""}
    </details>`;
}

function lendPanel() {
  const jr = S.tranche === "junior";
  const amt = safe(() => toUsdc(S.lendAmt || "0"), 0n);
  const risk = jr ? "Takes losses first and earns what's left. Can lose everything. Locked 36 days." : "Paid first. Loses money only after every First-loss deposit is gone.";
  const ack = jr ? "I can lose my whole First-loss deposit" : "Fixed can lose money in a fast crash";
  const button = !C.account ? connectBtn()
    : amt === 0n ? btn("Enter an amount", "noop", false)
    : amt < 10n * U ? btn("Minimum 10 USDC", "noop", false)
    : amt > S.usdcBal ? btn("Not enough USDC", "noop", false)
    : !S.ack ? btn("Confirm the risk above", "noop", false)
    : btn(`Deposit ${usdc(amt)} USDC`, "deposit", true);
  return `
    <div class="layers" role="radiogroup" aria-label="Layer">
      <button class="layer" role="radio" aria-checked="${!jr}" data-act="tranche" data-v="senior"><b>Fixed</b><span class="num">6.5% APR</span></button>
      <button class="layer" role="radio" aria-checked="${jr}" data-act="tranche" data-v="junior"><b>First-loss</b><span>Variable</span></button>
    </div>
    <p class="risk ${jr ? "is-warn" : ""}">${risk}</p>
    <div class="box">
      <div class="box-top"><label for="lamt">You deposit</label>${C.account ? `<button class="bal" data-act="max">Balance <span class="num">${usdc(S.usdcBal)}</span> · Max</button>` : ""}</div>
      <div class="box-in">${ICON.usdc()}<input id="lamt" class="input num" inputmode="decimal" placeholder="0" value="${esc(S.lendAmt)}" autocomplete="off"><span class="unit">USDC</span></div>
    </div>
    <button class="ack" role="checkbox" aria-checked="${S.ack}" data-act="ack"><span class="ack-box"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></span>${ack}</button>
    ${button}
    <p class="fine">${C.account ? `Test USDC only. <button class="inline-link" data-act="faucet" ${S.busy ? "disabled" : ""}>Get 1,000</button>` : "Test USDC only."}</p>`;
}

function auctionsPanel() {
  const list = auctions();
  if (!list.length) return `<div class="empty"><b>No auctions right now</b><span>A loan reaches auction only after 72 h notice and 48 h grace. Its price then falls from 100% to 50% of the vault's value over 24 h.</span></div>`;
  return `<ul class="auc">${list.map((l) => {
    const price = BigInt(l.auction_price), coll = BigInt(l.collateral);
    const can = !!C.account && S.usdcBal >= price;
    return `<li class="auc-i">
      <div class="auc-top"><span class="num">Loan #${l.id}</span><span class="badge st-bad">Ends in <span class="num" data-deadline="${l.deadline}">${left(l.deadline)}</span></span></div>
      <div class="auc-main"><div><span class="k">You get</span><b class="num">${near(coll)} NEAR</b><small>Staked with ${esc(l.validator)}</small></div>
        <div class="r"><span class="k">Price now</span><b class="num">${usdc(price)} USDC</b><small>Falling</small></div></div>
      ${!C.account ? connectBtn() : can ? `<button class="cta" data-act="bid" data-id="${l.id}" data-amt="${price}" ${S.busy ? "disabled" : ""}><span class="cta-label">Buy for ${usdc(price)} USDC</span></button>` : btn("Not enough USDC", "noop", false)}
    </li>`; }).join("")}</ul>
    <p class="fine">You buy the loan's vault: the NEAR stays staked and becomes yours to unstake.</p>`;
}

// ---------- your account ----------
const STATE: Record<string, { label: string; tone: string }> = {
  Active: { label: "Active", tone: "ok" }, Notice: { label: "Pay down", tone: "warn" }, Grace: { label: "Grace", tone: "warn" },
  Auction: { label: "At auction", tone: "bad" }, Defaulted: { label: "Auction ended", tone: "mute" },
};
function repayBtn(l: C.LoanView, amt: bigint, label: string, primary: boolean) {
  if (S.usdcBal < amt) return `<button class="btn btn-2 sm" data-act="faucet" ${S.busy ? "disabled" : ""} title="${esc(label)} needs ${usdc(amt)} USDC">Get test USDC</button>`;
  return `<button class="btn ${primary ? "btn-1" : "btn-2"} sm" data-act="repay" data-id="${l.id}" data-amt="${amt}" ${S.busy ? "disabled" : ""}>${label}</button>`;
}
function loanItem(l: C.LoanView) {
  const p = S.price, debt = BigInt(l.debt), coll = BigInt(l.collateral);
  const ltv = p?.ok ? (Number(debt) / 1e6) / (Number(coll) / 1e24 * p.price) * 100 : 0;
  const pay = p?.ok && p.priceRaw !== undefined ? paydownToRenew(debt, coll, { price: p.priceRaw, expo: p.expo! }) : 0n;
  const st = STATE[l.state] ?? { label: l.state, tone: "mute" };
  const paidDown = (l.state === "Notice" || l.state === "Grace") && pay === 0n && !!p?.ok;
  const overdue = l.deadline > 0 && l.deadline <= C.nowSecs();
  const line: Record<string, string> = {
    Active: `Next price check in`, Notice: paidDown ? "Paid down. Renews at the next check, or" : `Pay ${usdc(pay)} USDC within`,
    Grace: paidDown ? "Paid down. Renew now, or" : `Pay ${usdc(pay)} USDC before the auction, in`, Auction: "At auction. Repay in full to stop it, within", Defaulted: "Auction closed",
  };
  const acts: string[] = [];
  if (paidDown && l.auto_renew) acts.push(`<button class="btn btn-1 sm" data-act="settle" data-id="${l.id}" ${S.busy ? "disabled" : ""}>Renew now</button>`);
  if (!paidDown && (l.state === "Notice" || l.state === "Grace") && pay > 0n) acts.push(repayBtn(l, pay, `Pay ${usdc(pay)}`, true));
  if (l.state !== "Defaulted") acts.push(repayBtn(l, debt, `Repay ${usdc(debt)}`, l.state === "Auction"));
  if (overdue && !paidDown) acts.push(`<button class="btn btn-2 sm" data-act="settle" data-id="${l.id}" ${S.busy ? "disabled" : ""}>Run price check</button>`);
  return `<li class="acct-i tone-${st.tone}">
    <div class="acct-top"><span class="num">Loan #${l.id} · ${l.plan.slice(1)}% plan</span><span class="badge st-${st.tone}">${st.label}</span></div>
    ${l.state === "Defaulted" ? `<div class="acct-main"><b>No buyer</b><span>The auction ended without a bid. Ask the team about recovery.</span></div>`
      : `<div class="acct-main"><b class="num">${usdc(debt)} <small>USDC owed</small></b><span>${line[l.state] ?? ""} ${l.deadline ? `<b class="num" data-deadline="${l.deadline}">${left(l.deadline)}</b>` : ""}</span></div>`}
    <div class="acct-meta num">${near(coll)} NEAR staked · LTV ${ltv ? ltv.toFixed(1) + "%" : "–"} · <button class="inline-link" role="switch" aria-checked="${l.auto_renew}" data-act="autorenew" data-id="${l.id}" data-on="${!l.auto_renew}" ${S.busy ? "disabled" : ""}>Auto-renew ${l.auto_renew ? "on" : "off"}</button></div>
    <div class="acct-acts">${acts.join("")}</div>
  </li>`;
}
function vaultItem(v: C.MyVault) {
  if (v.stakedNow === 0n && v.unstaked === 0n && v.transferable < 10n ** 22n) return "";
  const b = (act: string, label: string, amt = "") => `<button class="btn btn-1 sm" data-act="${act}" data-v="${v.vault}" ${amt ? `data-amt="${amt}"` : ""} ${S.busy ? "disabled" : ""}>${label}</button>`;
  const step = v.stakedNow > 0n ? { n: 1, t: `${near(v.stakedNow)} NEAR staked`, s: "Unstake, then withdraw in about 28 h.", b: b("v-unstake", "Unstake") }
    : v.unstaked > 0n && !v.canWithdraw ? { n: 2, t: `${near(v.unstaked)} NEAR unstaking`, s: "Ready in about 28 h from unstaking.", b: "" }
    : v.unstaked > 0n ? { n: 2, t: `${near(v.unstaked)} NEAR ready`, s: "Withdraw it into the vault.", b: b("v-withdraw", "Withdraw") }
    : { n: 3, t: `${near(v.transferable)} NEAR in the vault`, s: "Send it to your wallet.", b: b("v-transfer", "Send to wallet", String(v.transferable)) };
  return `<li class="acct-i"><div class="acct-top"><span class="num">Vault · loan #${v.loanId}</span><span class="badge st-mute">Step ${step.n} of 3</span></div>
    <div class="steps-bar" aria-hidden="true">${[1, 2, 3].map((i) => `<i class="${i < step.n ? "done" : i === step.n ? "on" : ""}"></i>`).join("")}</div>
    <div class="acct-main"><b class="num">${step.t}</b><span>${step.s}</span></div>${step.b ? `<div class="acct-acts">${step.b}</div>` : ""}</li>`;
}
function account() {
  if (!C.account) return `<div class="acct-empty"><b>Your loans and deposits show here</b><span>Connect a NEAR testnet wallet to borrow or lend.</span>${connectBtn()}</div>`;
  const L = S.ledger, share = (v: string, sh: string) => (BigInt(sh) > 0n ? Number(BigInt(v)) / Number(BigInt(sh)) : 1);
  const sen = S.lender && L ? Number(BigInt(S.lender.senior_shares)) * share(L.senior_value, L.senior_shares) : 0;
  const jun = S.lender && L ? Number(BigInt(S.lender.junior_shares)) * share(L.junior_value, L.junior_shares) : 0;
  const locked = !!S.lender && S.lender.junior_unlocks_at > C.nowSecs();
  const dep = (name: string, val: number, tr: string, sh: string, ok: boolean, sub: string) => `<li class="acct-i"><div class="acct-top"><span>${name}</span><span class="badge ${tr === "junior" ? "st-warn" : "st-ok"}">${tr === "junior" ? "Variable" : "6.5% APR"}</span></div>
    <div class="acct-main"><b class="num">${usdc(BigInt(Math.floor(val)))} <small>USDC</small></b><span>${sub}</span></div>
    <div class="acct-acts"><button class="btn btn-2 sm" data-act="withdraw" data-t="${tr}" data-sh="${sh}" ${ok && !S.busy ? "" : "disabled"}>Withdraw</button></div></li>`;
  const loans = mine().map(loanItem).join(""), vaults = S.vaults.map(vaultItem).join("");
  const deps = (sen ? dep("Fixed", sen, "senior", S.lender!.senior_shares, true, "Paid first") : "") + (jun ? dep("First-loss", jun, "junior", S.lender!.junior_shares, !locked, locked ? `Locked until ${when(S.lender!.junior_unlocks_at)}` : "Unlocked") : "");
  const claim = S.claimable > 0n ? `<li class="acct-i tone-ok"><div class="acct-main"><b class="num">${usdc(S.claimable)} <small>USDC</small></b><span>Auction surplus, yours to claim</span></div><div class="acct-acts"><button class="btn btn-1 sm" data-act="claim" ${S.busy ? "disabled" : ""}>Claim</button></div></li>` : "";
  const sec = (h: string, body: string) => body ? `<section class="acct-sec"><h3 class="h3">${h}</h3><ul>${body}</ul></section>` : "";
  const nothing = !loans && !vaults && !deps && !claim;
  return `<div class="wallet-row"><div><span class="k">NEAR</span><b class="num">${near(S.nearBal)}</b></div><div><span class="k">USDC</span><b class="num">${usdc(S.usdcBal)}</b></div><button class="btn btn-2 sm" data-act="faucet" ${S.busy ? "disabled" : ""}>Get test USDC</button></div>
    ${sec("Claim", claim)}${sec("Loans", loans)}${sec("Vaults", vaults)}${sec("Deposits", deps)}
    ${nothing ? `<div class="acct-empty sm"><span>No loans or deposits yet. Use the card to start one.</span></div>` : ""}${demoPanel()}`;
}

let keeper: Awaited<ReturnType<typeof C.keeperStatus>> = null;
const last = new WeakMap<HTMLElement, string>();
function put(el: HTMLElement, html: string) { if (last.get(el) !== html) { el.innerHTML = html; last.set(el, html); } }
/** True while the user is pressing, hovering a control, or typing: background refreshes wait. */
let pressed = false;
const busyHand = () => pressed || !!document.querySelector("#app [data-act]:hover, #app a:hover") || (document.activeElement as HTMLElement)?.tagName === "INPUT";
let pending = false;
function softRender() { if (busyHand()) { pending = true; return; } pending = false; render(); }
addEventListener("pointerdown", () => { pressed = true; }, true);
addEventListener("pointerup", () => { pressed = false; if (pending) setTimeout(softRender, 250); }, true);
document.addEventListener("pointerout", () => { if (pending) setTimeout(softRender, 250); });
function render() {
  put($("#keeper"), keeper ? `<span class="badge ${keeper.ok ? "st-ok" : "st-bad"}">Price relay ${keeper.ok ? "live" : "lagging"}</span>` : "");
  put($("#wallet"), C.account ? `<span class="dot"></span><span>${esc(C.account)}</span>` : "Connect wallet");
  $("#wallet").classList.toggle("is-out", !C.account);
  $("#wallet").setAttribute("aria-label", C.account ? `Signed in as ${C.account}. Disconnect` : "Connect a NEAR wallet");
  if (!C.configured()) { put($("#screen"), `<div class="empty"><b>The testnet pool isn't configured.</b><span>Set VITE_POOL and VITE_RELAY in app/.env.local.</span></div>`); return; }
  const err = S.error ? `<div class="status st-error" role="alert"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.01"/></svg><div class="st-txt"><b>Couldn't read the pool. ${esc(S.error)}</b><span class="st-links"><button class="st-link" data-act="reload">Try again</button></span></div></div>` : "";
  put($("#stats"), stats());
  const panel = S.tab === "lend" ? lendPanel() : S.tab === "auctions" ? auctionsPanel() : borrowPanel();
  // The card and its tab bar are built once; only their state changes, so the pill can slide and nothing flickers.
  if (!$("#card")) $("#screen").innerHTML = `<div id="err"></div><section class="card-x" id="card"><div class="tabs" role="tablist" aria-label="Action"><span class="tabs-pill" aria-hidden="true"></span>${TABS.map(([k, l]) => `<button class="tab" role="tab" id="tab-${k}" aria-controls="panel" data-act="tab" data-v="${k}">${l}<b class="tab-n num" hidden></b></button>`).join("")}</div><div class="panel" id="panel" role="tabpanel"></div></section>`;
  put($("#err"), err);
  const bar = $(".tabs"), n = auctions().length;
  bar.style.setProperty("--i", String(TABS.findIndex(([k]) => k === S.tab)));
  TABS.forEach(([k]) => { const t = $(`#tab-${k}`); t.setAttribute("aria-selected", String(S.tab === k)); t.tabIndex = S.tab === k ? 0 : -1; });
  const badge = $("#tab-auctions .tab-n"); badge.hidden = !n; badge.textContent = String(n);
  const pnl = $("#panel"); pnl.setAttribute("aria-labelledby", `tab-${S.tab}`);
  if (pnl.dataset.tab !== S.tab) { pnl.dataset.tab = S.tab; pnl.classList.remove("is-swap"); void pnl.offsetWidth; pnl.classList.add("is-swap"); }
  put(pnl, panel);
  put($("#context"), `<h2 class="acct-h">Your account</h2>${account()}`);
}

/** Local sandbox only (DEV_LOCAL + KEEPER_CONTROL): crash the price and walk a loan through notice, grace and auction. */
function demoPanel() {
  if (!C.DEV_LOCAL || !C.KEEPER_CONTROL) return "";
  const next = nextDeadline(), dis = S.busy ? "disabled" : "";
  return `<section class="acct-sec demo"><h3 class="h3">Demo controls · local only</h3><div class="acct-acts">
    <button class="btn btn-2 sm danger" data-act="dev-crash" ${dis}>Crash NEAR to $1</button><button class="btn btn-2 sm" data-act="dev-live" ${dis}>Live price</button>
    <button class="btn btn-2 sm" data-act="dev-next" ${dis || (next ? "" : "disabled")}>${next ? `Skip to loan #${next.id}'s deadline` : "Skip to next deadline"}</button></div></section>`;
}
function nextDeadline() {
  return S.all.filter((l) => l.state !== "Closed" && l.state !== "Defaulted" && l.deadline > 0).sort((a, b) => a.deadline - b.deadline)[0];
}

// ---------- events ----------
document.addEventListener("click", async (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-act]"); if (!el || (el as HTMLButtonElement).disabled) return;
  const a = el.dataset.act!, id = Number(el.dataset.id);
  if (a === "connect") return void C.connect();
  if (a === "noop") return;
  if (a === "tab") { const t = el.dataset.v as Tab; if (t !== S.tab) history.replaceState(null, "", `#/${t === "borrow" ? "" : t}`); S.tab = t; return render(); }
  if (a === "reload") { S.error = ""; return load(); }
  if (a === "dev-crash" || a === "dev-live" || a === "dev-next") {
    S.busy = true; render();
    try {
      if (a === "dev-crash") { await C.devControl("/price?usd=1"); toast("NEAR is held at $1 on the sandbox. Nothing happens until the next deadline."); }
      else if (a === "dev-live") { await C.devControl("/price"); toast("Back to the live NEAR price."); }
      else {
        const l = nextDeadline();
        if (l) {
          await C.syncClock();
          const secs = Math.max(0, l.deadline - C.nowSecs()) + 5;
          await C.devControl(`/advance?secs=${secs}`);
          await C.devControl(`/settle?id=${l.id}`);
          toast(`Moved ${left(C.nowSecs() + secs)} ahead and settled loan #${l.id}.`);
        }
      }
    } catch (err) { toast(`Demo control failed: ${(err as Error).message}`); }
    S.busy = false; await load(); return;
  }
  if (a === "plan") { S.plan = el.dataset.v as PlanName; return render(); }
  if (a === "stake-max") { const m = S.nearBal - VAULT_EXTRA - GAS_SPARE * 3n; S.stake = m > 0n ? (Number(m / 10n ** 20n) / 1e4).toFixed(2) : "0"; return render(); }
  if (a === "refresh") { S.price = await C.readPrice().catch(() => S.price); return render(); }
  if (a === "tranche") { if (S.tranche !== el.dataset.v) S.ack = false; S.tranche = el.dataset.v as "senior" | "junior"; return render(); }
  if (a === "ack") { S.ack = !S.ack; return render(); }
  if (a === "max") { S.lendAmt = (Number(S.usdcBal) / 1e6).toFixed(2); return render(); }
  if (a === "faucet") return run(C.faucet(C.account!, 1_000n * U), { doing: "Minting 1,000 test USDC to your wallet.", done: "1,000 test USDC is in your wallet." });
  if (a === "claim") return run(C.act.claim(), { doing: `Claiming ${usdc(S.claimable)} USDC.`, done: `${usdc(S.claimable)} USDC is in your wallet.` });
  if (a === "settle") return run(C.act.settle(id), { doing: `Running loan #${id}'s price check.`, done: "Price check done.", doneBody: "Your account shows the loan's new state." });
  if (a === "autorenew") { const on = el.dataset.on === "true"; return run(C.act.setAutoRenew(id, on), { doing: `Turning auto-renew ${on ? "on" : "off"} for loan #${id}.`, done: on ? "Auto-renew is on." : "Auto-renew is off.", doneBody: on ? undefined : "Repay by the term's end, or a 48 h grace period starts, then the auction." }); }
  if (a === "repay") {
    const amt = BigInt(el.dataset.amt!), l = S.all.find((x) => x.id === id), full = !!l && amt >= BigInt(l.debt);
    return run(C.act.repay(id, amt), { doing: `Repaying ${usdc(amt)} USDC on loan #${id}.`, done: full ? `Loan #${id} is repaid.` : `Paid down ${usdc(amt)} USDC.`,
      doneBody: full ? "Your vault is yours again: unstake it under Vaults." : "Your LTV is back to 50% or lower." });
  }
  if (a === "bid") { const amt = BigInt(el.dataset.amt!); return run(C.act.bid(id, amt), { doing: `Buying loan #${id}'s vault for ${usdc(amt)} USDC.`, done: `You bought loan #${id}'s vault.`, doneBody: "It's under Vaults: unstake the NEAR to take it out.", refused: "Someone else bought it first, or the auction ended." }); }
  if (a === "withdraw") {
    const t = el.dataset.t as "senior" | "junior";
    return run(C.act.withdraw(t, BigInt(el.dataset.sh!)), { doing: `Withdrawing your ${t === "senior" ? "Fixed" : "First-loss"} deposit.`, done: "Withdrawn. The USDC is in your wallet." });
  }
  if (a === "deposit") {
    const amt = toUsdc(S.lendAmt), name = S.tranche === "senior" ? "Fixed" : "First-loss";
    const r = await run(C.act.deposit(S.tranche, amt), { doing: `Depositing ${usdc(amt)} USDC into ${name}.`, done: `Deposited ${usdc(amt)} USDC into ${name}.`, doneBody: S.tranche === "junior" ? "Locked for 36 days." : undefined });
    if (r.kind === "ok") { S.lendAmt = ""; S.ack = false; render(); }
    return r;
  }
  if (a === "v-unstake") return run(C.vault(el.dataset.v!).unstakeAll(), { doing: "Unstaking the NEAR in your vault.", done: "Unstaking started.", doneBody: "Withdraw in about 28 h." });
  if (a === "v-withdraw") return run(C.vault(el.dataset.v!).withdrawAll(), { doing: "Withdrawing NEAR into your vault.", done: "Withdrawn into your vault.", doneBody: "Last step: send it to your wallet." });
  if (a === "v-transfer") return run(C.vault(el.dataset.v!).transfer(C.account!, BigInt(el.dataset.amt!)), { doing: "Sending NEAR from your vault to your wallet.", done: "The NEAR is in your wallet." });
  if (a === "borrow") {
    S.price = await C.readPrice().catch(() => null); // re-check right before asking the wallet
    if (!S.price?.fresh) { toasts.push({ kind: "info", title: "The price moved since your quote.", body: "Check the new quote, then borrow again. Nothing was sent." }); return render(); }
    const Q = quoteNow();
    if (!Q?.q.ok) { toasts.push({ kind: "error", title: Q?.q.reason ?? "Couldn't quote this loan.", body: "Nothing was sent." }); return render(); }
    return run(C.act.borrow({ validator: S.validator, principal: Q.principal, plan: S.plan, stakeYocto: Q.stake }), { doing: `Borrowing ${usdc(Q.q.payout)} USDC against ${near(Q.stake)} NEAR.`, done: `${usdc(Q.q.payout)} USDC is in your wallet.`, doneBody: "Your NEAR is staked in your loan's vault." });
  }
});
document.addEventListener("toggle", (e) => { const d = e.target as HTMLElement; if (d.matches?.("[data-details]")) S.details = (d as HTMLDetailsElement).open; }, true);
$("#wallet").addEventListener("click", () => (C.account ? C.disconnect() : C.connect()));
document.addEventListener("input", (e) => {
  const t = e.target as HTMLInputElement;
  if (t.id !== "stake" && t.id !== "lamt") return;
  const pos = t.selectionStart;
  if (t.id === "stake") S.stake = t.value; else S.lendAmt = t.value;
  render();
  const n = $<HTMLInputElement>("#" + t.id); n?.focus(); if (pos !== null) n?.setSelectionRange(pos, pos);
});
document.addEventListener("change", (e) => { const t = e.target as HTMLInputElement; if (t.id === "val") { S.validator = t.value.trim(); render(); } });
addEventListener("hashchange", () => { S.tab = tabFromHash(); render(); });
S.tab = tabFromHash();
C.onWallet(load);
if (C.KEEPER_URL) { const k = async () => { keeper = await C.keeperStatus(); softRender(); }; k(); setInterval(k, 30_000); }
// Countdowns tick locally; chain state refreshes every 15 s (never mid-typing).
setInterval(() => document.querySelectorAll<HTMLElement>("[data-deadline]").forEach((n) => (n.textContent = left(Number(n.dataset.deadline)))), 30_000);
setInterval(() => { if (C.configured() && !S.busy) refresh(); }, C.DEV_LOCAL ? 8_000 : 15_000);
let refreshing = false;
async function refresh() {
  if (refreshing) return; refreshing = true;
  try { await load(true); } finally { refreshing = false; }
}
C.restore().then(async () => {
  const outs = await C.outcomesFromUrl().catch(() => []);
  if (outs.length) toasts.push(outs.map((o) => judge(o, { receiverId: "", methodName: "", args: {}, gas: 0n, deposit: 0n }, { doing: "", done: "Done. The chain confirmed it." })).find((s) => s.kind === "error") ?? { kind: "ok", title: "Done. The chain confirmed it.", hash: outs[0]?.hash });
  await load();
});
render();
