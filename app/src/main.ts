// Ankora app: live screens over the testnet pool. Numbers come from the chain through chain.ts.
// Every screen is rebuilt from chain state after each transaction, never from local callbacks.
// Messages: one status banner at the top of the screen carries every transaction from "confirm in your
// wallet" to its result; errors stay until dismissed and always say what happened to the user's funds.
import "./styles/base.css";
import "./styles/directions.css";
import "./styles/palettes.css";
import "./styles/zinc.css";
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
  stake: "10", plan: "P30" as PlanName, validator: C.CFG.validator, tranche: "senior" as "senior" | "junior", ack: false, lendAmt: "", busy: false, error: "",
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
type Msg = { doing: string; done: string; doneBody?: string };
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
    const why = o.failures.map(human).find(Boolean) ?? "The pool refused it.";
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

// ---------- screens ----------
const route = () => (location.hash.replace(/^#\/?/, "") || "home");

function cta(label: string, act: string, opts: { disabled?: boolean; hint?: string; danger?: boolean } = {}) {
  const hint = opts.hint ? `<p class="cta-hint" id="cta-hint">${opts.hint}</p>` : "";
  return `<button class="cta ${opts.danger ? "is-danger" : ""}" data-act="${act}" ${opts.disabled || S.busy ? "disabled" : ""} ${opts.hint ? `aria-describedby="cta-hint"` : ""}><span class="cta-label">${S.busy ? "Waiting for the wallet…" : label}</span></button>${hint}`;
}

function notConfigured() {
  return { html: `<h1 class="h1">The testnet pool isn't deployed yet.</h1>
    <p class="lede">The app is pointed at placeholder accounts. Once the pool and test USDC are deployed, set <code>VITE_POOL</code> and <code>VITE_RELAY</code> in <code>app/.env.local</code> and reload.</p>`, dock: "" };
}

function connectScreen() {
  return { html: `<header class="scr-head"><h1 class="h1 xl">Borrow dollars against your NEAR. A 3am dip can't sell it.</h1>
    <p class="lede">Ankora checks the price when your loan starts and when it renews, and at no other time. If NEAR has fallen too far by renewal, you get five days to pay some back before anything is auctioned.</p></header>
    <ul class="steps-3">
      <li><b>1</b><span>Connect a NEAR testnet wallet with at least 5.1 NEAR.</span></li>
      <li><b>2</b><span>Pick how much NEAR to bring and a plan.</span></li>
      <li><b>3</b><span>Approve once. USDC lands in your wallet; your NEAR stays staked.</span></li>
    </ul>
    <p class="demo">NEAR testnet. Test USDC only. <a class="link inline" href="#/loans">See live loans without a wallet</a></p>`, dock: cta("Connect a NEAR wallet", "connect") };
}

function priceChip() {
  const p = S.price; if (!p) return `<p class="price-chip is-wait"><i></i>Reading the NEAR price…</p>`;
  const age = Number.isFinite(p.ageSecs) ? `${p.ageSecs} s old` : "no price";
  const why = !p.ok ? `The pool can't use this price: ${ORACLE[p.reason ?? ""] ?? p.reason}.` : p.ageSecs > C.QUOTE_MAX_AGE_SECS ? `Over ${C.QUOTE_MAX_AGE_SECS} s old. Refresh before borrowing.` : p.gapBps > C.QUOTE_MAX_GAP_BPS ? "NEAR moved more than 3% from its one-hour average, so new loans are paused." : "";
  return `<p class="price-chip ${why ? "is-stale" : ""}" title="Pyth Pro via Rhea's aggregate oracle, copied by the team's relay${C.DEV_LOCAL ? " into the local sandbox" : " on testnet"}"><i></i><span>NEAR <b class="num">$${p.price.toFixed(3)}</b> · <span class="num">${age}</span>${why ? ` · ${why}` : ""}</span></p>`;
}

function quoteNow() {
  const p = S.price, stake = safe(() => toYocto(S.stake), 0n), plan = S.plans.find((x) => x.plan === S.plan);
  if (!p?.ok || p.priceRaw === undefined || !plan || stake <= 0n) return null;
  const menu = S.plans.map((x) => ({ plan: x.plan, ltvCapBps: x.ltv_cap_bps, termSecs: x.term_secs, rateBps: x.rate_bps }));
  const principal = maxPrincipal(stake, { price: p.priceRaw, expo: p.expo! }, plan.ltv_cap_bps) * C.QUOTE_CAP_SHARE_BPS / 10_000n;
  return { plan, stake, principal, q: quoteBorrow({ stakeYocto: stake, principal, plan: S.plan, price: { price: p.priceRaw, expo: p.expo! }, menu }) };
}

function borrowScreen(title = "Borrow USDC") {
  const p = S.price, Q = quoteNow(), q = Q?.q, plan = Q?.plan;
  const need = q ? q.attachedYocto + GAS_SPARE : 0n;
  const enough = q ? S.nearBal >= need : false;
  const days = plan ? Math.round(plan.term_secs / 86400) : 0;
  const due = plan ? C.nowSecs() + plan.term_secs : 0;
  const shortNear = q?.ok && !enough;
  return {
    html: `
      <header class="scr-head"><h1 class="h1">${title}</h1><p class="lede">Your NEAR stays staked with your validator. The price is read now and at renewal, never in between.</p></header>
      <section class="card-in">
        <div class="amount-top"><label for="stake">NEAR you bring</label><button class="bal" data-act="stake-max" ${S.nearBal > YOCTO * 2n ? "" : "disabled"}>Balance <span class="num">${near(S.nearBal)}</span> NEAR</button></div>
        <div class="field-row big"><img class="coin" src="${ASSET}near-coin.svg" alt=""><input id="stake" class="input num" inputmode="decimal" value="${esc(S.stake)}" autocomplete="off" aria-describedby="stake-help"><span class="field-u">NEAR</span></div>
        <p class="amount-help" id="stake-help">At least 3.5 NEAR to stake, plus 1.5 NEAR held back for your vault account.</p>
        <div class="menu" role="radiogroup" aria-label="Plan">
          ${S.plans.map((x) => `<button class="menu-cell" role="radio" aria-checked="${x.plan === S.plan}" data-act="plan" data-v="${x.plan}"><b>Up to ${x.plan.slice(1)}% LTV</b><span>${Math.round(x.term_secs / 86400)} days</span><small>${(x.rate_bps / 100).toFixed(1)}% a year</small></button>`).join("")}
        </div>
      </section>
      <section class="quote ${q?.ok ? "" : "is-empty"}" aria-live="polite">
        <div class="recv"><span class="recv-k">You receive</span><span class="recv-row"><span class="recv-v num">${q?.ok ? usdc(q.payout) : "–"}</span><span class="recv-u"><img class="coin" src="${ASSET}usdc.svg" alt="">USDC</span></span></div>
        ${q?.ok ? `<dl class="rows">
          <div><dt>Interest, paid upfront</dt><dd><span class="num">${usdc(q.termInterest)}</span> USDC<small>${days} days at ${(plan!.rate_bps / 100).toFixed(1)}% a year, fixed</small></dd></div>
          <div><dt>Next price check</dt><dd>${when(due)}<small>Renews if your LTV is 50% or lower</small></dd></div>
          <div><dt>NEAR you send</dt><dd><span class="num">${near(q.attachedYocto)}</span> NEAR<small>About ${near(Q!.stake + VAULT_EXTRA, 1)} staked; the rest pays vault storage</small></dd></div>
          <div><dt>To repay in full</dt><dd><span class="num">${usdc(q.payout + q.termInterest)}</span> USDC<small>More than you receive: the interest was taken upfront</small></dd></div>
        </dl>` : `<p class="quote-empty">${esc(q?.reason ?? (p?.ok === false ? "The price isn't usable right now, so no quote." : "Enter how much NEAR to bring."))}</p>`}
        ${priceChip()}
      </section>
      ${shortNear ? `<div class="status st-info"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.01"/></svg><div class="st-txt"><b>This wallet has ${near(S.nearBal)} NEAR; this loan sends ${near(q!.attachedYocto)} plus gas.</b><span>Bring less NEAR, or get testnet NEAR from <a href="https://near-faucet.io/" target="_blank" rel="noopener">near-faucet.io</a> or the <a href="https://docs.near.org/getting-started/faucet" target="_blank" rel="noopener">NEAR docs faucet</a>. Lending needs only gas.</span></div></div>` : ""}
      <details class="adv"><summary><span>Validator</span><b>${esc(S.validator)}</b><span class="adv-ch">Change</span></summary>
        <div class="field"><label for="val">Validator account</label><div class="field-row"><input id="val" class="input sm" value="${esc(S.validator)}" autocomplete="off" spellcheck="false"></div>
        <small>Your vault stakes here. It must be on the lockup whitelist (<code>whitelist.f863973.m0</code> on testnet).</small></div></details>`,
    dock: !p ? cta("Reading the price…", "noop", { disabled: true })
      : !p.fresh ? cta("Refresh the price", "refresh", { hint: p.ok ? "The price is too old to quote from. Refreshing takes a second." : undefined })
      : !q?.ok ? cta("Borrow", "noop", { disabled: true, hint: q?.reason ?? "Enter how much NEAR to bring." })
      : cta(`Borrow ${usdc(q.payout)} USDC`, "borrow", { disabled: !enough, hint: enough ? "One approval in your wallet. USDC arrives in a few seconds." : "Not enough NEAR in this wallet for this loan." }),
  };
}

const STATE: Record<string, { label: string; tone: string }> = {
  Active: { label: "Active", tone: "ok" }, Notice: { label: "Notice: pay down", tone: "warn" }, Grace: { label: "Grace period", tone: "warn" },
  Auction: { label: "At auction", tone: "bad" }, Defaulted: { label: "Auction closed", tone: "mute" },
};
function repayButton(l: C.LoanView, amt: bigint, label: string, primary = false) {
  if (S.usdcBal >= amt) return `<button class="btn ${primary ? "btn-1" : "btn-2"}" data-act="repay" data-id="${l.id}" data-amt="${amt}" ${S.busy ? "disabled" : ""}>${label}</button>`;
  return `<div class="btn-need"><button class="btn btn-2" data-act="faucet" ${S.busy ? "disabled" : ""}>Get 1,000 test USDC</button><small>${label} needs ${usdc(amt)} USDC; you have ${usdc(S.usdcBal)}.</small></div>`;
}

function loanCard(l: C.LoanView) {
  const p = S.price, debt = BigInt(l.debt), coll = BigInt(l.collateral);
  const value = p?.ok ? Number(coll) / 1e24 * p.price : 0;
  const ltv = value ? (Number(debt) / 1e6) / value * 100 : 0;
  const pay = p?.ok && p.priceRaw !== undefined ? paydownToRenew(debt, coll, { price: p.priceRaw, expo: p.expo! }) : 0n;
  const overdue = l.deadline > 0 && l.deadline <= C.nowSecs();
  const st = STATE[l.state] ?? { label: l.state, tone: "mute" };
  const head: Record<string, string> = {
    Active: "Next price check",
    Notice: `Repay ${usdc(pay)} USDC to renew`,
    Grace: `Repay ${usdc(pay)} USDC before the auction`,
    Auction: "Your vault is at auction",
    Defaulted: "The auction closed",
  };
  const why: Record<string, string> = {
    Active: `Renews ${when(l.deadline || l.expiry)} if your LTV is 50% or lower then.`,
    Notice: "Your LTV was above 50% at renewal. After this notice there's 48 hours' grace on the same terms, then a 24-hour auction. No late fee.",
    Grace: "Last chance before the auction. Paying down renews the loan at 50% LTV.",
    Auction: `The price started at your vault's value and falls to half. It's ${usdc(l.auction_price)} USDC now. Repay in full until a bid lands to stop it.`,
    Defaulted: "Any surplus over the debt is paid to you, or waits to be claimed above.",
  };
  const paidDown = (l.state === "Notice" || l.state === "Grace") && pay === 0n && !!p?.ok;
  if (paidDown) {
    head[l.state] = l.auto_renew ? "Paid down: ready to renew" : "Paid down, but automatic renewal is off";
    why[l.state] = l.auto_renew ? "Your LTV is 50% or lower at today's price. Renew now to start the next term, or the keeper renews it at its next check." : `Your LTV is back under 50%, but the loan only renews with automatic renewal on. Switch it on below, or repay in full by ${when(l.deadline)}.`;
  }
  const actions: string[] = [];
  if (paidDown && l.auto_renew) actions.push(`<button class="btn btn-1" data-act="settle" data-id="${l.id}" ${S.busy ? "disabled" : ""}>Renew now</button>`);
  if ((l.state === "Notice" || l.state === "Grace") && pay > 0n) actions.push(repayButton(l, pay, `Repay ${usdc(pay)} USDC and renew`, true));
  if (l.state === "Auction") actions.push(repayButton(l, debt, `Repay ${usdc(debt)} USDC and stop the auction`, true));
  else if (l.state !== "Defaulted") actions.push(repayButton(l, debt, `Repay ${usdc(debt)} USDC in full`, l.state === "Active" ? false : false));
  if (overdue && !paidDown) actions.push(`<button class="btn btn-2" data-act="settle" data-id="${l.id}" ${S.busy ? "disabled" : ""}>Run the renewal check</button>`);
  return `<section class="loan tone-${st.tone}">
    <header class="loan-top"><span class="loan-id">Loan #${l.id} · ${planLabel(l.plan)}</span><span class="badge st-${st.tone}">${esc(st.label)}</span></header>
    <div class="loan-main"><h2 class="loan-h">${head[l.state] ?? esc(l.state)}</h2>
      ${l.deadline ? `<p class="countdown num" data-deadline="${l.deadline}">${left(l.deadline)}</p>` : ""}
      <p class="lede">${why[l.state] ?? ""}${l.deadline ? " Ankora won't message you yet, so check back by then." : ""}</p></div>
    ${actions.length ? `<div class="actions">${actions.join("")}</div>` : ""}
    <dl class="rows">
      <div><dt>You owe</dt><dd><span class="num">${usdc(debt)}</span> USDC</dd></div>
      <div><dt>Collateral</dt><dd><span class="num">${near(coll)}</span> NEAR<small>Staked with ${esc(l.validator)}</small></dd></div>
      <div><dt>LTV now</dt><dd><span class="num">${ltv ? ltv.toFixed(1) + "%" : "–"}</span><small>Only checked at renewal; limit 50%</small></dd></div>
      <div class="row-switch"><dt id="ar-${l.id}">Renew automatically<small>${l.auto_renew ? "On: the next term starts by itself" : `Off: repay ${usdc(debt)} USDC by ${when(l.expiry)}`}</small></dt><dd><button class="switch" role="switch" aria-checked="${l.auto_renew}" aria-labelledby="ar-${l.id}" data-act="autorenew" data-id="${l.id}" data-on="${!l.auto_renew}" ${S.busy ? "disabled" : ""}><i></i></button></dd></div>
    </dl>
    ${!l.auto_renew ? `<p class="note"><span>If you don't repay by ${when(l.expiry)}, a 48-hour grace period starts straight away, then the auction.</span></p>` : ""}
  </section>`;
}

function vaultCard(v: C.MyVault) {
  // Done: nothing staked, unstaking or left above dust (0.01 NEAR) in the vault. Hide the card instead of offering "Send 0 NEAR".
  if (v.stakedNow === 0n && v.unstaked === 0n && v.transferable < 10n ** 22n) return "";
  const btn = (act: string, label: string, amt = "") => `<button class="btn btn-1" data-act="${act}" data-v="${v.vault}" ${amt ? `data-amt="${amt}"` : ""} ${S.busy ? "disabled" : ""}>${label}</button>`;
  const step = v.stakedNow > 0n
    ? { n: 1, h: `${near(v.stakedNow)} NEAR is still staked in your vault`, t: "Loan #" + v.loanId + " is closed and the vault is yours. Unstake now; you can withdraw after 4 epochs (about 28 hours).", b: btn("v-unstake", "Unstake all") }
    : v.unstaked > 0n && !v.canWithdraw
    ? { n: 2, h: `${near(v.unstaked)} NEAR is unstaking`, t: "The validator releases it about 4 epochs (around 28 hours) after you unstaked. Check back then.", b: "" }
    : v.unstaked > 0n
    ? { n: 2, h: `${near(v.unstaked)} NEAR is ready to withdraw`, t: "Move it from the validator into your vault.", b: btn("v-withdraw", "Withdraw all") }
    : { n: 3, h: `${near(v.transferable)} NEAR is ready to send`, t: "The vault keeps a small reserve for its own storage.", b: btn("v-transfer", `Send ${near(v.transferable)} NEAR to your wallet`, String(v.transferable)) };
  return `<section class="loan tone-mute">
    <header class="loan-top"><span class="loan-id">Vault ${esc(v.vault)}</span><span class="badge st-mute">Step ${step.n} of 3</span></header>
    <div class="steps-bar" aria-hidden="true">${[1, 2, 3].map((i) => `<i class="${i < step.n ? "done" : i === step.n ? "on" : ""}"></i>`).join("")}</div>
    <div class="loan-main"><h2 class="loan-h sm">${step.h}</h2><p class="lede">${step.t}</p></div>
    ${step.b ? `<div class="actions one">${step.b}</div>` : ""}</section>`;
}

function homeScreen() {
  const parts: string[] = [];
  if (S.claimable > 0n) parts.push(`<section class="loan tone-ok"><header class="loan-top"><span class="loan-id">Auction surplus</span><span class="badge st-ok">Ready to claim</span></header><div class="loan-main"><h2 class="loan-h">${usdc(S.claimable)} USDC is yours</h2><p class="lede">The auction closed above your debt. The transfer to ${esc(C.account!)} didn't go through, so it's waiting here.</p></div><div class="actions one"><button class="btn btn-1" data-act="claim" ${S.busy ? "disabled" : ""}>Claim ${usdc(S.claimable)} USDC</button></div></section>`);
  parts.push(...mine().map(loanCard), ...S.vaults.map(vaultCard).filter(Boolean));
  const b = borrowScreen(parts.length ? "Borrow more" : "Borrow USDC");
  return { html: `${parts.length ? `<header class="scr-head"><h1 class="h1">Your loans</h1></header>${parts.join("")}<hr class="sep">` : ""}${b.html}`, dock: b.dock };
}

function loansScreen() {
  const live = S.all.filter((l) => l.state !== "Closed");
  const rows = live.map((l) => { const st = STATE[l.state] ?? { label: l.state, tone: "mute" }; return `<tr><td class="num">#${l.id}</td><td>${planLabel(l.plan)}</td><td><span class="badge st-${st.tone}">${esc(st.label)}</span></td><td class="num r">${usdc(l.debt, 0)}</td><td class="num r">${near(l.collateral, 1)}</td><td class="num">${l.deadline ? left(l.deadline) : "–"}</td></tr>`; }).join("");
  return { html: `<header class="scr-head"><h1 class="h1">Live loans</h1><p class="lede">Read straight from the pool on ${C.DEV_LOCAL ? "the local sandbox" : "NEAR testnet"}. No wallet needed.</p></header>
    ${live.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Loan</th><th>Plan</th><th>State</th><th class="r">Owes (USDC)</th><th class="r">NEAR</th><th>Next deadline</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty"><b>No open loans yet.</b><span>The first borrower's loan will appear here, live from the chain.</span><a class="link" href="#/">Borrow USDC</a></div>`}`, dock: "" };
}

function lendScreen() {
  const jr = S.tranche === "junior", L = S.ledger;
  const amt = safe(() => toUsdc(S.lendAmt || "0"), 0n);
  const share = (v: string, sh: string) => (BigInt(sh) > 0n ? Number(BigInt(v)) / Number(BigInt(sh)) : 1);
  const mySenior = S.lender && L ? Number(BigInt(S.lender.senior_shares)) * share(L.senior_value, L.senior_shares) : 0;
  const myJunior = S.lender && L ? Number(BigInt(S.lender.junior_shares)) * share(L.junior_value, L.junior_shares) : 0;
  const locked = !!S.lender && S.lender.junior_unlocks_at > C.nowSecs();
  const risk = jr
    ? { h: "First-loss takes losses first, and can lose everything", t: "You take losses before Fixed 6.5% lenders. In a bad enough crash you lose everything you deposit. Locked for 36 days from your latest First-loss deposit; adding more restarts the lock.", ack: "I understand I can lose my entire First-loss deposit." }
    : { h: "Fixed 6.5% is paid first, and can still lose money", t: "Interest is paid before First-loss earns anything. You lose money only after every First-loss deposit is gone. Withdrawals are paid only from cash the pool isn't lending.", ack: "I understand Fixed 6.5% deposits can lose money in a fast NEAR crash and may not be withdrawable until borrowers repay." };
  const hint = !S.lendAmt.trim() || amt === 0n ? "Enter an amount." : amt < 10n * U ? "The minimum deposit is 10 USDC." : amt > S.usdcBal ? `You have ${usdc(S.usdcBal)} test USDC. Get more from the faucet above.` : !S.ack ? "Tick the box above to confirm the risk." : "One approval in your wallet.";
  const ok = amt >= 10n * U && amt <= S.usdcBal && S.ack;
  const pos = (name: string, sub: string, val: number, tranche: string, shares: string, canW: boolean, why = "") => `<div class="pos"><div class="pos-l"><b>${name}</b><small>${sub}</small></div><span class="num pos-v">${usdc(BigInt(Math.floor(val)))} USDC</span>
    <button class="btn btn-2 sm" data-act="withdraw" data-t="${tranche}" data-sh="${shares}" ${canW && !S.busy ? "" : "disabled"} ${why ? `title="${esc(why)}"` : ""}>Withdraw</button></div>`;
  return {
    html: `
      ${mySenior || myJunior ? `<section class="positions"><h2 class="h3">Your deposits</h2>
        ${mySenior ? pos("Fixed 6.5%", "Senior tranche · paid first", mySenior, "senior", S.lender!.senior_shares, true) : ""}
        ${myJunior ? pos("First-loss", locked ? `Junior tranche · locked until ${when(S.lender!.junior_unlocks_at)}` : "Junior tranche · unlocked", myJunior, "junior", S.lender!.junior_shares, !locked, locked ? "Locked for 36 days after your latest First-loss deposit" : "") : ""}
      </section>` : ""}
      <header class="scr-head"><h1 class="h1">Lend USDC</h1><p class="lede">Both layers lend to people borrowing against NEAR. They differ in who takes a loss first.</p></header>
      <div class="opts" role="radiogroup" aria-label="How you lend">
        <div class="opt ${!jr ? "on" : ""}"><button class="opt-btn" role="radio" aria-checked="${!jr}" data-act="tranche" data-v="senior"><span class="opt-radio"></span><span class="opt-txt"><b>Fixed 6.5% <em class="badge st-ok">6.5% a year</em></b><small>Paid before First-loss. Loses money only after every First-loss deposit is gone.</small></span></button></div>
        <div class="opt ${jr ? "on" : ""}"><button class="opt-btn" role="radio" aria-checked="${jr}" data-act="tranche" data-v="junior"><span class="opt-radio"></span><span class="opt-txt"><b>First-loss <em class="badge st-warn">Variable · can lose it all</em></b><small>Takes losses first and keeps what the pool earns after Fixed 6.5% and Ankora's 5% fee. Locked for 36 days.</small></span></button></div>
      </div>
      <section class="card-in">
        <div class="amount-top"><label for="lamt">Amount</label><button class="bal" data-act="max" ${S.usdcBal > 0n ? "" : "disabled"}>Balance <span class="num">${usdc(S.usdcBal)}</span> USDC</button></div>
        <div class="field-row big"><img class="coin" src="${ASSET}usdc.svg" alt=""><input id="lamt" class="input num" inputmode="decimal" placeholder="0.00" value="${esc(S.lendAmt)}" autocomplete="off"><span class="field-u">USDC</span></div>
        <p class="amount-help">Minimum 10 USDC. Short on test USDC? <button class="link inline" data-act="faucet" ${S.busy ? "disabled" : ""}>Get 1,000 test USDC</button></p>
      </section>
      <section class="risktext ${jr ? "tone-warn" : ""}"><h2 class="h2">${risk.h}</h2><p class="lede">${risk.t}</p>
        <button class="check" role="checkbox" aria-checked="${S.ack}" data-act="ack"><span class="check-box"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></span><span>${risk.ack}</span></button></section>`,
    dock: cta(jr ? "Deposit as First-loss" : "Deposit at Fixed 6.5%", "deposit", { disabled: !ok, hint }),
  };
}

let keeper: Awaited<ReturnType<typeof C.keeperStatus>> = null;
const NAV = [["home", "Borrow"], ["lend", "Lend"], ["loans", "Live loans"]];
const last = new WeakMap<HTMLElement, string>();
function put(el: HTMLElement, html: string) { if (last.get(el) !== html) { el.innerHTML = html; last.set(el, html); } }
/** True while the user is pressing, hovering a control, or typing: background refreshes wait. */
let pressed = false;
const busyHand = () => pressed || !!document.querySelector("#app [data-act]:hover, #app a:hover, #app details[open] input") || (document.activeElement as HTMLElement)?.tagName === "INPUT";
let pending = false;
function softRender() { if (busyHand()) { pending = true; return; } pending = false; render(); }
addEventListener("pointerdown", () => { pressed = true; }, true);
addEventListener("pointerup", () => { pressed = false; if (pending) setTimeout(softRender, 250); }, true);
document.addEventListener("pointerout", () => { if (pending) setTimeout(softRender, 250); });
function render() {
  const r = route();
  put($("#keeper"), keeper ? `<span class="badge ${keeper.ok ? "st-ok" : "st-bad"}">Price relay ${keeper.ok ? "live" : "lagging"}</span>` : "");
  put($("#wallet"), C.account ? `<span class="dot"></span><span>${esc(C.account)}</span>` : "Connect wallet");
  const link = (cls: string) => NAV.map(([k, l]) => `<a class="${cls} ${r === k ? "on" : ""}" href="#/${k === "home" ? "" : k}" ${r === k ? `aria-current="page"` : ""}><span>${l}</span></a>`).join("") + `<a class="${cls}" href="/#questions"><span>Risks</span></a>`;
  put($("#top-nav"), link("tn-i"));
  put($("#tabbar"), link("nav-i"));
  const scr = !C.configured() ? notConfigured() : r === "loans" ? loansScreen() : !C.account ? connectScreen() : r === "lend" ? lendScreen() : homeScreen();
  const err = S.error ? `<div class="status st-error" role="alert"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8v5M12 16.5v.01"/><circle cx="12" cy="12" r="9"/></svg><div class="st-txt"><b>Couldn't read the pool. ${esc(S.error)}</b><span>Numbers below may be out of date.</span><span class="st-links"><button class="st-link" data-act="reload">Try again</button></span></div></div>` : "";
  put($("#screen"), err + scr.html);
  put($("#dock"), scr.dock); $("#dock").className = scr.dock ? "dock" : "dock empty";
  put($("#context"), (S.ledger ? `<div class="ctx-block"><h3 class="h3">Pool, live from ${C.DEV_LOCAL ? "the local sandbox" : "NEAR testnet"}</h3><dl class="rows">
    <div><dt>Lent out</dt><dd><span class="num">${usdc(S.ledger.outstanding, 0)}</span> USDC</dd></div>
    <div><dt>Free cash</dt><dd><span class="num">${usdc(S.ledger.cash, 0)}</span> USDC</dd></div>
    <div><dt>Utilisation</dt><dd><span class="num">${(S.ledger.utilisation_bps / 100).toFixed(1)}%</span></dd></div></dl></div>` : "")
    + (C.account ? `<div class="ctx-block"><h3 class="h3">Your wallet</h3><dl class="rows">
    <div><dt>NEAR</dt><dd><span class="num">${near(S.nearBal)}</span></dd></div>
    <div><dt>Test USDC</dt><dd><span class="num">${usdc(S.usdcBal)}</span></dd></div></dl>
    <button class="btn btn-2 sm" data-act="faucet" ${S.busy ? "disabled" : ""}>Get 1,000 test USDC</button></div>` : "")
    + `<div class="ctx-block"><h3 class="h3">Price source</h3><p class="ctx-p">Pyth Pro NEAR/USD via Rhea's aggregate oracle on mainnet, copied every few seconds by the team's relay${C.DEV_LOCAL ? " into the local sandbox" : " to testnet"}. Unaudited testnet build.</p></div>`
    + demoPanel());
}

/** Local sandbox only (DEV_LOCAL + KEEPER_CONTROL): crash the price and walk a loan through notice, grace and auction. */
function demoPanel() {
  if (!C.DEV_LOCAL || !C.KEEPER_CONTROL) return "";
  const next = nextDeadline();
  const dis = S.busy ? "disabled" : "";
  return `<div class="ctx-block demo-panel"><h3 class="h3">Demo controls (local only)</h3>
    <p class="fine">Moves the sandbox's price and clocks. Never shown on testnet.</p>
    <div class="actions"><button class="btn btn-2 danger" data-act="dev-crash" ${dis}>Crash NEAR to $1</button><button class="btn btn-2" data-act="dev-live" ${dis}>Back to live price</button></div>
    <div class="actions one"><button class="btn btn-2" data-act="dev-next" ${dis || (next ? "" : "disabled")}>${next ? `Skip to next deadline (loan #${next.id}, ${left(next.deadline)})` : "Skip to next deadline"}</button></div></div>`;
}
/** The soonest deadline among this account's open loans. */
function nextDeadline() {
  return mine().filter((l) => l.deadline > 0).sort((a, b) => a.deadline - b.deadline)[0];
}

// ---------- events ----------
document.addEventListener("click", async (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-act]"); if (!el || (el as HTMLButtonElement).disabled) return;
  const a = el.dataset.act!, id = Number(el.dataset.id);
  if (a === "connect") return void C.connect();
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
  if (a === "stake-max") { const m = S.nearBal - GAS_SPARE * 2n; S.stake = m > 0n ? (Number(m / 10n ** 20n) / 1e4).toFixed(2) : "0"; return render(); }
  if (a === "refresh") { S.price = await C.readPrice().catch(() => S.price); return render(); }
  if (a === "tranche") { if (S.tranche !== el.dataset.v) S.ack = false; S.tranche = el.dataset.v as "senior" | "junior"; return render(); }
  if (a === "ack") { S.ack = !S.ack; return render(); }
  if (a === "max") { S.lendAmt = (Number(S.usdcBal) / 1e6).toFixed(2); return render(); }
  if (a === "faucet") return run(C.faucet(C.account!, 1_000n * U), { doing: "Minting 1,000 test USDC to your wallet.", done: "1,000 test USDC is in your wallet." });
  if (a === "claim") return run(C.act.claim(), { doing: `Claiming ${usdc(S.claimable)} USDC.`, done: `${usdc(S.claimable)} USDC is in your wallet.` });
  if (a === "settle") return run(C.act.settle(id), { doing: `Running loan #${id}'s renewal check.`, done: "Renewal check done.", doneBody: "The loan card shows its new state, read fresh from the chain." });
  if (a === "autorenew") { const on = el.dataset.on === "true"; return run(C.act.setAutoRenew(id, on), { doing: `Switching automatic renewal ${on ? "on" : "off"} for loan #${id}.`, done: on ? "Automatic renewal is on." : "Automatic renewal is off.", doneBody: on ? undefined : "Repay by the term's end, or a 48-hour grace period starts, then the auction." }); }
  if (a === "repay") {
    const amt = BigInt(el.dataset.amt!), l = S.all.find((x) => x.id === id), full = !!l && amt >= BigInt(l.debt);
    return run(C.act.repay(id, amt), { doing: `Repaying ${usdc(amt)} USDC on loan #${id}.`, done: full ? `Loan #${id} is repaid.` : `Paid down ${usdc(amt)} USDC.`,
      doneBody: full ? "Your vault is yours again: unstake and withdraw from the vault card. Anything you overpaid came back to you." : "Your LTV is back to 50% or lower. The loan card shows how it renews." });
  }
  if (a === "withdraw") {
    const t = el.dataset.t as "senior" | "junior";
    return run(C.act.withdraw(t, BigInt(el.dataset.sh!)), { doing: `Withdrawing your ${t === "senior" ? "Fixed 6.5%" : "First-loss"} deposit.`, done: "Withdrawn. The USDC is in your wallet." });
  }
  if (a === "deposit") {
    const amt = toUsdc(S.lendAmt), name = S.tranche === "senior" ? "Fixed 6.5%" : "First-loss";
    const r = await run(C.act.deposit(S.tranche, amt), { doing: `Depositing ${usdc(amt)} USDC as ${name}.`, done: `Deposited ${usdc(amt)} USDC as ${name}.`, doneBody: S.tranche === "junior" ? "It's locked for 36 days. Your deposits are listed at the top." : "Your deposits are listed at the top." });
    if (r.kind === "ok") { S.lendAmt = ""; S.ack = false; render(); }
    return r;
  }
  if (a === "v-unstake") return run(C.vault(el.dataset.v!).unstakeAll(), { doing: "Unstaking all NEAR in your vault.", done: "Unstaking started.", doneBody: "Withdraw in about 28 hours (4 epochs)." });
  if (a === "v-withdraw") return run(C.vault(el.dataset.v!).withdrawAll(), { doing: "Withdrawing NEAR from the validator into your vault.", done: "Withdrawn into your vault.", doneBody: "Last step: send it to your wallet." });
  if (a === "v-transfer") return run(C.vault(el.dataset.v!).transfer(C.account!, BigInt(el.dataset.amt!)), { doing: "Sending NEAR from your vault to your wallet.", done: "The NEAR is in your wallet." });
  if (a === "borrow") {
    S.price = await C.readPrice().catch(() => null); // re-check right before asking the wallet
    if (!S.price?.fresh) { toasts.push({ kind: "info", title: "The price moved or went stale since your quote.", body: "Check the new quote, then borrow again. Nothing was sent." }); return render(); }
    const Q = quoteNow();
    if (!Q?.q.ok) { toasts.push({ kind: "error", title: Q?.q.reason ?? "Couldn't quote this loan.", body: "Nothing was sent." }); return render(); }
    return run(C.act.borrow({ validator: S.validator, principal: Q.principal, plan: S.plan, stakeYocto: Q.stake }), { doing: `Borrowing ${usdc(Q.q.payout)} USDC against ${near(Q.stake)} NEAR.`, done: `${usdc(Q.q.payout)} USDC is in your wallet.`, doneBody: "Your NEAR is staked in your loan's vault. Your loan is at the top." });
  }
});
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
addEventListener("hashchange", () => { render(); if (route() === "loans") load(); });
C.onWallet(load);
if (C.KEEPER_URL) { const k = async () => { keeper = await C.keeperStatus(); softRender(); }; k(); setInterval(k, 30_000); }
// Countdowns tick locally; the price refreshes every 15 s (never mid-typing).
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
