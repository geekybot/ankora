// Chain access for the app. Everything contract-shaped comes from client/ (@ankora/client); this file only
// wires it to a reader, the connected wallet and the testnet accounts (TESTNET_STUB until deploy, .env.local overrides).
import { InMemoryKeyStore, Near, fromHotConnect } from "near-kit";
import { NearConnector } from "@hot-labs/near-connect";
import { actions, views, vaultActions, type Action, type LoanView, type PlanView, type VaultInfo, type RawPrice } from "../../client/src/pool.ts";
import { parsePythPrice, priceAge, collateralPrice, type SourcePrice } from "../../client/src/oracle.ts";
import { allLoans as pagedLoans } from "../../client/src/keeper.ts";
import { TESTNET_STUB, type AnkoraConfig } from "../../client/src/config.ts";

const env = (k: string) => (import.meta.env[k] as string | undefined) || undefined;
export const CFG: AnkoraConfig = {
  ...TESTNET_STUB,
  pool: env("VITE_POOL") ?? TESTNET_STUB.pool,
  usdc: env("VITE_USDC") ?? env("VITE_RELAY") ?? TESTNET_STUB.usdc,
  relay: env("VITE_RELAY") ?? TESTNET_STUB.relay,
  faucet: env("VITE_FAUCET") ?? env("VITE_RELAY") ?? TESTNET_STUB.faucet,
  validator: env("VITE_VALIDATOR") ?? TESTNET_STUB.validator,
  rpc: env("VITE_RPC") ?? TESTNET_STUB.rpc,
};
/** Local sandbox only (client/bin/local-chain.ts): sign as a dev account with a key from .env.local, no wallet. */
const DEV_ACCOUNT = env("VITE_DEV_ACCOUNT");
const DEV_KEY = env("VITE_DEV_KEY");
export const DEV_LOCAL = !!(DEV_ACCOUNT && DEV_KEY);
export const KEEPER_CONTROL = DEV_LOCAL ? env("VITE_KEEPER_URL") : undefined;
/** False while the app still points at TESTNET_STUB (nothing deployed there). */
export const configured = () => CFG.pool !== TESTNET_STUB.pool;

/** App-side gate before asking the wallet: tighter than the pool's 90 s so the transaction lands in time. */
export const QUOTE_MAX_AGE_SECS = 75; // pool limit 90 s minus ~15 s for the wallet round trip and inclusion
export const QUOTE_MAX_GAP_BPS = 300;
/** Quote below the plan cap so a small price move between quote and inclusion doesn't cancel the borrow. */
export const QUOTE_CAP_SHARE_BPS = 9700n;

// Reads try the configured RPC first and fall back to NEAR's own RPC: one rate-limited provider must not take the app down.
const RPCS = DEV_LOCAL ? [CFG.rpc] : [CFG.rpc, "https://rpc.testnet.near.org"];
// No retry on the primary: a refused call should fail over at once, not back off for seconds.
const readers = RPCS.map((rpcUrl, i) => new Near({ network: "testnet", rpcUrl, retryConfig: { maxRetries: i === 0 ? 0 : 1, initialDelayMs: 300 } }));
let live = 0;
async function firstOk<T>(f: (n: Near) => Promise<T>): Promise<T> {
  let err: unknown;
  for (let k = 0; k < readers.length; k++) {
    const i = (live + k) % readers.length;
    try { const v = await f(readers[i]!); live = i; return v; } catch (e) { err = e; if (live === i) live = (i + 1) % readers.length; if (/panicked|MethodNotFound|CodeDoesNotExist|does not exist|ExecutionError|UNKNOWN_ACCOUNT/i.test(String((e as Error)?.message ?? e))) throw e; }
  }
  throw err;
}
const reader = {
  view: <T,>(c: string, m: string, a: object = {}, o?: object) => firstOk((n) => n.view<T>(c, m, a, o as never)),
  getBalance: (id: string) => firstOk((n) => n.getBalance(id)),
};
/** A raw JSON-RPC call with the same fallback. */
export const rpc = (body: object) => firstOk(async () => {
  for (const u of RPCS.slice(live).concat(RPCS.slice(0, live))) {
    try { const r = await fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); if (r.ok) return r.json(); } catch { /* next */ }
  }
  throw new Error("Failed to fetch");
});
export const pool = views(reader as never, CFG.pool, { usdc: CFG.usdc, relay: CFG.relay });
export const act = actions({ pool: CFG.pool, usdc: CFG.usdc });
export const vault = vaultActions;
export type { LoanView, PlanView, Action, VaultInfo };

