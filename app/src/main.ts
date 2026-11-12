// Ankora app: live screens over the testnet pool. Markup and CSS come from design/proto (Sky · Navy · Apricot);
// numbers come from the chain through chain.ts. Copy follows research_docs/spektra-copy.md revision 4.1.
// Every screen is rebuilt from chain state after each transaction, never from local callbacks.
import "./styles/base.css";
import "./styles/directions.css";
import "./styles/palettes.css";
import "./app.css";
import * as C from "./chain.ts";
import { quoteBorrow, maxPrincipal, paydownToRenew, NEAR as YOCTO, type PlanName } from "../../client/src/quote.ts";

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const U = 1_000_000n; // USDC has 6 decimals
const usdc = (v: bigint | string, dp = 2) => (Number(BigInt(v)) / 1e6).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
const near = (y: bigint | string, dp = 2) => (Number(BigInt(y) / 10n ** 18n) / 1e6).toLocaleString("en-US", { maximumFractionDigits: dp });
const toYocto = (s: string): bigint => { const [i, f = ""] = s.trim().split("."); return BigInt(i || "0") * YOCTO + BigInt((f + "0".repeat(24)).slice(0, 24) || "0"); };
const toUsdc = (s: string): bigint => { const [i, f = ""] = s.trim().split("."); return BigInt(i || "0") * U + BigInt((f + "000000").slice(0, 6) || "0"); };
const safe = <T,>(f: () => T, d: T) => { try { return f(); } catch { return d; } };
const when = (secs: number) => new Date(secs * 1000).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";
const left = (secs: number) => { const d = secs - C.nowSecs(); if (d <= 0) return "now"; const h = Math.floor(d / 3600); return h >= 48 ? `${Math.floor(h / 24)} days` : `${h} h ${Math.floor((d % 3600) / 60)} m`; };
const planLabel = (p: string) => `${p.slice(1)}% plan`;
const VAULT_EXTRA = 24n * YOCTO / 100n; // 1.5 NEAR reserve minus ~1.26 NEAR of vault storage, measured on the local sandbox
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

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
  } catch (e) { S.error = (e as Error).message; }
  if (soft) softRender(); else render();
}
const REASONS: Record<string, string> = {
  Stale: "the price was over 90 seconds old when the transaction landed", WideConfidence: "the price feed was too unsure of the price",
  Breaker: "spot was more than 3% from the one-hour average", Missing: "there was no price", ExpoMismatch: "the price feed was malformed", Invalid: "the price was invalid",
  "LTV above plan cap": "the price fell between the quote and the transaction, so the loan was over the plan's limit",
  "vault creation failed": "the vault couldn't be created", "validator rejected or stake failed": "the validator didn't accept the stake",
  "staked amount below estimate": "the validator staked less than expected", "payout failed": "the USDC payout bounced",
};
/** What the chain said about a transaction, in words. */
function explain(o: C.Outcome, done: string): string {
  if (!o.ok) return `The transaction was refused and nothing changed: your NEAR and USDC never left the wallet. ${(o.failure ?? "").replace(/^\{.*?"(?:ExecutionError|panic_msg)":"?/, "").replace(/["}\]]+$/, "")}`.trim();
  const cancelled = o.logs.map((l) => /borrow \d+ cancelled: (.+)/.exec(l)?.[1]).find(Boolean);
  if (o.value === false || cancelled) {
    const why = cancelled ?? "the pool refused it";
    if (/vault handed to the borrower/.test(why)) return "The validator wouldn't take the stake, so the loan didn't start. Your vault and its NEAR are yours: see the vault card.";
    return `The borrow was cancelled and your NEAR was refunded. Reason: ${REASONS[why] ?? why}.`;
  }
  return done;
}
async function run(a: C.Action, done: string) {
  S.busy = true; render();
  try { toast(explain(await C.send(a), done)); } catch (e) { toast((e as Error).message || "The wallet rejected the transaction. Nothing was sent."); }
  S.busy = false; await load();
  setTimeout(load, 3000);
}
let toastT = 0;
function toast(m: string) { const t = $("#toast"); t.textContent = m; t.classList.add("on"); clearTimeout(toastT); toastT = window.setTimeout(() => t.classList.remove("on"), 5200); }

