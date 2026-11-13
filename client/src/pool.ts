// Pool views and wallet-agnostic actions. An `Action` is one function call; Wallet Selector's
// `signAndSendTransaction({ receiverId, actions: [{ type: "FunctionCall", params }] })` and near-kit both take this shape.
import { NEAR_USD_ID } from "./config.ts";
import { VAULT_RESERVE, type PlanName } from "./quote.ts";

const TGAS = 1_000_000_000_000n;
const MIN_DEPOSIT = 10_000_000n; // contract: 10 USDC
const FAUCET_CAP = 1_000_000_000n; // test USDC faucet: 1,000 USDC per call

export type Tranche = "senior" | "junior";
export interface Action { receiverId: string; methodName: string; args: Record<string, unknown>; gas: bigint; deposit: bigint }

export interface LoanView {
  id: number; borrower: string; vault: string; validator: string; collateral: string; debt: string; plan: string;
  term_interest: string; term_start: number; expiry: number; auto_renew: boolean;
  state: "Active" | "Notice" | "Grace" | "Auction" | "Closed" | "Defaulted" | string;
  auction_price: string;
  /** When the next settle can act: term end, notice/grace end, auction end; 0 once closed. */
  deadline: number;
}
export interface LedgerView {
  cash: string; outstanding: string; unearned: string; treasury: string; reserved: string; nav: string;
  senior_value: string; junior_value: string; senior_shares: string; junior_shares: string; utilisation_bps: number;
}
export interface LenderView { senior_shares: string; junior_shares: string; junior_unlocks_at: number }
/** One auction from start to end. outcome: live, sold, repaid (the borrower stopped it) or no_buyer. */
export interface AuctionRecord {
  id: number; started_at: number; start_value: string; debt: string; collateral: string; validator: string;
  outcome: "live" | "sold" | "repaid" | "no_buyer" | string; ended_at: number; price: string; buyer: string | null; surplus: string;
}
export interface PlanView { plan: PlanName; ltv_cap_bps: number; term_secs: number; rate_bps: number }

export function actions(c: { pool: string; usdc: string }) {
  const call = (methodName: string, args: Record<string, unknown>, tgas: bigint, deposit = 0n): Action =>
    ({ receiverId: c.pool, methodName, args, gas: tgas * TGAS, deposit });
  const ftCall = (amount: bigint, msg: object): Action => ({
    receiverId: c.usdc, methodName: "ft_transfer_call",
    args: { receiver_id: c.pool, amount: amount.toString(), msg: JSON.stringify(msg) },
    gas: 100n * TGAS, deposit: 1n,
  });
  return {
    /** NEAR attached = stake + 1.5 NEAR vault reserve. The pool reads the price itself; no price push needed. */
    borrow: (b: { validator: string; principal: bigint; plan: PlanName; stakeYocto: bigint }): Action =>
      call("borrow", { validator: b.validator, principal: b.principal.toString(), plan: b.plan }, 230n, b.stakeYocto + VAULT_RESERVE),
    deposit: (tranche: Tranche, amount: bigint): Action => {
      if (amount < MIN_DEPOSIT) throw new Error("minimum deposit is 10 USDC");
      return ftCall(amount, { deposit: tranche });
    },
    repay: (id: number, amount: bigint): Action => ftCall(amount, { repay: id }),
    bid: (id: number, amount: bigint): Action => ftCall(amount, { bid: id }),
    settle: (id: number): Action => call("settle", { id }, 100n),
    setAutoRenew: (id: number, on: boolean): Action => call("set_auto_renew", { id, on }, 10n, 1n),
    withdraw: (tranche: Tranche, shares: bigint): Action => call("withdraw", { tranche, shares: shares.toString() }, 50n, 1n),
    claim: (): Action => call("claim", {}, 50n, 1n),
    /** Test USDC faucet (the mock's `mint`): testnet only. */
    mint: (account: string, amount: bigint): Action => {
      if (amount > FAUCET_CAP) throw new Error("faucet gives at most 1,000 USDC per call");
      return { receiverId: c.usdc, methodName: "mint", args: { account_id: account, amount: amount.toString() }, gas: 10n * TGAS, deposit: 0n };
    },
  };
}