// ---------- wallet ----------
const connector = new NearConnector({ network: "testnet", footerBranding: null });
let signer: Near | null = null;
export let account: string | null = null;
const listeners = new Set<() => void>();
export const onWallet = (f: () => void) => listeners.add(f);
const emit = () => listeners.forEach((f) => f());

function signedIn(id: string | undefined) {
  account = id ?? null;
  signer = id ? new Near({ network: "testnet", rpcUrl: CFG.rpc, wallet: fromHotConnect(connector) }) : null;
  emit();
}
connector.on("wallet:signIn", (e) => signedIn(e.accounts[0]?.accountId));
connector.on("wallet:signOut", () => signedIn(undefined));
export async function restore() {
  if (DEV_LOCAL) {
    account = DEV_ACCOUNT!;
    signer = new Near({ network: "testnet", rpcUrl: CFG.rpc, keyStore: new InMemoryKeyStore({ [DEV_ACCOUNT!]: DEV_KEY! }), defaultSignerId: DEV_ACCOUNT });
    return emit();
  }
  try { const c = await connector.getConnectedWallet(); signedIn(c.accounts[0]?.accountId); } catch { /* not connected */ }
}
export const connect = () => connector.connect().catch(() => undefined);
export const disconnect = () => connector.disconnect().catch(() => undefined);

// ---------- outcomes ----------
export interface Outcome { hash?: string; ok: boolean; value?: unknown; logs: string[]; failure?: string; failures: string[] }
/** The panic text inside a receipt or transaction failure, if any. */
const panicOf = (f: unknown): string => {
  const j = JSON.stringify(f ?? "");
  return /"panic_msg":"((?:[^"\\]|\\.)*)"/.exec(j)?.[1] ?? /Smart contract panicked: ([^"]+)/.exec(j)?.[1] ?? j.slice(0, 240);
};
/** Read a FinalExecutionOutcome (from the wallet, or from RPC after a redirect). */
export function readOutcome(o: any): Outcome {
  const logs: string[] = [...(o?.transaction_outcome?.outcome?.logs ?? []), ...(o?.receipts_outcome ?? []).flatMap((r: any) => r?.outcome?.logs ?? [])];
  const st = o?.status ?? {};
  const failures: string[] = (o?.receipts_outcome ?? []).map((r: any) => r?.outcome?.status?.Failure).filter(Boolean).map(panicOf);
  if (st.Failure) return { hash: o?.transaction?.hash, ok: false, logs, failure: panicOf(st.Failure), failures };
  let value: unknown;
  if (typeof st.SuccessValue === "string" && st.SuccessValue) { try { value = JSON.parse(atob(st.SuccessValue)); } catch { value = atob(st.SuccessValue); } }
  return { hash: o?.transaction?.hash, ok: true, value, logs, failures };
}
/** After a wallet redirect (`?transactionHashes=`), fetch each outcome from RPC. */
export async function outcomesFromUrl(): Promise<Outcome[]> {
  const q = new URLSearchParams(location.search), hashes = q.get("transactionHashes");
  if (!hashes || !account) return [];
  history.replaceState(null, "", location.pathname + location.hash);
  return Promise.all(hashes.split(",").map(async (h) => {
    const r = await rpc({ jsonrpc: "2.0", id: 1, method: "tx", params: { tx_hash: h, sender_account_id: account, wait_until: "EXECUTED_OPTIMISTIC" } });
    return r.result ? { ...readOutcome(r.result), hash: h } : { hash: h, ok: false, logs: [], failures: [], failure: String(r.error?.data ?? "Not found") };
  }));
}