// ---------- screens ----------
const route = () => (location.hash.replace(/^#\/?/, "") || "home");

function cta(label: string, act: string, opts: { disabled?: boolean; hint?: string } = {}) {
  return `${opts.hint ? `<p class="cta-hint">${opts.hint}</p>` : ""}<button class="cta" data-act="${act}" ${opts.disabled || S.busy ? "disabled" : ""}><span class="cta-pic" aria-hidden="true">→</span><span class="cta-label">${S.busy ? "Waiting for the wallet…" : label}</span></button>`;
}

function notConfigured() {
  return { html: `<p class="kick">Testnet: launching this week</p><h1 class="h1">The testnet pool isn't deployed yet.</h1>
    <p class="lede">The app is pointed at placeholder accounts. Once the pool and test USDC are deployed, set <code>VITE_POOL</code> and <code>VITE_RELAY</code> in <code>app/.env.local</code> and reload.</p>`, dock: "" };
}

function connectScreen() {
  return { html: `<h1 class="h1">Borrow dollars against your NEAR. A 3am dip can't sell it.</h1>
    <p class="lede">Ankora checks the price when your loan starts and when it renews, and at no other time. If NEAR has fallen too far by renewal, you get five days to pay some back before anything is auctioned.</p>
    <p class="demo">NEAR testnet. Test USDC only. <a class="link inline" href="#/loans">See live loans without a wallet</a></p>`, dock: cta("Connect a NEAR wallet", "connect") };
}

function priceLine() {
  const p = S.price; if (!p) return "";
  const why = !p.ok ? `The pool can't use this price (${p.reason}).` : p.ageSecs > C.QUOTE_MAX_AGE_SECS ? `Over ${C.QUOTE_MAX_AGE_SECS} s old.` : p.gapBps > C.QUOTE_MAX_GAP_BPS ? "Spot is more than 3% from the one-hour average, so new loans are paused." : "";
  return `<p class="price-age ${why ? "stale" : ""}"><span>NEAR/USD $${p.price.toFixed(3)} · ${Number.isFinite(p.ageSecs) ? `${p.ageSecs} s old` : "no price"} · Pyth Pro via Rhea's oracle, copied by the team's relay${C.DEV_LOCAL ? " into the local sandbox" : " on testnet"}.${why ? " " + why : ""}</span></p>`;
}

function quoteNow() {
  const p = S.price, stake = safe(() => toYocto(S.stake), 0n), plan = S.plans.find((x) => x.plan === S.plan);
  if (!p?.ok || p.priceRaw === undefined || !plan || stake <= 0n) return null;
  const menu = S.plans.map((x) => ({ plan: x.plan, ltvCapBps: x.ltv_cap_bps, termSecs: x.term_secs, rateBps: x.rate_bps }));
  const principal = maxPrincipal(stake, { price: p.priceRaw, expo: p.expo! }, plan.ltv_cap_bps) * C.QUOTE_CAP_SHARE_BPS / 10_000n;
  return { plan, stake, principal, q: quoteBorrow({ stakeYocto: stake, principal, plan: S.plan, price: { price: p.priceRaw, expo: p.expo! }, menu }) };
}

function borrowScreen() {
  const p = S.price, Q = quoteNow(), q = Q?.q, plan = Q?.plan;
  const enough = q ? S.nearBal >= q.attachedYocto + YOCTO / 10n : false;
  const due = plan ? C.nowSecs() + plan.term_secs : 0;
  return {
    html: `
      <div class="recv"><span class="recv-k">You receive</span><span class="recv-v num">${q?.ok ? usdc(q.payout) : "–"}</span><span class="recv-u"><img class="coin" src="/assets/usdc.svg" alt="">USDC</span></div>
      <div class="amount">
        <label class="amount-top" for="stake"><span>NEAR you bring</span><span class="amount-pct">You have ${near(S.nearBal)} NEAR</span></label>
        <div class="field-row"><input id="stake" class="input num" inputmode="decimal" value="${esc(S.stake)}" autocomplete="off"><span class="field-u">NEAR</span></div>
        <div class="menu" role="radiogroup" aria-label="Plan">
          ${S.plans.map((x) => `<button class="menu-cell" role="radio" aria-checked="${x.plan === S.plan}" data-act="plan" data-v="${x.plan}"><b>${planLabel(x.plan)}</b><span>${Math.round(x.term_secs / 86400)}-day term</span><small>${(x.rate_bps / 100).toFixed(1)}% a year</small></button>`).join("")}
        </div>
        <p class="amount-help">Higher LTV, shorter term. Nothing above 50%. The quote sits a little under the plan's limit so a small price move doesn't cancel it.</p>
      </div>
      <ul class="facts">
        ${q?.ok ? `<li><span>${usdc(q.payout + q.termInterest)} loan, minus <b class="num">${usdc(q.termInterest)}</b> interest for the first ${Math.round(plan!.term_secs / 86400)} days, paid upfront. ${(plan!.rate_bps / 100).toFixed(1)}% a year, fixed for this term.</span></li>
        <li><span>Renews <b>${when(due)}</b> if your LTV is 50% or lower then. No price is read before that.</span></li>
        <li><span>Send <b class="num">${near(q.attachedYocto, 2)} NEAR</b>. About <b class="num">${near(Q!.stake + VAULT_EXTRA, 1)} NEAR</b> ends up staked as collateral; the rest of the 1.5 NEAR held back pays your vault's storage.</span></li>
        <li><span>To repay in full you'll need <b class="num">${usdc(q.payout + q.termInterest)}</b> USDC, more than you receive, because the first term's interest was taken upfront.</span></li>` : ""}
        ${q?.ok && !enough ? `<li><span>Short of testnet NEAR? Claim some at <a href="https://near-faucet.io/" target="_blank" rel="noopener">near-faucet.io</a> or the <a href="https://docs.near.org/getting-started/faucet" target="_blank" rel="noopener">NEAR docs faucet</a>, or lend instead: that needs only gas.</span></li>` : ""}
        <li><span>Your vault stakes with <b>${esc(S.validator)}</b>, which must be on the lockup whitelist (<code>whitelist.f863973.m0</code> on testnet).</span></li>
      </ul>
      <div class="field"><label for="val">Validator</label><div class="field-row"><input id="val" class="input" value="${esc(S.validator)}" autocomplete="off" spellcheck="false"></div></div>
      ${priceLine()}`,
    dock: !p ? cta("Reading the price…", "noop", { disabled: true })
      : !p.fresh ? cta("Refresh the price", "refresh")
      : !q?.ok ? cta("Borrow", "noop", { disabled: true, hint: q?.reason ?? "Enter how much NEAR to bring." })
      : cta(`Borrow ${usdc(q.payout)} USDC`, "borrow", { disabled: !enough, hint: enough ? "" : "Not enough NEAR in this wallet (keep about 0.1 NEAR for gas)." }),
  };
}

function repayButton(l: C.LoanView, amt: bigint, label: string, danger = false) {
  if (S.usdcBal >= amt) return `<button class="btn btn-2 ${danger ? "danger" : ""}" data-act="repay" data-id="${l.id}" data-amt="${amt}">${label}</button>`;
  return `<button class="btn btn-2" data-act="faucet">Get 1,000 test USDC</button><small class="short">${label} needs ${usdc(amt)} USDC; you have ${usdc(S.usdcBal)}.</small>`;
}

function loanCard(l: C.LoanView) {
  const p = S.price, debt = BigInt(l.debt), coll = BigInt(l.collateral);
  const value = p?.ok ? Number(coll) / 1e24 * p.price : 0;
  const ltv = value ? (Number(debt) / 1e6) / value * 100 : 0;
  const pay = p?.ok && p.priceRaw !== undefined ? paydownToRenew(debt, coll, { price: p.priceRaw, expo: p.expo! }) : 0n;
  const overdue = l.deadline > 0 && l.deadline <= C.nowSecs();
  const head: Record<string, string> = {
    Active: `Next price check ${when(l.deadline || l.expiry)}`,
    Notice: `Pay down by ${when(l.deadline)}`,
    Grace: `Grace period: ${left(l.deadline)} left`,
    Auction: `Your vault is at auction until ${when(l.deadline)}`,
    Defaulted: "Auction closed.",
  };
  const actions: string[] = [];
  if ((l.state === "Notice" || l.state === "Grace") && pay > 0n) actions.push(repayButton(l, pay, `Repay ${usdc(pay, 0)} USDC to renew`, true));
  if (l.state === "Auction") actions.push(repayButton(l, debt, `Repay ${usdc(debt)} USDC and stop the auction`, true));
  else if (l.state !== "Defaulted") actions.push(repayButton(l, debt, `Repay ${usdc(debt)} USDC in full`));
  if (overdue) actions.push(`<button class="btn btn-2" data-act="settle" data-id="${l.id}">Run the renewal check</button>`);
  return `<section class="loan ${l.state !== "Active" ? "is-alert" : ""}">
    <p class="kick">Loan #${l.id} · ${planLabel(l.plan)} · ${esc(l.state)}</p>
    <h2 class="h2">${head[l.state] ?? esc(l.state)}</h2>
    ${l.deadline ? `<p class="countdown num" data-deadline="${l.deadline}">${left(l.deadline)}</p><p class="lede">Ankora won't message you in v1, so check back by then.</p>` : ""}
    ${l.state === "Notice" ? `<p class="lede">After that, 48 hours' grace on the same terms, then a 24-hour auction. There's no late fee.</p>` : ""}
    ${l.state === "Auction" ? `<p class="lede">The price started at your vault's value and falls to half by the end. It's ${usdc(l.auction_price)} USDC now. You can repay in full until a bid lands.</p>` : ""}
    <dl class="rows">
      <div><dt>You owe</dt><dd class="num">${usdc(debt)} USDC</dd></div>
      <div><dt>Collateral</dt><dd><span class="num">${near(coll)}</span> NEAR <small>staked with ${esc(l.validator)}</small></dd></div>
      <div><dt>LTV now</dt><dd class="num">${ltv ? ltv.toFixed(1) + "%" : "–"} <small>renewal limit 50% · for information only</small></dd></div>
      <div class="row-switch"><dt id="ar-${l.id}">Renew automatically</dt><dd><button class="switch" role="switch" aria-checked="${l.auto_renew}" aria-labelledby="ar-${l.id}" data-act="autorenew" data-id="${l.id}" data-on="${!l.auto_renew}" ${S.busy ? "disabled" : ""}><i></i></button></dd></div>
    </dl>
    ${!l.auto_renew ? `<p class="note"><span>Repay ${usdc(debt)} USDC by ${when(l.expiry)}. If you don't, a 48-hour grace period starts straight away, then the auction.</span></p>` : ""}
    <div class="actions">${actions.join("")}</div>
  </section>`;
}

function vaultCard(v: C.MyVault) {
  // Done: nothing staked, unstaking or left above dust (0.01 NEAR) in the vault. Hide the card instead of offering "Send 0 NEAR".
  if (v.stakedNow === 0n && v.unstaked === 0n && v.transferable < 10n ** 22n) return "";
  const btn = (act: string, label: string, amt = "") => `<button class="btn btn-2" data-act="${act}" data-v="${v.vault}" ${amt ? `data-amt="${amt}"` : ""} ${S.busy ? "disabled" : ""}>${label}</button>`;
  const step = v.stakedNow > 0n
    ? { h: `Loan #${v.loanId} is closed. ${near(v.stakedNow)} NEAR is still staked in your vault.`, t: "The vault is yours now. Step 1 of 3: unstake. Then withdraw after 4 epochs (about 28 hours), then send the NEAR to your wallet.", b: btn("v-unstake", "Unstake all") }
    : v.unstaked > 0n && !v.canWithdraw
    ? { h: `${near(v.unstaked)} NEAR is unstaking.`, t: "Step 2 of 3. The validator releases it about 4 epochs (around 28 hours) after you unstaked. Check back then.", b: "" }
    : v.unstaked > 0n
    ? { h: `${near(v.unstaked)} NEAR is ready to withdraw.`, t: "Step 2 of 3: move it from the validator into your vault.", b: btn("v-withdraw", "Withdraw all") }
    : { h: `${near(v.transferable)} NEAR is ready to send.`, t: "Step 3 of 3. The vault keeps a small reserve for its own storage.", b: btn("v-transfer", `Send ${near(v.transferable)} NEAR to ${esc(C.account!)}`, String(v.transferable)) };
  return `<section class="loan"><p class="kick">Vault ${esc(v.vault)} · ${esc(v.validator)}</p><h2 class="h2">${step.h}</h2><p class="lede">${step.t}</p><div class="actions">${step.b}</div></section>`;
}

function homeScreen() {
  const parts: string[] = [];
  if (S.claimable > 0n) parts.push(`<section class="loan"><h2 class="h2">Auction closed. ${usdc(S.claimable)} USDC is yours.</h2><p class="lede">The transfer to ${esc(C.account!)} didn't go through, so it's waiting here.</p><div class="actions"><button class="btn btn-2" data-act="claim">Claim ${usdc(S.claimable)} USDC</button></div></section>`);
  parts.push(...mine().map(loanCard), ...S.vaults.map(vaultCard));
  const b = borrowScreen();
  return { html: `${parts.join("")}${parts.length ? `<h2 class="h2" style="margin-top:12px">Borrow again</h2>` : ""}${b.html}`, dock: b.dock };
}

function loansScreen() {
  const live = S.all.filter((l) => l.state !== "Closed");
  const rows = live.map((l) => `<tr><td class="num">#${l.id}</td><td>${planLabel(l.plan)}</td><td>${esc(l.state)}</td><td class="num">${usdc(l.debt, 0)}</td><td class="num">${near(l.collateral, 1)}</td><td>${l.deadline ? left(l.deadline) : "–"}</td></tr>`).join("");
  return { html: `<h1 class="h1">Live loans</h1><p class="lede">Read straight from the pool on testnet. No wallet needed.</p>
    ${live.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Loan</th><th>Plan</th><th>State</th><th>Owes (USDC)</th><th>NEAR</th><th>Next deadline</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<p class="note"><span>No open loans yet.</span></p>`}`, dock: "" };
}

function lendScreen() {
  const jr = S.tranche === "junior", L = S.ledger;
  const amt = safe(() => toUsdc(S.lendAmt || "0"), 0n);
  const share = (v: string, sh: string) => (BigInt(sh) > 0n ? Number(BigInt(v)) / Number(BigInt(sh)) : 1);
  const mySenior = S.lender && L ? Number(BigInt(S.lender.senior_shares)) * share(L.senior_value, L.senior_shares) : 0;
  const myJunior = S.lender && L ? Number(BigInt(S.lender.junior_shares)) * share(L.junior_value, L.junior_shares) : 0;
  const ok = amt >= 10n * U && amt <= S.usdcBal && S.ack;
  const risk = jr
    ? { h: "First-loss takes losses first, and can lose everything", t: "Junior tranche. You take losses before Fixed 6.5% lenders. In a bad enough crash you lose everything you deposit. Locked for 36 days from your latest First-loss deposit, and adding more restarts the lock.", ack: "I understand I can lose my entire First-loss deposit." }
    : { h: "Fixed 6.5% is paid first, and can still lose money", t: "Senior tranche. Interest is paid before First-loss deposits earn anything. You lose money only after every First-loss deposit is gone. Withdrawals are paid only from cash the pool isn't lending.", ack: "I understand Fixed 6.5% deposits can lose money in a fast NEAR crash and may not be withdrawable until borrowers repay." };
  return {
    html: `
      ${mySenior || myJunior ? `<div class="positions">${mySenior ? `<div class="pos"><b>Fixed 6.5%</b><span class="num">${usdc(BigInt(Math.floor(mySenior)))} USDC</span><small>Senior tranche</small></div>` : ""}${myJunior ? `<div class="pos"><b>First-loss</b><span class="num">${usdc(BigInt(Math.floor(myJunior)))} USDC</span><small>Junior tranche · unlocks ${when(S.lender!.junior_unlocks_at)}</small></div>` : ""}</div>` : ""}
      <h1 class="h1">Choose how you lend</h1>
      <p class="lede">Both lend your USDC to people borrowing against NEAR. They differ in who takes a loss first.</p>
      <div class="opts" role="radiogroup" aria-label="How you lend">
        <div class="opt ${!jr ? "on" : ""}"><button class="opt-btn" role="radio" aria-checked="${!jr}" data-act="tranche" data-v="senior"><span class="opt-radio"></span><span class="opt-txt"><b>Fixed 6.5% <em>Loses only after First-loss</em></b><small>Paid before First-loss. You lose money only if losses use up every First-loss deposit. Senior tranche.</small></span></button></div>
        <div class="opt ${jr ? "on" : ""}"><button class="opt-btn" role="radio" aria-checked="${jr}" data-act="tranche" data-v="junior"><span class="opt-radio"></span><span class="opt-txt"><b>First-loss <em>Variable · can lose it all</em></b><small>Takes losses first and keeps what the pool earns after Fixed 6.5% and Ankora's 5% fee. Locked for 36 days. Junior tranche.</small></span></button></div>
      </div>
      <section class="risktext"><h2 class="h2">${risk.h}</h2><p class="lede">${risk.t}</p>
        <button class="check" role="checkbox" aria-checked="${S.ack}" data-act="ack"><span class="check-box">✓</span><span>${risk.ack}</span></button></section>
      <div class="field"><label for="lamt">Amount</label><div class="field-row"><input id="lamt" class="input num" inputmode="decimal" placeholder="0.00" value="${esc(S.lendAmt)}" autocomplete="off"><span class="field-u">USDC</span><button class="chip sm" data-act="max">Max</button></div>
        <small>You have <span class="num">${usdc(S.usdcBal)}</span> test USDC. <button class="link inline" data-act="faucet">Get 1,000 test USDC</button></small></div>`,
    dock: cta(jr ? "Deposit as First-loss" : "Deposit at Fixed 6.5%", "deposit", { disabled: !ok, hint: !S.ack ? "Tick the box above first." : amt > 0n && amt < 10n * U ? "The minimum deposit is 10 USDC." : "" }),
  };
}

let keeper: Awaited<ReturnType<typeof C.keeperStatus>> = null;
const NAV = [["home", "Borrow"], ["lend", "Lend"], ["loans", "Live loans"]];
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
  const r = route();
  put($("#keeper"), keeper ? `<span class="badge ${keeper.ok ? "ok" : "lag"}">Price relay: ${keeper.ok ? "live" : "lagging"}</span>` : "");
  put($("#wallet"), C.account ? `<span class="dot"></span><span>${esc(C.account)}</span>` : "Connect");
  const link = (cls: string) => NAV.map(([k, l]) => `<a class="${cls} ${r === k ? "on" : ""}" href="#/${k === "home" ? "" : k}"><span>${l}</span></a>`).join("") + `<a class="${cls}" href="/landing/index.html#risks"><span>Risks</span></a>`;
  put($("#top-nav"), link("tn-i"));
  put($("#tabbar"), link("nav-i"));
  const scr = !C.configured() ? notConfigured() : r === "loans" ? loansScreen() : !C.account ? connectScreen() : r === "lend" ? lendScreen() : homeScreen();
  put($("#screen"), (S.error ? `<p class="note"><span>Couldn't read the pool: ${esc(S.error)}</span></p>` : "") + scr.html);
  put($("#dock"), scr.dock); $("#dock").className = scr.dock ? "dock" : "dock empty";
  put($("#context"), (S.ledger ? `<div class="ctx-block"><h3 class="h3">Pool, live from ${C.DEV_LOCAL ? "the local sandbox" : "testnet"}</h3><dl class="rows">
    <div><dt>Lent out</dt><dd class="num">${usdc(S.ledger.outstanding, 0)} USDC</dd></div>
    <div><dt>Free cash</dt><dd class="num">${usdc(S.ledger.cash, 0)} USDC</dd></div>
    <div><dt>Utilisation</dt><dd class="num">${(S.ledger.utilisation_bps / 100).toFixed(1)}%</dd></div>
    ${C.account ? `<div><dt>Your test USDC</dt><dd class="num">${usdc(S.usdcBal)}</dd></div>` : ""}</dl>
    ${C.account ? `<button class="link" data-act="faucet">Get 1,000 test USDC</button>` : ""}</div>` : "") + demoPanel());
}

/** Local sandbox only (DEV_LOCAL + KEEPER_CONTROL): crash the price and walk a loan through notice, grace and auction. */
function demoPanel() {
  if (!C.DEV_LOCAL || !C.KEEPER_CONTROL) return "";
  const next = nextDeadline();
  const dis = S.busy ? "disabled" : "";
  return `<div class="ctx-block demo-panel"><h3 class="h3">Demo controls (local only)</h3>
    <p class="fine">Moves the sandbox's price and clocks. Never shown on testnet.</p>
    <div class="actions"><button class="btn btn-2 danger" data-act="dev-crash" ${dis}>Crash NEAR to $1</button><button class="btn btn-2" data-act="dev-live" ${dis}>Back to live price</button></div>
    <div class="actions"><button class="btn btn-2" data-act="dev-next" ${dis || (next ? "" : "disabled")}>${next ? `Skip to next deadline (loan #${next.id}, ${left(next.deadline)})` : "Skip to next deadline"}</button></div></div>`;
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
  if (a === "refresh") { S.price = await C.readPrice().catch(() => S.price); return render(); }
  if (a === "tranche") { if (S.tranche !== el.dataset.v) S.ack = false; S.tranche = el.dataset.v as "senior" | "junior"; return render(); }
  if (a === "ack") { S.ack = !S.ack; return render(); }
  if (a === "max") { S.lendAmt = (Number(S.usdcBal) / 1e6).toFixed(2); return render(); }
  if (a === "faucet") return run(C.faucet(C.account!, 1_000n * U), "1,000 test USDC is in your wallet.");
  if (a === "claim") return run(C.act.claim(), "Claimed.");
  if (a === "settle") return run(C.act.settle(id), "Renewal check sent. The loan below is read fresh from chain.");
  if (a === "autorenew") return run(C.act.setAutoRenew(id, el.dataset.on === "true"), el.dataset.on === "true" ? "Renewal switched on." : "Renewal switched off.");
  if (a === "repay") return run(C.act.repay(id, BigInt(el.dataset.amt!)), "Repaid. Anything you overpaid comes back to you.");
  if (a === "deposit") return run(C.act.deposit(S.tranche, toUsdc(S.lendAmt)), "Deposited. It's in the pool.");
  if (a === "v-unstake") return run(C.vault(el.dataset.v!).unstakeAll(), "Unstaking started. Withdraw in about 28 hours.");
  if (a === "v-withdraw") return run(C.vault(el.dataset.v!).withdrawAll(), "Withdrawn into your vault. Send it to your wallet next.");
  if (a === "v-transfer") return run(C.vault(el.dataset.v!).transfer(C.account!, BigInt(el.dataset.amt!)), "Sent to your wallet.");
  if (a === "borrow") {
    S.price = await C.readPrice().catch(() => null); // re-check right before asking the wallet
    if (!S.price?.fresh) { toast("The price moved or went stale. Refresh it and try again."); return render(); }
    const Q = quoteNow();
    if (!Q?.q.ok) { toast(Q?.q.reason ?? "Couldn't quote this loan."); return render(); }
    return run(C.act.borrow({ validator: S.validator, principal: Q.principal, plan: S.plan, stakeYocto: Q.stake }), "Done. USDC is in your wallet and your NEAR is staked.");
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
  if (outs.length) toast(outs.map((o) => explain(o, "Done. The chain confirmed it.")).join(" "));
  await load();
});
render();
