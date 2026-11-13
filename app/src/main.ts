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
import "../../site/kinetic-grid.js"; // the landing's background, one source for both pages
import * as C from "./chain.ts";
import * as X from "./intents.ts";
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
const RESERVE = 3n * YOCTO / 2n;              // held back for the loan's vault account (contract VAULT_RESERVE)
const MIN_STAKE = 7n * YOCTO / 2n;            // the contract needs at least 5 NEAR attached: 3.5 staked + 1.5 reserve
/** The most this wallet can stake: balance minus the vault reserve and some gas. */
const maxStake = () => { const m = S.nearBal - RESERVE - GAS_SPARE * 2n; return m > 0n ? m : 0n; };
const nearIn = (y: bigint) => (Number(y / 10n ** 20n) / 1e4).toFixed(2);
const ASSET = `${import.meta.env.BASE_URL}assets/`;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

type Status = { kind: "pending" | "ok" | "error" | "info"; title: string; body?: string; hash?: string; act?: { label: string; act: string } };
const S = {
  plans: [] as C.PlanView[], price: null as C.PriceRead | null, all: [] as C.LoanView[], vaults: [] as C.MyVault[],
  history: [] as C.AuctionRecord[], nearBal: 0n, usdcBal: 0n, lender: null as Awaited<ReturnType<typeof C.pool.lender>>, ledger: null as Awaited<ReturnType<typeof C.pool.ledger>> | null, claimable: 0n,
  outPending: null as X.SendOut | null, out: { open: false, chain: "base", amt: "", to: "", busy: false, dep: null as (X.SendOut & { status: string; nearTx?: string }) | null }, xCopied: 0, xRefund: "", xDep: null as (X.Deposit & { status: string; nearTx?: string; tranche: string }) | null, xBusy: false, tab: "borrow" as "borrow" | "lend" | "auctions", xOpen: { borrow: false, lend: false } as Record<string, boolean>, xChain: "base", xq: { key: "", state: "idle" as "idle" | "loading" | "ok" | "err", out: 0, secs: 0 }, details: false, vals: [] as C.ValidatorRow[], valOpen: false, valActive: -1, valTouched: false, stake: "10", plan: "P30" as PlanName, validator: C.CFG.validator, tranche: "senior" as "senior" | "junior", ack: false, lendAmt: "", busy: false, error: "",
};
const mine = () => S.all.filter((l) => l.borrower === C.account && l.state !== "Closed");