/** Sign and send one Action; returns what the chain said. */
export async function send(a: Action): Promise<Outcome> {
  if (!signer || !account) throw new Error("Connect a wallet first.");
  const res = await signer.transaction(account)
    .functionCall(a.receiverId, a.methodName, a.args, { gas: `${Number(a.gas / 1_000_000_000_000n)} Tgas`, attachedDeposit: `${a.deposit} yocto` })
    .send({ waitUntil: "FINAL" });
  return readOutcome(res);
}

// ---------- reads ----------
export const nearBalance = async (id: string): Promise<bigint> => {
  const b = String(await reader.getBalance(id)); // near-kit returns NEAR as a decimal string
  const [i, f = ""] = b.split(".");
  return BigInt(i || "0") * 10n ** 24n + BigInt((f + "0".repeat(24)).slice(0, 24) || "0");
};
export const usdcBalance = async (id: string): Promise<bigint> => BigInt((await pool.usdcBalance(id)) ?? "0");
export const allLoans = (): Promise<LoanView[]> => pagedLoans(pool.loans);
const owners = new Map<string, string>();
export type MyVault = VaultInfo & { vault: string; loanId: number; transferable: bigint; stakedNow: bigint; unstaked: bigint; canWithdraw: boolean };
/** Vaults the borrower got back after repaying: NEAR still staked until they unstake and withdraw. */
export async function myVaults(loans: LoanView[], id: string): Promise<MyVault[]> {
  // A closed loan's vault belongs to its borrower after repay, or to the winning bidder after an auction.
  const closed = loans.filter((l) => l.state === "Closed");
  const out = await Promise.all(closed.map(async (l) => {
    // A released vault's owner does not change, so ask once per vault and remember who owns it.
    if (owners.has(l.vault) && owners.get(l.vault) !== id) return null;
    const info = await pool.vaultInfo(l.vault).catch(() => null);
    if (info?.released) owners.set(l.vault, info.owner);
    if (!info?.released || info.owner !== id) return null;
    const b = await pool.vaultBalances(l.vault, info.validator).catch(() => null);
    if (!b) return null;
    return { ...info, vault: l.vault, loanId: l.id, transferable: b.transferable, stakedNow: b.staked, unstaked: b.unstaked, canWithdraw: b.canWithdraw };
  }));
  return out.filter((x): x is MyVault => !!x && (x.stakedNow > 0n || x.unstaked > 0n || x.transferable > 0n));
}

/** Chain time. On the local sandbox the pool's and relay's clocks can be moved ahead, so ask the relay; elsewhere it's wall time. */
let clockOffset = 0;
export const nowSecs = () => Math.floor(Date.now() / 1000) + clockOffset;
export async function syncClock() {
  const t = await reader.view<number>(CFG.relay, "now_secs", {}).catch(() => undefined);
  if (typeof t === "number") clockOffset = t - Math.floor(Date.now() / 1000);
}

export interface PriceRead {
  ok: boolean; fresh: boolean; price: number; priceRaw?: bigint; expo?: number; ageSecs: number; gapBps: number; reason?: string;
}
const fromRaw = (r: RawPrice | null): SourcePrice | null => (r ? parsePythPrice(r) : null);
/** The price a new loan would use (lower of spot and EMA) plus the app's freshness and breaker gate. */
export async function readPrice(): Promise<PriceRead> {
  const { spot: s, ema: e } = await pool.relayPrice();
  if (DEV_LOCAL) await syncClock();
  const spot = fromRaw(s), ema = fromRaw(e), now = nowSecs();
  const age = spot ? priceAge(spot, now) : Infinity;
  const sv = spot ? Number(spot.price) * 10 ** spot.expo : 0, ev = ema ? Number(ema.price) * 10 ** ema.expo : 0;
  const gapBps = sv && ev ? Math.round((Math.abs(sv - ev) / sv) * 10_000) : Infinity; // |spot − EMA| / spot, per client/
  const c = collateralPrice(spot, ema, now, true);
  if (!c.ok) return { ok: false, fresh: false, price: sv, ageSecs: age, gapBps, reason: c.error };
  const fresh = age <= QUOTE_MAX_AGE_SECS && gapBps <= QUOTE_MAX_GAP_BPS;
  return { ok: true, fresh, price: Number(c.price) * 10 ** c.expo, priceRaw: c.price, expo: c.expo, ageSecs: age, gapBps };
}

