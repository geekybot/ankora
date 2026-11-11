// Vectors come from ankora-core's Rust tests and formulas, so the app's numbers match what the contract will do.
import { describe, expect, it } from "vitest";
import {
  NEAR, VAULT_RESERVE, collateralValueUsdc, ltvBps, interest, fee, planFor, quoteBorrow, maxPrincipal, paydownToRenew, NORMAL, STRESSED,
} from "../src/quote.ts";

describe("contract maths, mirrored", () => {
  it("values 10,000 NEAR at $3.62 at 36,200 USDC", () => {
    expect(collateralValueUsdc(10_000n * NEAR, 362_000_000n, -8)).toBe(36_200_000_000n);
  });
  it("does not lose precision on 10M NEAR at $20", () => {
    expect(collateralValueUsdc(10_000_000n * NEAR, 2_000_000_000n, -8)).toBe(200_000_000_000_000n);
  });
  it("rounds LTV down in basis points, max when collateral is worthless", () => {
    expect(ltvBps(14_480_000_000n, 36_200_000_000n)).toBe(4000);
    expect(ltvBps(14_000_000_000n, 36_200_000_000n)).toBe(3867);
    expect(ltvBps(1n, 0n)).toBe(4_294_967_295);
  });
  it("charges simple interest rounded down, and a 5% fee on it", () => {
    const i = interest(14_480_000_000n, 1010, 14 * 86_400);
    expect(i).toBe(56_095_123n);
    expect(fee(i)).toBe(2_804_756n);
  });
});

describe("plans menu", () => {
  it("matches the contract: normal and stressed, stress only tightens", () => {
    expect(NORMAL.map((p) => [p.plan, p.ltvCapBps, p.termSecs / 86_400, p.rateBps])).toEqual([["P30", 3000, 30, 970], ["P40", 4000, 14, 1010], ["P50", 5000, 7, 1130]]);
    expect(STRESSED.map((p) => [p.plan, p.termSecs / 86_400, p.rateBps])).toEqual([["P30", 14, 970], ["P40", 7, 1010], ["P50", 3, 1170]]);
    for (const [n, s] of NORMAL.map((p, i) => [p, STRESSED[i]!] as const)) expect(s.rateBps).toBeGreaterThanOrEqual(n.rateBps);
  });
  it("picks the safest plan whose cap covers the LTV, none above 50%", () => {
    expect(planFor(2999, NORMAL)?.plan).toBe("P30");
    expect(planFor(3001, NORMAL)?.plan).toBe("P40");
    expect(planFor(5000, NORMAL)?.plan).toBe("P50");
    expect(planFor(5001, NORMAL)).toBeUndefined();
  });
});

describe("borrow quote", () => {
  const price = { price: 362_000_000n, expo: -8 };
  it("prepays the first term's interest out of the principal", () => {
    const q = quoteBorrow({ stakeYocto: 10_000n * NEAR, principal: 14_000_000_000n, plan: "P40", price, menu: NORMAL });
    expect(q.attachedYocto).toBe(10_000n * NEAR + VAULT_RESERVE);
    expect(q.ltvBps).toBe(3867);
    expect(q.termInterest).toBe(54_235_616n);
    expect(q.payout).toBe(14_000_000_000n - 54_235_616n);
    expect(q.ok).toBe(true);
  });
  // LTV rounds down in basis points (as on chain), so the edge is 14,483.62 USDC on 36,200.
  it("refuses a principal above the plan's cap, as the contract would", () => {
    const q = quoteBorrow({ stakeYocto: 10_000n * NEAR, principal: 14_484_000_000n, plan: "P40", price, menu: NORMAL });
    expect(q.ok).toBe(false);
    expect(q.reason).toBe("LTV above plan cap");
  });
  it("offers the largest principal that stays inside the cap", () => {
    const m = maxPrincipal(10_000n * NEAR, price, 3000);
    expect(m).toBe(10_860_000_000n);
    expect(quoteBorrow({ stakeYocto: 10_000n * NEAR, principal: m, plan: "P30", price, menu: NORMAL }).ok).toBe(true);
  });
});

describe("renewal notice", () => {
  it("asks for the paydown that brings the loan back to 50%", () => {
    expect(paydownToRenew(14_000_000_000n, 10_000n * NEAR, { price: 150_000_000n, expo: -8 })).toBe(6_500_000_000n);
  });
  it("asks for nothing when the loan already fits a plan", () => {
    expect(paydownToRenew(14_000_000_000n, 10_000n * NEAR, { price: 362_000_000n, expo: -8 })).toBe(0n);
  });
});