// ---------- data ----------
async function load(soft = false) {
  if (!C.configured()) return render();
  try {
    const [plans, price, ledger, all] = await Promise.all([C.pool.plans(), C.readPrice(), C.pool.ledger(), C.allLoans()]);
    Object.assign(S, { plans, price, ledger, all, error: "" });
    S.history = await C.pool.auctionHistory(0, 10).catch(() => S.history); // older pools have no history view
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
    [/attach at least \d+ Tgas/, "The wallet sent too little gas. Try again; if your wallet lets you set gas, allow 230 Tgas."],
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
    [/doesn't have enough balance|The account doesn't have enough balance|Insufficient balance/i, C.MAINNET_NET ? "Not enough USDC in this wallet." : "Not enough test USDC. Get 1,000 from the faucet first."],
    [/mainnet cap: the pool holds at most 200 USDC/, "The mainnet pool is capped at 200 USDC while it is unaudited, and it is full. Deposit less."],
    [/mainnet cap: loans are limited to 100 USDC/, "Mainnet loans are capped at 100 USDC in total while the pool is unaudited. Borrow less."],
    [/not registered|storage_deposit/i, "Your account isn't registered with test USDC yet. Use the faucet once: it registers you."],
    [/Failed to fetch|NetworkError|timeout|ECONN|Load failed|503|502/i, `Couldn't reach NEAR ${C.NET}. Check your connection and try again.`],
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
async function run(a: C.Action | C.Action[], msg: Msg): Promise<Status> {
  S.busy = true; render();
  const id = toasts.push({ kind: "pending", title: "Confirm in your wallet", body: `${msg.doing} Nothing is sent until you approve it there.` });
  let st: Status;
  try { st = judge(await C.send(a), Array.isArray(a) ? a[a.length - 1]! : a, msg); }
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
const EXPLORER = (h: string) => `https://${C.MAINNET_NET ? "" : "testnet."}nearblocks.io/txns/${h}`;
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

// ---------- NEAR Intents: live quotes to fund or receive on another chain ----------
/** Chain picker chips: a brand-colour dot and the chain's name. */
const chainChips = (act: string, sel: string) => `<div class="xc-chains" role="radiogroup" aria-label="Chain">${X.CHAINS.map((c) => `<button class="xc-c" role="radio" aria-checked="${c.id === sel}" data-act="${act}" data-v="${c.id}"><i class="xdot xdot-${c.id}" aria-hidden="true"></i>${c.label}</button>`).join("")}</div>`;
/** The route: what you send on one side, what arrives on the other. `out` null = loading, NaN = no quote. */
function routeCard(sendAmt: string, from: { label: string; id: string }, to: { label: string; id: string }, out: number | null, secs: number) {
  const arrive = out === null ? `<span class="xr-skel" aria-hidden="true"></span>` : Number.isNaN(out) ? `<b class="num">–</b>` : `<b class="num">${out.toFixed(2)}</b>`;
  const meta = out === null ? "Getting a live quote" : Number.isNaN(out) ? "No quote right now. Try another chain." : `About ${secs} s · fees included · live quote from NEAR Intents`;
  return `<div class="xr" aria-live="polite">
      <div class="xr-s"><span class="xr-k">You send</span><span class="xr-v"><b class="num">${sendAmt}</b><small>USDC</small></span><span class="xr-c"><i class="xdot xdot-${from.id}" aria-hidden="true"></i>${from.label}</span></div>
      <svg class="xr-arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6.5 18.5 12 13 17.5"/></svg>
      <div class="xr-s is-out"><span class="xr-k">Arrives</span><span class="xr-v">${arrive}<small>USDC</small></span><span class="xr-c"><i class="xdot xdot-${to.id}" aria-hidden="true"></i>${to.label}</span></div>
    </div>
    <p class="xr-meta ${Number.isNaN(out ?? 0) ? "is-err" : ""}">${meta}</p>`;
}
/** Three steps of a cross-chain transfer; the current one pulses, a failure turns red. */
function xSteps(status: string, labels: [string, string, string]) {
  const bad = /REFUNDED|FAILED|INCOMPLETE/.test(status);
  const at = status === "SUCCESS" ? 3 : /KNOWN_DEPOSIT_TX|PROCESSING/.test(status) ? 1 : bad ? (status === "INCOMPLETE_DEPOSIT" ? 0 : 1) : 0;
  return `<ol class="xs">${labels.map((l, k) => `<li class="${k < at ? "done" : k === at ? (bad ? "bad" : "on") : ""}"><i aria-hidden="true">${k < at ? `<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>` : ""}</i><span>${l}</span></li>`).join("")}</ol>`;
}
const NEAR_SIDE = { label: "NEAR", id: "near" };
function crossChain(toNear: boolean, amount: bigint) {
  const ch = X.CHAINS.find((c) => c.id === S.xChain) ?? X.CHAINS[0]!;
  const amt = amount > 0n ? amount : 100n * U;
  const key = `${ch.id}:${toNear}:${amt}`;
  const q = S.xq.key === key ? S.xq : { state: "loading", out: 0, secs: 0 };
  const out = q.state === "ok" ? q.out : q.state === "err" ? NaN : null;
  const note = !C.MAINNET_NET ? "Live mainnet quote. NEAR Intents has no testnet, so nothing moves here."
    : toNear ? "Arrives in the pool as a deposit in your name." : "After the loan pays out: Your account → Send to another chain.";
  // A deposit in flight owns the row: no chain switching that would hide its address.
  const live = toNear && C.MAINNET_NET && S.xDep ? X.CHAINS.find((c) => c.id === S.xDep!.chain) : undefined;
  return `<details class="xc" data-xc ${S.xOpen[toNear ? "lend" : "borrow"] ? "open" : ""}><summary><span class="xc-t">${toNear ? "Fund from another chain" : "Receive on another chain"}</span><span class="xc-tag">NEAR Intents</span>${ICON.chev}</summary>
    <div class="xc-b">${live ? xDeposit(live, amt) : `
      ${chainChips("xchain", ch.id)}
      ${toNear ? routeCard(usdc(amt), ch, NEAR_SIDE, out, q.secs) : routeCard(usdc(amt), NEAR_SIDE, ch, out, q.secs)}
      ${toNear && C.MAINNET_NET ? xDeposit(ch, amt) : ""}
      <p class="xc-note">${note}</p>`}
    </div></details>`;
}
const MIN_DEP = C.MAINNET_NET ? 500_000n : 10n * U;
/** Room left under the mainnet pool's 200 USDC cap. */
const capRoom = () => S.ledger ? 200n * U - (BigInt(S.ledger.cash) + BigInt(S.ledger.outstanding)) : 0n;
const X_STATUS: Record<string, string> = {
  PENDING_DEPOSIT: "Waiting for your transfer", KNOWN_DEPOSIT_TX: "Transfer seen, confirming", PROCESSING: "Bridging to NEAR",
  SUCCESS: "Deposited in the pool", INCOMPLETE_DEPOSIT: "Less than quoted arrived: it will be refunded", REFUNDED: "Refunded to your address", FAILED: "Failed: refunded to your address",
};
function xDeposit(ch: X.Chain, amt: bigint) {
  const d = S.xDep;
  if (d && d.chain === ch.id) {
    const late = expired(d);
    const done = d.status === "SUCCESS", bad = late || /REFUNDED|FAILED|INCOMPLETE/.test(d.status);
    const copied = Date.now() - S.xCopied < 1500;
    return `<div class="xd ${done ? "is-ok" : bad ? "is-bad" : ""}">
      ${xSteps(late ? "FAILED" : d.status, ["Send", "Bridging", "In the pool"])}
      ${late ? `<p class="xd-k"><b>This address expired. Don't send to it.</b> Get a new one: quotes last an hour.</p>` : ""}
      ${done || bad ? "" : `<p class="xd-k">Send exactly <b class="num">${Number(d.amountIn).toFixed(2)} USDC</b> on ${ch.label} to this one-time address</p>
      <div class="xd-addr"><code>${esc(d.address)}</code><button class="xd-copy ${copied ? "is-done" : ""}" data-act="xcopy" aria-label="Copy the deposit address">${copied ? "Copied" : "Copy"}</button></div>`}
      <div class="xd-foot"><span aria-live="polite">${late ? "Expired" : esc(X_STATUS[d.status] ?? d.status)}${d.nearTx ? ` · <a href="${EXPLORER(d.nearTx)}" target="_blank" rel="noopener">NEAR transaction</a>` : ""}</span>
        <span>${done || bad ? `<button class="inline-link" data-act="xreset">New deposit</button>` : `Valid to ${new Date(d.deadline).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · <button class="inline-link" data-act="xreset">Cancel</button>`}</span></div>
      ${done ? `<p class="xd-done">About <b class="num">${d.amountOut.toFixed(2)}</b> USDC of ${d.tranche === "junior" ? "First-loss" : "Fixed"} is in ${esc(C.account ?? "")}.</p>` : ""}
    </div>`;
  }
  if (!C.account) return `<p class="xd-note">Connect your NEAR wallet first: the deposit is credited to it.</p>`;
  const q = S.xq.state === "ok" ? S.xq.out : 0;
  const addr = S.xRefund.trim(), okAddr = X.validAddress(ch, addr);
  const why = amt === 0n ? "Enter an amount above" : q > 0 && q * 1e6 < Number(MIN_DEP) ? "Arrives under the 0.5 USDC minimum" : q > 0 && BigInt(Math.ceil(q * 1e6)) > capRoom() ? `The pool has room for ${usdc(capRoom())} USDC` : !okAddr ? `Add your ${ch.label} address` : !S.ack ? "Confirm the risk below" : "";
  return `<label class="xd-in"><span>Refund address on ${ch.label}</span><input id="xrefund" class="input ${addr && !okAddr ? "is-bad" : ""}" placeholder="${ch.id === "sol" ? "Solana address" : "0x…"}" value="${esc(S.xRefund)}" autocomplete="off" spellcheck="false" aria-invalid="${!!addr && !okAddr}"></label>
    ${addr && !okAddr ? `<p class="xd-err">That isn't a ${ch.label} address.</p>` : ""}
    <button class="btn ${why ? "btn-2" : "btn-1"} xd-go" data-act="${why ? "noop" : "xdeposit"}" ${why || S.xBusy ? "disabled" : ""}>${S.xBusy ? "Getting an address…" : why || `Get a ${ch.label} deposit address`}</button>`;
}
/** Fetch the open row's quote when its chain, direction or amount changes. */
function ensureQuote() {
  if (!S.xOpen[S.tab]) return;
  const toNear = S.tab === "lend";
  const ch = X.CHAINS.find((c) => c.id === S.xChain) ?? X.CHAINS[0]!;
  const raw = toNear ? safe(() => toUsdc(S.lendAmt || "0"), 0n) : (quoteNow()?.q.ok ? quoteNow()!.q.payout : 0n);
  const amt = raw > 0n ? raw : 100n * U;
  const key = `${ch.id}:${toNear}:${amt}`;
  if (S.xq.key === key) return;
  S.xq = { key, state: "loading", out: 0, secs: 0 };
  X.quote(ch, amt, toNear).then((r) => { if (S.xq.key === key) { S.xq = { key, state: "ok", out: r.out, secs: r.secs }; render(); } })
    .catch(() => { if (S.xq.key === key) { S.xq = { key, state: "err", out: 0, secs: 0 }; render(); } });
}

// ---------- lending APRs: Fixed is set by the contract; First-loss earns what is left ----------
const SENIOR_APR = 0.065, FEE = 0.05;
/** First-loss APR estimate: (pool interest after Ankora's 5% − Fixed's 6.5% on its lent share) ÷ the First-loss share.
 *  Uses live utilisation and the debt-weighted rate of open loans (the plans' average when none are open). No defaults assumed. */
function aprModel() {
  const L = S.ledger; if (!L) return null;
  const sen = Number(BigInt(L.senior_value)), jun = Number(BigInt(L.junior_value)), tot = sen + jun;
  if (!tot || !jun) return null;
  const open = S.all.filter((l) => l.state === "Active" || l.state === "Notice" || l.state === "Grace");
  const rate = (p: string) => (S.plans.find((x) => x.plan === p)?.rate_bps ?? 1000) / 1e4;
  const debt = open.reduce((s, l) => s + Number(BigInt(l.debt)), 0);
  const avg = debt ? open.reduce((s, l) => s + Number(BigInt(l.debt)) * rate(l.plan), 0) / debt : (S.plans.reduce((s, x) => s + x.rate_bps, 0) / Math.max(1, S.plans.length)) / 1e4;
  const sShare = sen / tot, jShare = jun / tot;
  // Fixed earns 6.5% only on lent cash (the pool's accrual clock runs at its utilisation), so idle cash costs First-loss nothing.
  const at = (u: number) => (u * avg * (1 - FEE) - sShare * SENIOR_APR * u) / jShare * 100;
  return { now: at(L.utilisation_bps / 1e4), at80: at(0.8) };
}
const pct = (x: number) => `${x < 0 ? "−" : ""}${Math.abs(x).toFixed(1)}%`;

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
  const cell = (k: string, v: string, side = "") => `<div class="stat"><span class="stat-k">${k}${side ? `<span class="stat-side">${side}</span>` : ""}</span><span class="stat-v num">${v}</span></div>`;
  const unit = (x: string) => `${x} <small>USDC</small>`;
  return `<div class="stats-row">
    ${cell("Available to borrow", L ? unit(usdc(L.cash, 0)) : "–")}
    ${cell("Lent out", L ? unit(usdc(L.outstanding, 0)) : "–")}
    ${cell("Utilisation", L ? `${(L.utilisation_bps / 100).toFixed(1)}%` : "–", L ? `<span class="util"><i style="width:${Math.min(100, L.utilisation_bps / 100)}%"></i></span>` : "")}
    ${cell("NEAR price", p ? `$${p.price.toFixed(3)}` : "–", p ? `<span class="live ${stale ? "is-stale" : ""}"><i></i>${stale ? "stale " : ""}${age}</span>` : "")}
  </div>`;
}


function quoteNow() {
  const p = S.price, stake = safe(() => toYocto(S.stake), 0n), plan = S.plans.find((x) => x.plan === S.plan);
  if (!p?.ok || p.priceRaw === undefined || !plan || stake <= 0n) return null;
  const menu = S.plans.map((x) => ({ plan: x.plan, ltvCapBps: x.ltv_cap_bps, termSecs: x.term_secs, rateBps: x.rate_bps }));
  const principal = maxPrincipal(stake, { price: p.priceRaw, expo: p.expo! }, plan.ltv_cap_bps) * C.QUOTE_CAP_SHARE_BPS / 10_000n;
  return { plan, stake, principal, q: quoteBorrow({ stakeYocto: stake, principal, plan: S.plan, price: { price: p.priceRaw, expo: p.expo! }, menu }) };
}

function validatorPicker() {
  const cur = S.vals.find((v) => v.id === S.validator);
  const fee = (v: C.ValidatorRow) => v.eligible === false ? `<span class="fee-no">Not eligible</span>` : v.feePct === undefined ? "" : v.feePct === null ? "" : `<span class="num ${v.feePct > 20 ? "fee-hi" : ""}">${v.feePct.toFixed(0)}% fee</span>`;
  const meta = (v?: C.ValidatorRow) => v ? `<span class="num">${v.sharePct.toFixed(1)}% of stake</span>${fee(v)}` : `<span>Custom</span>`;
  const list = S.valOpen ? `<div class="vp-pop" role="listbox" id="vp-list" aria-label="Validators">
      ${S.vals.length ? `<p class="vp-head"><span>Validator</span><span>Stake · fee</span></p>` + S.vals.map((v, i) => `<button class="vp-opt ${i === S.valActive ? "is-active" : ""}" role="option" id="vp-${i}" aria-selected="${v.id === S.validator}" aria-disabled="${v.eligible === false}" ${v.eligible === false ? "disabled" : ""} data-act="val-pick" data-v="${esc(v.id)}"><b>${esc(v.id.replace(/\.pool\..*$/, ""))}</b><small class="num">${esc(v.id)}</small>${meta(v)}</button>`).join("") : `<p class="vp-wait">Loading validators…</p>`}
      <div class="vp-own"><input id="val" class="val num" value="${S.vals.some((v) => v.id === S.validator) ? "" : esc(S.validator)}" placeholder="Or type a whitelisted pool account" autocomplete="off" spellcheck="false" aria-label="Validator account"></div>
    </div>` : "";
  return `<div class="vp"><span class="vp-k">Stake with</span>
    <button class="vp-btn" data-act="val-open" aria-haspopup="listbox" aria-expanded="${S.valOpen}" ${S.valOpen ? `aria-controls="vp-list"` : ""}><b>${esc(S.validator.replace(/\.pool\..*$/, ""))}</b>${meta(cur)}${ICON.chev}</button>${list}</div>`;
}

function borrowPanel() {
  const p = S.price, Q = quoteNow(), q = Q?.q, plan = Q?.plan;
  const days = plan ? Math.round(plan.term_secs / 86400) : 0;
  const due = plan ? C.nowSecs() + plan.term_secs : 0;
  const amt = safe(() => toYocto(S.stake), 0n);
  const button = !C.account ? connectBtn()
    : !p ? btn("Reading the price…", "noop", false)
    : !p.fresh ? btn("Refresh the price", "refresh", true)
    : maxStake() < MIN_STAKE ? btn(`Needs 5.1 NEAR · you have ${near(S.nearBal)}`, "noop", false)
    : amt <= 0n ? btn("Enter an amount", "noop", false)
    : amt < MIN_STAKE ? btn("Stake at least 3.5 NEAR", "noop", false)
    : amt > maxStake() ? btn(`Stake at most ${nearIn(maxStake())} NEAR`, "noop", false)
    : !q?.ok ? btn(q?.reason === "LTV above plan cap" ? "Price moved: refresh" : q?.reason ?? "Can't quote this", "noop", false)
    : btn(`Borrow ${usdc(q.payout)} USDC`, "borrow", true);
  return `
    <div class="box">
      <div class="box-top"><label for="stake">You stake</label>${C.account ? `<button class="bal" data-act="stake-max">Balance <span class="num">${near(S.nearBal)}</span> · Max</button>` : ""}</div>
      <div class="box-in">${ICON.near()}<input id="stake" class="input num" inputmode="decimal" value="${esc(S.stake)}" autocomplete="off" placeholder="0"><span class="unit">NEAR</span></div>
      ${validatorPicker()}
    </div>
    <div class="plans" role="radiogroup" aria-label="Plan">
      ${S.plans.map((x) => `<button class="plan" role="radio" aria-checked="${x.plan === S.plan}" data-act="plan" data-v="${x.plan}" aria-label="Up to ${x.plan.slice(1)}% LTV for ${Math.round(x.term_secs / 86400)} days at ${(x.rate_bps / 100).toFixed(1)}% APR"><b class="num">${x.plan.slice(1)}%</b><span class="num">${Math.round(x.term_secs / 86400)} d</span><small class="num">${(x.rate_bps / 100).toFixed(1)}%</small></button>`).join("")}
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
    ${C.account && S.nearBal > 0n && maxStake() < MIN_STAKE ? `<p class="fine warn">A loan sends at least 5 NEAR: 3.5 to stake, 1.5 for your vault account. ${C.MAINNET_NET ? "Add NEAR to this wallet," : `Get testnet NEAR at <a href="https://near-faucet.io/" target="_blank" rel="noopener">near-faucet.io</a>,`} or <button class="inline-link" data-act="tab" data-v="lend">lend instead</button>.</p>`
      : `<p class="fine">Your NEAR stays staked. No price check for ${days || "7 to 30"} days.</p>`}
    ${crossChain(false, q?.ok ? q.payout : 0n)}
    <details class="more" ${S.details ? "open" : ""} data-details><summary>Details ${ICON.chev}</summary>
      <dl class="terms sm">
        ${q?.ok ? `<div><dt>NEAR sent</dt><dd class="num">${near(q.attachedYocto)} NEAR</dd></div><div><dt>Staked as collateral</dt><dd class="num">≈ ${near(Q!.stake + VAULT_EXTRA, 1)} NEAR</dd></div><div><dt>Vault storage</dt><dd>Rest of the 1.5 NEAR reserve</dd></div>` : ""}
        <div><dt>Above 50% LTV at renewal</dt><dd>72 h notice, 48 h grace, then a 24 h auction</dd></div>
      </dl>
    </details>`;
}

function lendPanel() {
  const jr = S.tranche === "junior";
  const amt = safe(() => toUsdc(S.lendAmt || "0"), 0n);
  const m = aprModel();
  const risk = jr
    ? "Earns the pool's interest above Fixed's 6.5% on lent cash: more as more is lent. Takes losses first and can lose everything. Locked 36 days."
    : "6.5% a year on the share of the pool that is lent out, paid before First-loss. Loses money only after every First-loss deposit is gone.";
  const ack = jr ? "I can lose my whole First-loss deposit" : "Fixed can lose money in a fast crash";
  const button = !C.account ? connectBtn()
    : amt === 0n ? btn("Enter an amount", "noop", false)
    : amt < MIN_DEP ? btn(`Minimum ${C.MAINNET_NET ? "0.5" : "10"} USDC`, "noop", false)
    : amt > S.usdcBal ? btn("Not enough USDC", "noop", false)
    : !S.ack ? btn("Confirm the risk above", "noop", false)
    : btn(`Deposit ${usdc(amt)} USDC`, "deposit", true);
  return `
    <div class="layers" role="radiogroup" aria-label="Layer">
      <button class="layer" role="radio" aria-checked="${!jr}" data-act="tranche" data-v="senior"><span class="layer-row"><span class="layer-k">Fixed</span><b class="layer-apr num">6.5%</b></span><span class="layer-s">on lent cash${S.ledger ? ` · <span class="num">${pct(6.5 * S.ledger.utilisation_bps / 1e4)}</span> now` : ""}</span></button>
      <button class="layer" role="radio" aria-checked="${jr}" data-act="tranche" data-v="junior"><span class="layer-row"><span class="layer-k">First-loss</span><b class="layer-apr num ${m && m.now < 0 ? "down" : "up"}">${m ? pct(m.now) : "–"}</b></span><span class="layer-s">est. APR now${m ? ` · <span class="num">${pct(m.at80)}</span> at 80% lent` : ""}</span></button>
    </div>
    <p class="risk ${jr ? "is-warn" : ""}">${risk}</p>
    <div class="box">
      <div class="box-top"><label for="lamt">You deposit</label>${C.account ? `<button class="bal" data-act="max">Balance <span class="num">${usdc(S.usdcBal)}</span> · Max</button>` : ""}</div>
      <div class="box-in">${ICON.usdc()}<input id="lamt" class="input num" inputmode="decimal" placeholder="0" value="${esc(S.lendAmt)}" autocomplete="off"><span class="unit">USDC</span></div>
    </div>
    ${crossChain(true, amt)}
    <button class="ack" role="checkbox" aria-checked="${S.ack}" data-act="ack"><span class="ack-box"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></span>${ack}</button>
    ${button}
    <p class="fine">${C.MAINNET_NET ? "Real USDC. Unaudited: the pool is capped at 200 USDC and loans at 100 USDC." : C.account ? `Test USDC only. <button class="inline-link" data-act="faucet" ${S.busy ? "disabled" : ""}>Get 1,000</button>` : "Test USDC only."}</p>`;
}

function auctionsPanel() {
  const list = auctions(), past = S.history.filter((h) => h.outcome !== "live");
  if (!list.length) return past.length
    ? `<p class="auc-none">No live auctions. A loan reaches auction after 72 h notice and 48 h grace.</p>${historyList(past)}`
    : `<div class="empty"><b>No auctions yet</b><span>A loan reaches auction only after 72 h notice and 48 h grace. Its price then falls from 100% to 50% of the vault's value over 24 h.</span></div>`;
  return `<ul class="auc">${list.map((l) => {
    const price = BigInt(l.auction_price), coll = BigInt(l.collateral);
    const can = !!C.account && S.usdcBal >= price;
    return `<li class="auc-i">
      <div class="auc-top"><span class="num">Loan #${l.id}</span><span class="badge st-bad">Ends in <span class="num" data-deadline="${l.deadline}">${left(l.deadline)}</span></span></div>
      <div class="auc-main"><div><span class="k">You get</span><b class="num">${near(coll)} NEAR</b><small>Staked with ${esc(l.validator)}</small></div>
        <div class="r"><span class="k">Price now</span><b class="num">${usdc(price)} USDC</b><small>Falling</small></div></div>
      ${!C.account ? connectBtn() : can ? `<button class="cta" data-act="bid" data-id="${l.id}" data-amt="${price}" ${S.busy ? "disabled" : ""}><span class="cta-label">Buy for ${usdc(price)} USDC</span></button>` : btn("Not enough USDC", "noop", false)}
    </li>`; }).join("")}</ul>
    <p class="fine">You buy the loan's vault: the NEAR stays staked and becomes yours to unstake.</p>${historyList(past)}`;
}

const ago = (secs: number) => { const d = Math.max(0, C.nowSecs() - secs); return d < 3600 ? `${Math.max(1, Math.round(d / 60))} m ago` : d < 172_800 ? `${Math.round(d / 3600)} h ago` : `${Math.round(d / 86400)} d ago`; };
/** Finished auctions, newest first: what sold, for how much, to whom; or that nobody bought. */
function historyList(past: C.AuctionRecord[]) {
  if (!past.length) return "";
  const row = (h: C.AuctionRecord) => {
    const out = h.outcome === "sold" ? { tone: "ok", label: "Sold", v: `${usdc(h.price)} <small>USDC</small>`, sub: `to ${esc(h.buyer === C.account ? "you" : (h.buyer ?? "").replace(/\.(testnet|near)$/, ""))}${BigInt(h.surplus) > 0n ? ` · ${usdc(h.surplus)} USDC surplus to the borrower` : ""}` }
      : h.outcome === "repaid" ? { tone: "mute", label: "Stopped", v: `${usdc(h.price)} <small>USDC</small>`, sub: "repaid in full by the borrower" }
      : { tone: "bad", label: "No buyer", v: "–", sub: "vault went to the pool for recovery" };
    return `<li class="hist-i"><span class="num hist-id">Loan #${h.id}</span><span class="badge st-${out.tone}">${out.label}</span><b class="num hist-v">${out.v}</b><span class="hist-t">${h.ended_at ? ago(h.ended_at) : ""}</span>
      <span class="hist-sub num">${near(h.collateral)} NEAR · opened at ${usdc(h.start_value)} USDC · ${out.sub}</span></li>`;
  };
  return `<section class="hist"><h3 class="h3">History</h3><ul>${past.map(row).join("")}</ul></section>`;
}

// ---------- your account ----------
const STATE: Record<string, { label: string; tone: string }> = {
  Active: { label: "Active", tone: "ok" }, Notice: { label: "Pay down", tone: "warn" }, Grace: { label: "Grace", tone: "warn" },
  Auction: { label: "At auction", tone: "bad" }, Defaulted: { label: "Auction ended", tone: "mute" },
};
function repayBtn(l: C.LoanView, amt: bigint, label: string, primary: boolean) {
  if (S.usdcBal < amt && C.MAINNET_NET) return "";
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
  const next = l.state === "Defaulted" ? "Auction ended without a bid. Ask the team about recovery." : `${line[l.state] ?? ""} ${l.deadline ? `<b class="num" data-deadline="${l.deadline}">${left(l.deadline)}</b>` : ""}`;
  return `<li class="row-i tone-${st.tone}">
    <div class="row-a"><span class="row-n num">Loan #${l.id}</span><span class="badge st-${st.tone}">${st.label}</span></div>
    <b class="row-v num">${l.state === "Defaulted" ? "No buyer" : `${usdc(debt)} <small>USDC owed</small>`}</b>
    <div class="row-acts">${acts.join("")}</div>
    <div class="row-sub">${next} · <span class="num">${near(coll)} NEAR · ${l.plan.slice(1)}% plan · LTV ${ltv ? ltv.toFixed(1) + "%" : "–"}</span> · <button class="inline-link" role="switch" aria-checked="${l.auto_renew}" data-act="autorenew" data-id="${l.id}" data-on="${!l.auto_renew}" ${S.busy ? "disabled" : ""}>Auto-renew ${l.auto_renew ? "on" : "off"}</button></div>
  </li>`;
}
function vaultItem(v: C.MyVault) {
  if (v.stakedNow === 0n && v.unstaked === 0n && v.transferable < 10n ** 22n) return "";
  const b = (act: string, label: string, amt = "") => `<button class="btn btn-1 sm" data-act="${act}" data-v="${v.vault}" ${amt ? `data-amt="${amt}"` : ""} ${S.busy ? "disabled" : ""}>${label}</button>`;
  const step = v.stakedNow > 0n ? { n: 1, t: `${near(v.stakedNow)} NEAR staked`, s: "Unstake, then withdraw in about 28 h.", b: b("v-unstake", "Unstake") }
    : v.unstaked > 0n && !v.canWithdraw ? { n: 2, t: `${near(v.unstaked)} NEAR unstaking`, s: "Ready in about 28 h from unstaking.", b: "" }
    : v.unstaked > 0n ? { n: 2, t: `${near(v.unstaked)} NEAR ready`, s: "Withdraw it into the vault.", b: b("v-withdraw", "Withdraw") }
    : { n: 3, t: `${near(v.transferable)} NEAR in the vault`, s: "Send it to your wallet.", b: b("v-transfer", "Send to wallet", String(v.transferable)) };
  return `<li class="row-i">
    <div class="row-a"><span class="row-n num">Vault · loan #${v.loanId}</span><span class="mini-steps" aria-label="Step ${step.n} of 3">${[1, 2, 3].map((i) => `<i class="${i < step.n ? "done" : i === step.n ? "on" : ""}"></i>`).join("")}</span></div>
    <b class="row-v num">${step.t}</b>
    <div class="row-acts">${step.b}</div>
    <div class="row-sub">Step ${step.n} of 3. ${step.s}</div></li>`;
}
/** The pool at a glance: real numbers whether or not a wallet is connected. */
function poolNow() {
  const L = S.ledger; if (!L) return "";
  const m = aprModel(), open = S.all.filter((l) => l.state === "Active" || l.state === "Notice" || l.state === "Grace").length, auc = auctions().length;
  const row = (k: string, v: string, end = "") => `<div><dt>${k}</dt><dd class="num">${v}</dd><dd class="end">${end}</dd></div>`;
  return `<section class="acct-sec"><h3 class="h3">Current pool</h3><dl class="pool-dl">
    ${row("Fixed", `${usdc(L.senior_value, 0)} USDC`, `<span class="num">${pct(6.5 * L.utilisation_bps / 1e4)}</span> now`)}
    ${row("First-loss", `${usdc(L.junior_value, 0)} USDC`, m ? `<span class="num ${m.now < 0 ? "down" : "up"}">${pct(m.now)}</span> now` : "")}
    ${row("Open loans", String(open), `<span class="num">${usdc(L.outstanding, 0)}</span> USDC lent`)}
    ${row("At auction", String(auc), auc ? `<button class="inline-link" data-act="tab" data-v="auctions">See auctions</button>` : "")}
  </dl></section>`;
}
function account() {
  if (!C.account) return `${poolNow()}<div class="acct-empty"><b>Borrow or lend from your wallet</b><span>Connect a NEAR ${C.NET} wallet. Your loans, vaults and deposits appear here.</span>${connectBtn()}</div>`;
  const L = S.ledger, share = (v: string, sh: string) => (BigInt(sh) > 0n ? Number(BigInt(v)) / Number(BigInt(sh)) : 1);
  const sen = S.lender && L ? Number(BigInt(S.lender.senior_shares)) * share(L.senior_value, L.senior_shares) : 0;
  const jun = S.lender && L ? Number(BigInt(S.lender.junior_shares)) * share(L.junior_value, L.junior_shares) : 0;
  const locked = !!S.lender && S.lender.junior_unlocks_at > C.nowSecs();
  const m = aprModel();
  const dep = (name: string, val: number, tr: string, sh: string, ok: boolean, lockedUntil = 0) => `<li class="dep">
    <span class="dep-n">${name}</span>
    <span class="dep-apr num ${tr === "junior" && m && m.now < 0 ? "down" : ""}">${tr === "junior" ? (m ? `${pct(m.now)} est.` : "Variable") : "6.5% APR"}</span>
    <b class="dep-v num">${usdc(BigInt(Math.floor(val)))} <small>USDC</small></b>
    ${ok ? `<button class="btn btn-2 sm" data-act="withdraw" data-t="${tr}" data-sh="${sh}" ${S.busy ? "disabled" : ""}>Withdraw</button>` : `<span class="dep-lock" title="First-loss is locked 36 days after your latest First-loss deposit">Locked to ${new Date(lockedUntil * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span>`}
  </li>`;
  const loans = mine().map(loanItem).join(""), vaults = S.vaults.map(vaultItem).join("");
  const deps = (sen ? dep("Fixed", sen, "senior", S.lender!.senior_shares, true) : "") + (jun ? dep("First-loss", jun, "junior", S.lender!.junior_shares, !locked, S.lender!.junior_unlocks_at) : "");
  const claim = S.claimable > 0n ? `<li class="row-i tone-ok"><div class="row-a"><span class="row-n">Auction surplus</span></div><b class="row-v num">${usdc(S.claimable)} <small>USDC</small></b><div class="row-acts"><button class="btn btn-1 sm" data-act="claim" ${S.busy ? "disabled" : ""}>Claim</button></div><div class="row-sub">Your vault sold above its debt; this part is yours.</div></li>` : "";
  const sec = (h: string, body: string) => body ? `<section class="acct-sec"><h3 class="h3">${h}</h3><ul>${body}</ul></section>` : "";
  const nothing = !loans && !vaults && !deps && !claim;
  return `<div class="wallet-row"><div><span class="k">NEAR</span><b class="num">${near(S.nearBal)}</b></div><div><span class="k">USDC</span><b class="num">${usdc(S.usdcBal)}</b></div>${C.MAINNET_NET ? (S.usdcBal > 0n || S.out.dep ? `<button class="btn btn-2 sm" data-act="out-open" aria-expanded="${S.out.open}">Send to another chain</button>` : "") : `<button class="btn btn-2 sm" data-act="faucet" ${S.busy ? "disabled" : ""}>Get test USDC</button>`}</div>${C.MAINNET_NET && S.out.open ? sendOutBox() : ""}
    ${sec("To claim", claim)}${sec("Your loans", loans)}${sec("Your vaults", vaults)}${deps ? `<section class="acct-sec"><h3 class="h3">Your deposits</h3><ul class="deps">${deps}</ul></section>` : ""}
    ${nothing ? `<div class="acct-empty sm"><span>No loans or deposits yet. Use the card to start one.</span></div>` : ""}${poolNow()}${demoPanel()}`;
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
  put($("#keeper"), keeper ? `<span class="badge ${keeper.ok ? "st-ok" : "st-bad"}">Price relay ${keeper.ok ? "live" : "lagging"}</span>` : C.MAINNET_NET && S.price ? `<span class="badge ${S.price.ok && S.price.fresh ? "st-ok" : "st-bad"}">Rhea oracle ${S.price.ok && S.price.fresh ? "live" : "stale"}</span>` : "");
  put($("#net"), C.DEV_LOCAL ? "" : `<div class="net" role="radiogroup" aria-label="Network">${(["testnet", "mainnet"] as const).map((n) => `<button role="radio" aria-checked="${C.NET === n}" data-act="net" data-v="${n}">${n === "testnet" ? "Testnet" : "Mainnet"}</button>`).join("")}</div>`);
  put($("#wallet"), C.account ? `<span class="dot"></span><span>${esc(C.account)}</span>` : "Connect wallet");
  $("#wallet").classList.toggle("is-out", !C.account);
  $("#wallet").setAttribute("aria-label", C.account ? `Signed in as ${C.account}. Disconnect` : "Connect a NEAR wallet");
  if (!C.configured()) { put($("#screen"), C.MAINNET_NET ? `<div class="empty"><b>The mainnet pool opens shortly.</b><span>It launches capped at 200 USDC while unaudited. <button class="inline-link" data-act="net" data-v="testnet">Use testnet</button> meanwhile: it's free.</span></div>` : `<div class="empty"><b>The testnet pool isn't configured.</b><span>Set VITE_POOL and VITE_RELAY in app/.env.local.</span></div>`); return; }
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
  ensureQuote();
  put($("#context"), `<h2 class="acct-h">Your account</h2>${account()}`);
}

/** Local sandbox only (DEV_LOCAL + KEEPER_CONTROL): crash the price and walk a loan through notice, grace and auction. */
function demoPanel() {
  if (!C.DEV_LOCAL || !C.KEEPER_CONTROL) return "";
  const next = nextDeadline(), dis = S.busy ? "disabled" : "";
  return `<section class="acct-sec demo"><h3 class="h3">Demo controls · local only</h3><div class="acct-acts">
    <button class="btn btn-2 sm danger" data-act="dev-crash" ${dis}>Drop NEAR 50%</button><button class="btn btn-2 sm" data-act="dev-live" ${dis}>Live price</button>
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
      if (a === "dev-crash") { const usd = Math.round((S.price?.price ?? 0) * 50) / 100; if (!(usd > 0)) throw new Error("no price yet"); await C.devControl(`/price?usd=${usd}`); toast(`NEAR is held at $${usd.toFixed(2)} on the sandbox. Nothing happens until the next price check.`); }
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
  if (a === "net") return void C.setNetwork(el.dataset.v as C.Net);
  if (a === "xchain") { S.xChain = el.dataset.v!; return render(); }
  if (a === "xcopy" && S.xDep) { await navigator.clipboard.writeText(S.xDep.address).catch(() => undefined); S.xCopied = Date.now(); render(); setTimeout(render, 1600); return; }
  if (a === "xreset") { S.xDep = null; saveX(); return render(); }
  if (a === "xdeposit") {
    const ch = X.CHAINS.find((c) => c.id === S.xChain)!;
    S.xBusy = true; render();
    try {
      const d = await X.depositTo(ch, safe(() => toUsdc(S.lendAmt || "0"), 0n), S.xRefund.trim(), C.CFG.pool, C.account!, S.tranche === "junior" ? "junior" : "senior");
      S.xDep = { ...d, status: "PENDING_DEPOSIT", tranche: S.tranche };
      saveX(); pollDeposit(d.address);
    } catch (err) { toast(`Couldn't get a deposit address: ${(err as Error).message}`); }
    S.xBusy = false; return render();
  }
  if (a === "val-open") {
    S.valOpen = !S.valOpen; S.valActive = Math.max(0, S.vals.findIndex((v) => v.id === S.validator)); render();
    if (S.valOpen) { $<HTMLElement>(`#vp-${S.valActive}`)?.focus(); if (!S.vals.length) await loadValidators(); C.validatorDetails(() => { pickFair(); render(); }); }
    return;
  }
  if (a === "val-pick") { S.validator = el.dataset.v!; S.valTouched = true; S.valOpen = false; render(); return $<HTMLElement>(".vp-btn")?.focus(); }
  if (a === "stake-max") { S.stake = nearIn(maxStake()); return render(); }
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
document.addEventListener("toggle", (e) => {
  const d = e.target as HTMLElement;
  if (d.matches?.("[data-details]")) S.details = (d as HTMLDetailsElement).open;
  if (d.matches?.("[data-xc]")) { const o = (d as HTMLDetailsElement).open; if (S.xOpen[S.tab] === o) return; S.xOpen[S.tab] = o; if (o) { ensureQuote(); render(); } }
}, true);
$("#wallet").addEventListener("click", () => (C.account ? C.disconnect() : C.connect()));
document.addEventListener("input", (e) => {
  const t = e.target as HTMLInputElement;
  if (t.id !== "stake" && t.id !== "lamt") return;
  const pos = t.selectionStart;
  if (t.id === "stake") S.stake = t.value; else S.lendAmt = t.value;
  render();
  const n = $<HTMLInputElement>("#" + t.id); n?.focus(); if (pos !== null) n?.setSelectionRange(pos, pos);
});
document.addEventListener("change", (e) => { const t = e.target as HTMLInputElement; if (t.id === "val" && t.value.trim()) { S.validator = t.value.trim(); S.valTouched = true; S.valOpen = false; render(); } });
// validator list: arrow keys move, Enter picks, Escape closes; a click outside closes it
document.addEventListener("keydown", (e) => {
  if (!S.valOpen || (e.target as HTMLElement).id === "val") { if (S.valOpen && e.key === "Escape") { S.valOpen = false; render(); $<HTMLElement>(".vp-btn")?.focus(); } return; }
  if (e.key === "Escape") { S.valOpen = false; render(); $<HTMLElement>(".vp-btn")?.focus(); e.preventDefault(); return; }
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault(); S.valActive = Math.max(0, Math.min(S.vals.length - 1, S.valActive + (e.key === "ArrowDown" ? 1 : -1)));
    render(); $<HTMLElement>(`#vp-${S.valActive}`)?.focus();
  }
});
document.addEventListener("pointerdown", (e) => { if (S.valOpen && !(e.target as HTMLElement).closest(".vp")) { S.valOpen = false; render(); } });
/** Once fees are known: default to the largest eligible validator at 10% fee or less, unless the borrower chose one. */
function pickFair() {
  if (S.valTouched) return;
  const cur = S.vals.find((v) => v.id === S.validator);
  if (cur && (cur.feePct === undefined || (cur.feePct !== null && cur.feePct <= 10 && cur.eligible !== false))) return;
  const fair = S.vals.find((v) => v.eligible && v.feePct != null && v.feePct <= 10); if (fair) S.validator = fair.id;
}
let valLoading = false;
async function loadValidators() {
  if (valLoading || S.vals.length) return; valLoading = true;
  try { S.vals = await C.validators(); pickFair(); } catch { /* the typed field still works */ }
  valLoading = false; render();
}
addEventListener("hashchange", () => { S.tab = tabFromHash(); render(); });
S.tab = tabFromHash();
C.onWallet(load);
if (C.KEEPER_URL) { const k = async () => { keeper = await C.keeperStatus(); softRender(); }; k(); setInterval(k, 30_000); }
// Countdowns tick locally; chain state refreshes every 15 s (never mid-typing).
setInterval(() => document.querySelectorAll<HTMLElement>("[data-deadline]").forEach((n) => (n.textContent = left(Number(n.dataset.deadline)))), 30_000);
setInterval(() => { if (C.configured() && !S.busy && !document.hidden) refresh(); }, C.DEV_LOCAL ? 8_000 : 20_000);
let refreshing = false;
async function refresh() {
  if (refreshing) return; refreshing = true;
  try { await load(true); } finally { refreshing = false; }
}
C.onWallet(() => { resumeX([]); });
C.restore().then(async () => {
  const outs = await C.outcomesFromUrl().catch(() => []);
  await resumeX(outs.filter((o) => o.ok && o.hash).map((o) => o.hash!));
  if (outs.length) toasts.push(outs.map((o) => judge(o, { receiverId: "", methodName: "", args: {}, gas: 0n, deposit: 0n }, { doing: "", done: "Done. The chain confirmed it." })).find((s) => s.kind === "error") ?? { kind: "ok", title: "Done. The chain confirmed it.", hash: outs[0]?.hash });
  await load();
  loadValidators(); // one RPC call; details wait until the list is opened
});
render();
// Dev server only (stripped from builds): lets a design review drive states the chain can't produce on demand.
if (import.meta.env.DEV) Object.assign(window, { __ank: { S, render, viewAs: C.devViewAs, saveX } });

/** Follow a cross-chain deposit until it lands or is refunded; reload the pool when it lands. */
/** Cross-chain transfers survive a reload: kept per network and account until they end or are dismissed. */
const XKEY = () => `ankora.xfer.v1.${C.NET}.${C.account ?? "-"}`;
function saveX() {
  try {
    if (!C.account) return;
    const keep = { dep: S.xDep, out: S.out.dep, outPending: S.outPending };
    if (!keep.dep && !keep.out && !keep.outPending) localStorage.removeItem(XKEY()); else localStorage.setItem(XKEY(), JSON.stringify(keep));
  } catch { /* private mode: nothing to resume */ }
}
const X_END = /SUCCESS|REFUNDED|FAILED/;
/** A deposit address older than its quote deadline must not receive funds. */
const expired = (d: { status: string; deadline: string }) => d.status === "PENDING_DEPOSIT" && Date.now() > Date.parse(d.deadline);
const X_TOAST: Record<string, (out: boolean) => Status> = {
  SUCCESS: (out) => ({ kind: "ok", title: out ? "Your USDC arrived on the other chain." : "Your cross-chain deposit is in the pool." }),
  REFUNDED: (out) => ({ kind: "error", title: out ? "The transfer was refunded to your NEAR wallet." : "The deposit was refunded to your address.", body: "Nothing was lost but the network fees." }),
  FAILED: (out) => ({ kind: "error", title: "NEAR Intents couldn't complete the transfer.", body: out ? "The USDC is refunded to your NEAR wallet." : "The USDC is refunded to the address you gave." }),
  INCOMPLETE_DEPOSIT: () => ({ kind: "error", title: "Less USDC arrived than the quote needs.", body: "NEAR Intents refunds it to the address you gave." }),
};
/** Follow a transfer until it lands, is refunded or its address expires. `out`: the send-out direction. */
function pollX(out: boolean, address: string) {
  const cur = () => (out ? S.out.dep : S.xDep);
  const tick = async () => {
    const d = cur();
    if (d?.address !== address) return;
    if (expired(d)) { render(); return; } // the card says not to send; no point polling an address 1Click retired
    try {
      const r = await X.depositStatus(address);
      const now = cur();
      if (now?.address !== address) return;
      const was = now.status; now.status = r.status; now.nearTx = r.nearTx ?? now.nearTx;
      if (r.status !== was) {
        saveX();
        const t = X_TOAST[r.status]?.(out);
        if (t) toasts.push(t);
        if (r.status === "SUCCESS" && !out) await load(); else render();
      }
      if (X_END.test(r.status)) return;
    } catch { /* keep polling */ }
    setTimeout(tick, 5000);
  };
  setTimeout(tick, 2500);
}
const pollDeposit = (address: string) => pollX(false, address);
const pollOut = (address: string) => pollX(true, address);
/** On load (and after a wallet redirect): bring back unfinished transfers and keep following them. */
async function resumeX(redirectHashes: string[]) {
  if (!C.MAINNET_NET || !C.account) return;
  let saved: { dep?: typeof S.xDep; out?: typeof S.out.dep; outPending?: typeof S.outPending } | null = null;
  try { saved = JSON.parse(localStorage.getItem(XKEY()) ?? "null"); } catch { /* ignore */ }
  if (!saved) return;
  if (saved.dep && !S.xDep) { S.xDep = saved.dep; S.xOpen.lend = true; if (!X_END.test(saved.dep.status)) pollDeposit(saved.dep.address); }
  if (saved.out && !S.out.dep) { S.out.dep = saved.out; S.out.open = true; if (!X_END.test(saved.out.status)) pollOut(saved.out.address); }
  // A send-out signed through a redirecting wallet: the route was saved before the wallet opened.
  if (saved.outPending && !S.out.dep) {
    const p = saved.outPending;
    if (redirectHashes.length) { S.out.dep = { ...p, status: "KNOWN_DEPOSIT_TX" }; S.out.open = true; X.submitTx(redirectHashes[0]!, p.address); pollOut(p.address); }
    S.outPending = null;
  }
  saveX(); render();
}
document.addEventListener("input", (e) => { const t = e.target as HTMLInputElement; if (t.id === "xrefund") { S.xRefund = t.value; softRender(); } }, true);

// ---------- USDC out to another chain (mainnet): withdrawals and loan payouts land in the NEAR wallet first ----------
const OUT_KEYS = { quote: "" };
let outQ = { key: "", state: "idle" as "idle" | "ok" | "err", out: 0, secs: 0 };
function sendOutBox() {
  const o = S.out, ch = X.CHAINS.find((c) => c.id === o.chain) ?? X.CHAINS[0]!;
  const d = o.dep;
  if (d) {
    const done = d.status === "SUCCESS", bad = /REFUNDED|FAILED|INCOMPLETE/.test(d.status);
    const to = X.CHAINS.find((c) => c.id === d.chain) ?? ch;
    return `<div class="xd xo ${done ? "is-ok" : bad ? "is-bad" : ""}">
      ${xSteps(d.status, ["Sent from NEAR", "Bridging", `On ${to.label}`])}
      <div class="xd-foot"><span aria-live="polite">${esc(X_STATUS_OUT[d.status] ?? d.status)}: <b class="num">${Number(d.amountIn).toFixed(2)}</b> USDC to ${to.label}${d.nearTx ? ` · <a href="${EXPLORER(d.nearTx)}" target="_blank" rel="noopener">NEAR transaction</a>` : ""}</span>
        <span>${done || bad ? `<button class="inline-link" data-act="out-reset">Send more</button>` : `About ${d.secs} s`}</span></div></div>`;
  }
  const amt = safe(() => toUsdc(o.amt || "0"), 0n);
  const addr = o.to.trim(), okTo = X.validAddress(ch, addr);
  const qk = `out:${ch.id}:${amt}`;
  const out = amt === 0n ? 0 : outQ.key === qk ? (outQ.state === "ok" ? outQ.out : outQ.state === "err" ? NaN : null) : null;
  const why = amt === 0n ? "Enter an amount" : amt > S.usdcBal ? "More than your USDC" : !okTo ? `Add the ${ch.label} address` : S.nearBal < 10n ** 22n ? "Needs 0.01 NEAR for the fee" : "";
  return `<div class="xo-box">
    <p class="xo-h">Send USDC to another chain</p>
    ${chainChips("out-chain", ch.id)}
    <div class="xo-row"><input id="out-amt" class="input num" inputmode="decimal" placeholder="0" value="${esc(o.amt)}" autocomplete="off" aria-label="Amount in USDC"><span class="unit">USDC</span><button class="bal" data-act="out-max">Max <span class="num">${usdc(S.usdcBal)}</span></button></div>
    <label class="xd-in"><span>To, on ${ch.label}</span><input id="out-to" class="input ${addr && !okTo ? "is-bad" : ""}" placeholder="${ch.id === "sol" ? "Solana address" : "0x…"}" value="${esc(o.to)}" autocomplete="off" spellcheck="false" aria-invalid="${!!addr && !okTo}"></label>
    ${addr && !okTo ? `<p class="xd-err">That isn't a ${ch.label} address.</p>` : ""}
    ${amt > 0n ? routeCard(usdc(amt), NEAR_SIDE, ch, out, outQ.secs) : ""}
    <button class="btn ${why ? "btn-2" : "btn-1"} xd-go" data-act="${why ? "noop" : "out-send"}" ${why || o.busy || S.busy ? "disabled" : ""}>${o.busy ? "Getting a route…" : why || `Send to ${ch.label}`}</button>
    <p class="xc-note">One approval: registers a one-time NEAR Intents address (0.00125 NEAR) and sends. Refunds return to ${esc(C.account ?? "")}.</p></div>`;
}
const X_STATUS_OUT: Record<string, string> = {
  PENDING_DEPOSIT: "Waiting for the transfer", KNOWN_DEPOSIT_TX: "Transfer seen, confirming", PROCESSING: "Moving to the other chain",
  SUCCESS: "Arrived", INCOMPLETE_DEPOSIT: "Less than quoted arrived: it will be refunded", REFUNDED: "Refunded to your NEAR wallet", FAILED: "Failed: refunded to your NEAR wallet",
};
/** Keep a live quote for the send-out box as its chain or amount changes. */
function ensureOutQuote() {
  if (!S.out.open || S.out.dep) return;
  const ch = X.CHAINS.find((c) => c.id === S.out.chain) ?? X.CHAINS[0]!;
  const amt = safe(() => toUsdc(S.out.amt || "0"), 0n);
  const key = `out:${ch.id}:${amt}`;
  if (amt === 0n || outQ.key === key || OUT_KEYS.quote === key) return;
  OUT_KEYS.quote = key;
  X.quote(ch, amt, false).then((r) => { outQ = { key, state: "ok", out: r.out, secs: r.secs }; render(); }).catch(() => { outQ = { key, state: "err", out: 0, secs: 0 }; render(); }).finally(() => { OUT_KEYS.quote = ""; });
}
document.addEventListener("input", (e) => {
  const t = e.target as HTMLInputElement;
  if (t.id === "out-amt") { S.out.amt = t.value; softRender(); ensureOutQuote(); }
  if (t.id === "out-to") { S.out.to = t.value; softRender(); }
}, true);
document.addEventListener("click", async (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-act]"); if (!el || (el as HTMLButtonElement).disabled) return;
  const a = el.dataset.act;
  if (a === "out-open") { S.out.open = !S.out.open; render(); return ensureOutQuote(); }
  if (a === "out-chain") { S.out.chain = el.dataset.v!; render(); return ensureOutQuote(); }
  if (a === "out-max") { S.out.amt = (Number(S.usdcBal) / 1e6).toFixed(6).replace(/\.?0+$/, ""); render(); return ensureOutQuote(); }
  if (a === "out-reset") { S.out.dep = null; S.out.amt = ""; saveX(); return render(); }
  if (a === "out-send") {
    const ch = X.CHAINS.find((c) => c.id === S.out.chain)!;
    const amt = safe(() => toUsdc(S.out.amt || "0"), 0n);
    S.out.busy = true; render();
    let route: X.SendOut;
    try { route = await X.sendOut(ch, amt, S.out.to.trim(), C.account!); }
    catch (err) { S.out.busy = false; toast(`Couldn't get a route: ${(err as Error).message}`); return render(); }
    S.out.busy = false;
    S.outPending = route; saveX(); // a redirecting wallet reloads the page: resumeX picks this up
    const usdcId = C.CFG.usdc;
    const st = await run([
      { receiverId: usdcId, methodName: "storage_deposit", args: { account_id: route.address, registration_only: true }, gas: 10_000_000_000_000n, deposit: 1_250_000_000_000_000_000_000n },
      { receiverId: usdcId, methodName: "ft_transfer", args: { receiver_id: route.address, amount: amt.toString(), memo: "ankora: to another chain" }, gas: 20_000_000_000_000n, deposit: 1n },
    ], { doing: `Sending ${usdc(amt)} USDC to ${ch.label}.`, done: "Sent. NEAR Intents is moving it now." });
    S.outPending = null;
    if (st.kind === "ok") {
      S.out.dep = { ...route, status: "KNOWN_DEPOSIT_TX" };
      if (st.hash) X.submitTx(st.hash, route.address);
      pollOut(route.address);
    }
    saveX(); render();
  }
}, true);
