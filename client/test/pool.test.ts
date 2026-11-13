// Action shapes the wallet signs. Gas, deposits and JSON keys must match the contract exactly.
import { describe, expect, it } from "vitest";
import { actions, vaultActions, views } from "../src/pool.ts";
import { NEAR_USD_ID, TESTNET_STUB } from "../src/config.ts";
import { NEAR, VAULT_RESERVE } from "../src/quote.ts";

const a = actions({ pool: "ankora.testnet", usdc: "usdc.testnet" });
const TGAS = 1_000_000_000_000n;

describe("pool actions", () => {
  it("borrow attaches the stake plus the vault reserve and 230 Tgas", () => {
    const x = a.borrow({ validator: "kiln.pool.f863973.m0", principal: 14_000_000_000n, plan: "P40", stakeYocto: 10_000n * NEAR });
    expect(x).toEqual({
      receiverId: "ankora.testnet", methodName: "borrow",
      args: { validator: "kiln.pool.f863973.m0", principal: "14000000000", plan: "P40" },
      gas: 230n * TGAS, deposit: 10_000n * NEAR + VAULT_RESERVE,
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

describe("app additions", () => {
  it("mints test USDC to the caller's account, capped at 1,000 USDC per call", () => {
    const x = a.mint("judge.testnet", 1_000_000_000n);
    expect(x).toMatchObject({ receiverId: "usdc.testnet", methodName: "mint", args: { account_id: "judge.testnet", amount: "1000000000" }, deposit: 0n });
    expect(() => a.mint("judge.testnet", 1_000_000_001n)).toThrow("faucet gives at most 1,000 USDC per call");
  });
  it("vault actions go to the loan's vault with 1 yoctoNEAR, so the wallet always asks", () => {
    const v = vaultActions("v0.ankora.testnet");
    expect(v.unstakeAll()).toEqual({ receiverId: "v0.ankora.testnet", methodName: "unstake_all", args: {}, gas: 100n * TGAS, deposit: 1n });
    expect(v.withdrawAll()).toMatchObject({ methodName: "withdraw_all", deposit: 1n });
    expect(v.transfer("me.testnet", 5n * NEAR).args).toEqual({ to: "me.testnet", amount: (5n * NEAR).toString() });
  });
  it("ships a testnet config stub with every key the app reads", () => {
    expect(Object.keys(TESTNET_STUB).sort()).toEqual(["faucet", "network", "pool", "relay", "rpc", "usdc", "validator"]);
  });
});

describe("views for the app", () => {
  const seen: [string, string, object][] = [];
  const v = views({ view: async (c, m, args) => { seen.push([c, m, args ?? {}]); return null as never; } }, "pool.testnet", { usdc: "usdc.testnet", relay: "relay.testnet" });
  it("reads balances, vault info and both relay prices from the right contracts", async () => {
    await v.usdcBalance("me.testnet");
    await v.vaultInfo("v0.pool.testnet");
    await v.relayPrice();
    expect(seen).toEqual([
      ["usdc.testnet", "ft_balance_of", { account_id: "me.testnet" }],
      ["v0.pool.testnet", "get_info", {}],
      ["relay.testnet", "get_price_no_older_than", { price_id: NEAR_USD_ID, age: 600 }],
      ["relay.testnet", "get_ema_price_no_older_than", { price_id: NEAR_USD_ID, age: 600 }],
    ]);
  });
});

describe("vault balances", () => {
  it("combines what the vault can transfer now with the staking pool's own account view", async () => {
    const answers: Record<string, unknown> = {
      "v0.pool.testnet get_transferable": "2000",
      "kiln.pool.f863973.m0 get_account": { account_id: "v0.pool.testnet", unstaked_balance: "5", staked_balance: "7", can_withdraw: false },
    };
    const v = views({ view: async (c, m) => answers[`${c} ${m}`] as never }, "pool.testnet");
    expect(await v.vaultBalances("v0.pool.testnet", "kiln.pool.f863973.m0")).toEqual({ transferable: 2000n, staked: 7n, unstaked: 5n, canWithdraw: false });
  });
});
