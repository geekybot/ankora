// Action shapes the wallet signs. Gas, deposits and JSON keys must match the contract exactly.
import { describe, expect, it } from "vitest";
import { actions } from "../src/pool.ts";
import { NEAR, VAULT_RESERVE } from "../src/quote.ts";

const a = actions({ pool: "ankora.testnet", usdc: "usdc.testnet" });
const TGAS = 1_000_000_000_000n;

describe("pool actions", () => {
  it("borrow attaches the stake plus the vault reserve and 300 Tgas", () => {
    const x = a.borrow({ validator: "kiln.pool.f863973.m0", principal: 14_000_000_000n, plan: "P40", stakeYocto: 10_000n * NEAR });
    expect(x).toEqual({
      receiverId: "ankora.testnet", methodName: "borrow",
      args: { validator: "kiln.pool.f863973.m0", principal: "14000000000", plan: "P40" },
      gas: 300n * TGAS, deposit: 10_000n * NEAR + VAULT_RESERVE,
    });
  });
  it("deposits go through USDC ft_transfer_call with a lowercase tranche", () => {
    const x = a.deposit("junior", 3_000_000_000n);
    expect(x.receiverId).toBe("usdc.testnet");
    expect(x.methodName).toBe("ft_transfer_call");
    expect(x.args).toEqual({ receiver_id: "ankora.testnet", amount: "3000000000", msg: '{"deposit":"junior"}' });
    expect(x.deposit).toBe(1n);
  });
  it("refuses deposits under the contract's 10 USDC minimum", () => {
    expect(() => a.deposit("senior", 9_999_999n)).toThrow("minimum deposit is 10 USDC");
  });
  it("repay and bid carry the loan id in the transfer message", () => {
    expect(a.repay(7, 250_000_000n).args).toEqual({ receiver_id: "ankora.testnet", amount: "250000000", msg: '{"repay":7}' });
    expect(a.bid(7, 1n).args.msg).toBe('{"bid":7}');
  });
  it("one-yocto guarded calls attach exactly 1 yoctoNEAR", () => {
    for (const x of [a.setAutoRenew(3, false), a.withdraw("senior", 5n), a.claim()]) expect(x.deposit).toBe(1n);
    expect(a.setAutoRenew(3, false).args).toEqual({ id: 3, on: false });
    expect(a.withdraw("senior", 5n).args).toEqual({ tranche: "senior", shares: "5" });
  });
  it("settle is open to anyone and needs no deposit", () => {
    expect(a.settle(3)).toMatchObject({ methodName: "settle", args: { id: 3 }, deposit: 0n });
  });
});
