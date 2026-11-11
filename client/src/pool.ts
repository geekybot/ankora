// Pool views and wallet-agnostic actions. An `Action` is one function call; Wallet Selector's
// `signAndSendTransaction({ receiverId, actions: [{ type: "FunctionCall", params }] })` and near-kit both take this shape.
import { VAULT_RESERVE, type PlanName } from "./quote.ts";

const TGAS = 1_000_000_000_000n;
const MIN_DEPOSIT = 10_000_000n; // contract: 10 USDC

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
      call("borrow", { validator: b.validator, principal: b.principal.toString(), plan: b.plan }, 300n, b.stakeYocto + VAULT_RESERVE),
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
  };
}

/** Anything that can run a view call: near-kit's `Near#view` fits. */
export interface Viewer { view<T>(contractId: string, method: string, args?: object): Promise<T> }

export function views(v: Viewer, pool: string) {
  return {
    ledger: () => v.view<LedgerView>(pool, "get_ledger", {}),
    loan: (id: number) => v.view<LoanView | null>(pool, "get_loan", { id }),
    loans: (fromIndex = 0, limit = 100) => v.view<LoanView[]>(pool, "get_loans", { from_index: fromIndex, limit }),
    lender: (accountId: string) => v.view<LenderView | null>(pool, "get_lender", { account_id: accountId }),
    plans: () => v.view<PlanView[]>(pool, "get_plans", {}),
    claimable: (accountId: string) => v.view<string>(pool, "get_claimable", { account_id: accountId }),
  };
}