/** Local sandbox only: move the pool's and relay's clocks, or settle a loan, through the dev control server. */
export async function devControl(path: string): Promise<string> {
  if (!KEEPER_CONTROL) throw new Error("No dev control server.");
  const r = await fetch(KEEPER_CONTROL.replace(/\/$/, "") + path, { method: "POST" });
  const t = await r.text();
  if (!r.ok) throw new Error(t || `HTTP ${r.status}`);
  return t;
}

/** Keeper health badge; hidden when VITE_KEEPER_URL is unset. */
export const KEEPER_URL = env("VITE_KEEPER_URL");
export async function keeperStatus(): Promise<{ ok: boolean; relayPriceAgeSecs: number | null; secsSincePush: number } | null> {
  if (!KEEPER_URL) return null;
  try { return await fetch(KEEPER_URL.replace(/\/$/, "") + "/status", { cache: "no-store" }).then((r) => r.json()); } catch { return { ok: false, relayPriceAgeSecs: null, secsSincePush: Infinity }; }
}

/** Test USDC faucet: the mock token's open `mint`, capped at 1,000 per call. */
export const faucet = (id: string, usdc: bigint): Action => ({ ...act.mint(id, usdc), receiverId: CFG.faucet });

// ---------- validators a vault can stake with ----------
/** eligible: on the lockup whitelist (undefined until checked). feePct: reward fee (undefined until checked, null if unknown). */
export interface ValidatorRow { id: string; sharePct: number; feePct?: number | null; eligible?: boolean }
const WHITELIST = DEV_LOCAL ? null : "whitelist.f863973.m0";
const VKEY = `ankora.validators.v2.${CFG.pool}`;
let validatorCache: ValidatorRow[] | null = null;
const save = () => { try { localStorage.setItem(VKEY, JSON.stringify({ at: Date.now(), rows: validatorCache })); } catch { /* private mode */ } };
/** The 10 largest current validators by stake, from one RPC call; stored for 6 hours. Details come later. */
export async function validators(): Promise<ValidatorRow[]> {
  if (validatorCache) return validatorCache;
  try { const c = JSON.parse(localStorage.getItem(VKEY) ?? "null"); if (c && Date.now() - c.at < 6 * 3600_000 && c.rows?.length) return (validatorCache = c.rows); } catch { /* ignore */ }
  const r = await rpc({ jsonrpc: "2.0", id: 1, method: "validators", params: [null] });
  const cur: { account_id: string; stake: string }[] = r?.result?.current_validators ?? [];
  const total = cur.reduce((s, v) => s + Number(BigInt(v.stake) / 10n ** 18n), 0) || 1;
  validatorCache = cur.map((v) => ({ id: v.account_id, sharePct: Number(BigInt(v.stake) / 10n ** 18n) / total * 100 }))
    .sort((a, b) => b.sharePct - a.sharePct).slice(0, 10);
  save();
  return validatorCache;
}
let detailing = false;
/** Whitelist status and fee for each stored row, two calls at a time; onUpdate re-renders as rows fill in. */
export async function validatorDetails(onUpdate: () => void): Promise<void> {
  if (detailing || !validatorCache) return; detailing = true;
  const todo = validatorCache.filter((v) => v.eligible === undefined);
  for (let i = 0; i < todo.length; i += 2) {
    await Promise.all(todo.slice(i, i + 2).map(async (v) => {
      v.eligible = WHITELIST ? await reader.view<boolean>(WHITELIST, "is_whitelisted", { staking_pool_account_id: v.id }).catch(() => false) === true : true;
      if (v.eligible) { const f = await reader.view<{ numerator: number; denominator: number }>(v.id, "get_reward_fee_fraction", {}).catch(() => null); v.feePct = f && f.denominator ? f.numerator / f.denominator * 100 : null; }
    }));
    onUpdate();
  }
  save(); detailing = false;
}
