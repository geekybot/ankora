// Mirrors ankora-core (contracts/ankora-core/src/{math,plans}.rs) in BigInt, so a quote in the app is exactly
// what the contract will compute. USDC has 6 decimals, NEAR is yocto (1e24), prices carry a negative exponent.

export const NEAR = 10n ** 24n;
/** Attached on top of the stake; pays the per-loan vault's storage (contract: VAULT_RESERVE). */
export const VAULT_RESERVE = 1_500_000_000_000_000_000_000_000n;
export const BPS = 10_000n;
export const YEAR_SECS = 31_536_000n;
export const FEE_BPS = 500n;
const U32_MAX = 4_294_967_295;
const DAY = 86_400;

export type PlanName = "P30" | "P40" | "P50";
export interface Plan { plan: PlanName; ltvCapBps: number; termSecs: number; rateBps: number }
export interface Price { price: bigint; expo: number }

const menu = (rows: [PlanName, number, number, number][]): Plan[] =>
  rows.map(([plan, ltvCapBps, days, rateBps]) => ({ plan, ltvCapBps, termSecs: days * DAY, rateBps }));
/** Contract menu. The app should prefer `get_plans` from the pool, which also says which menu is live. */
export const NORMAL = menu([["P30", 3000, 30, 970], ["P40", 4000, 14, 1010], ["P50", 5000, 7, 1130]]);
export const STRESSED = menu([["P30", 3000, 14, 970], ["P40", 4000, 7, 1010], ["P50", 5000, 3, 1170]]);

export function collateralValueUsdc(yocto: bigint, price: bigint, expo: number): bigint {
  if (price <= 0n) throw new Error("price must be positive");
  if (expo >= 0) throw new Error("expo must be negative");
  return (yocto / 10n ** 18n) * price / 10n ** BigInt(-expo);
}

export function ltvBps(debt: bigint, value: bigint): number {
  if (value === 0n) return U32_MAX;
  const l = debt * BPS / value;
  return l > BigInt(U32_MAX) ? U32_MAX : Number(l);
}

export const interest = (debt: bigint, rateBps: number, termSecs: number): bigint =>
  debt * BigInt(rateBps) * BigInt(termSecs) / (BPS * YEAR_SECS);
export const fee = (i: bigint): bigint => i * FEE_BPS / BPS;

/** Safest plan whose cap covers the LTV; none above 50%. Same order as `plan_for_ltv`. */
export const planFor = (ltv: number, plans: Plan[]): Plan | undefined => plans.find((p) => ltv <= p.ltvCapBps);

/** Largest principal whose LTV stays inside `capBps`. */
export const maxPrincipal = (collateralYocto: bigint, px: Price, capBps: number): bigint =>
  BigInt(capBps) * collateralValueUsdc(collateralYocto, px.price, px.expo) / BPS;

export interface BorrowQuote {
  ok: boolean; reason?: string; plan: Plan; attachedYocto: bigint; valueUsdc: bigint; ltvBps: number; termInterest: bigint; payout: bigint;
}

/** What `borrow` will do with this stake and principal at this collateral price (the lower of spot and EMA). */
export function quoteBorrow(q: { stakeYocto: bigint; principal: bigint; plan: PlanName; price: Price; menu: Plan[] }): BorrowQuote {
  const plan = q.menu.find((p) => p.plan === q.plan);
  if (!plan) throw new Error(`unknown plan ${q.plan}`);
  const valueUsdc = collateralValueUsdc(q.stakeYocto, q.price.price, q.price.expo);
  const ltv = ltvBps(q.principal, valueUsdc);
  const termInterest = interest(q.principal, plan.rateBps, plan.termSecs);
  const base = { plan, attachedYocto: q.stakeYocto + VAULT_RESERVE, valueUsdc, ltvBps: ltv, termInterest, payout: q.principal - termInterest };
  if (q.principal <= 0n) return { ...base, ok: false, reason: "principal must be positive" };
  if (ltv > plan.ltvCapBps) return { ...base, ok: false, reason: "LTV above plan cap" };
  return { ...base, ok: true };
}

/** USDC to pay so the next `settle` renews: debt down to the 50% line. 0 when the loan already fits a plan. */
export function paydownToRenew(debt: bigint, collateralYocto: bigint, px: Price, topCapBps = 5000): bigint {
  const ceiling = maxPrincipal(collateralYocto, px, topCapBps);
  return debt > ceiling ? debt - ceiling : 0n;
}