/** The borrower's own vault after repay: its NEAR is still staked. Unstake, wait 4 epochs (~28 h), withdraw, transfer out. */
export function vaultActions(vault: string) {
  const call = (methodName: string, args: Record<string, unknown>, tgas: bigint): Action => ({ receiverId: vault, methodName, args, gas: tgas * TGAS, deposit: 1n });
  return {
    unstakeAll: () => call("unstake_all", {}, 100n),
    withdrawAll: () => call("withdraw_all", {}, 100n),
    transfer: (to: string, yocto: bigint) => call("transfer", { to, amount: yocto.toString() }, 30n),
  };
}

export interface VaultInfo { pool: string; borrower: string; validator: string; owner: string; released: boolean; staked: string }
export interface RawPrice { price: string; conf: string; expo: number; publish_time: number }

/** Anything that can run a view call: near-kit's `Near#view` fits. */
export interface Viewer { view<T>(contractId: string, method: string, args?: object, options?: { finality: "optimistic" | "final" }): Promise<T> }
/** Optimistic reads: finalised state trails the latest transactions by a couple of blocks, so a screen re-read
 *  right after the user's own transaction would otherwise show the old balance or loan state. */
const OPT = { finality: "optimistic" } as const;

export function views(v: Viewer, pool: string, more: { usdc?: string; relay?: string } = {}) {
  return {
    ledger: () => v.view<LedgerView>(pool, "get_ledger", {}, OPT),
    loan: (id: number) => v.view<LoanView | null>(pool, "get_loan", { id }, OPT),
    loans: (fromIndex = 0, limit = 100) => v.view<LoanView[]>(pool, "get_loans", { from_index: fromIndex, limit }, OPT),
    lender: (accountId: string) => v.view<LenderView | null>(pool, "get_lender", { account_id: accountId }, OPT),
    plans: () => v.view<PlanView[]>(pool, "get_plans", {}, OPT),
    claimable: (accountId: string) => v.view<string>(pool, "get_claimable", { account_id: accountId }, OPT),
    /** Newest first. Pools deployed before auction records existed answer with an error: callers treat that as none. */
    auctionHistory: (from = 0, limit = 10) => v.view<AuctionRecord[]>(pool, "get_auction_history", { from_index: from, limit }, OPT),
    usdcBalance: (accountId: string) => v.view<string>(need(more.usdc, "usdc"), "ft_balance_of", { account_id: accountId }, OPT),
    vaultInfo: (vault: string) => v.view<VaultInfo | null>(vault, "get_info", {}, OPT),
    /** After repay: transfer `transferable` now; `unstaked` becomes withdrawable when `canWithdraw` (about 4 epochs after unstake). */
    vaultBalances: async (vault: string, validator: string) => {
      const transferable = await v.view<string>(vault, "get_transferable", {}, OPT);
      const acct = await v.view<{ unstaked_balance: string; staked_balance: string; can_withdraw: boolean } | null>(validator, "get_account", { account_id: vault }, OPT);
      return { transferable: BigInt(transferable ?? "0"), staked: BigInt(acct?.staked_balance ?? "0"), unstaked: BigInt(acct?.unstaked_balance ?? "0"), canWithdraw: acct?.can_withdraw ?? false };
    },
    /** Spot and EMA as the pool will read them, up to 10 minutes old, so the app can show age and the breaker state. */
    relayPrice: async () => {
      const r = need(more.relay, "relay");
      const spot = await v.view<RawPrice | null>(r, "get_price_no_older_than", { price_id: NEAR_USD_ID, age: 600 }, OPT);
      const ema = await v.view<RawPrice | null>(r, "get_ema_price_no_older_than", { price_id: NEAR_USD_ID, age: 600 }, OPT);
      return { spot, ema };
    },
  };
}

const need = (x: string | undefined, k: string): string => { if (!x) throw new Error(`views: pass { ${k} }`); return x; };
