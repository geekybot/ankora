import { describe, expect, it } from "vitest";
import { allLoans, dueForSettle, keeperHealth, relayDecision } from "../src/keeper.ts";
import type { LoanView } from "../src/pool.ts";

const loan = (id: number, state: string, deadline: number): LoanView => ({
  id, borrower: "b.testnet", vault: `v${id}.pool.testnet`, validator: "kiln.pool.f863973.m0", collateral: "0", debt: "0", plan: "P40",
  term_interest: "0", term_start: 0, expiry: deadline, auto_renew: true, state, auction_price: "0", deadline,
});

describe("settle keeper", () => {
  it("settles loans whose deadline has passed, in any open state", () => {
    const loans = [loan(0, "Active", 100), loan(1, "Notice", 100), loan(2, "Grace", 100), loan(3, "Auction", 100)];
    expect(dueForSettle(loans, 100)).toEqual([0, 1, 2, 3]);
  });
  it("leaves loans alone before their deadline", () => {
    expect(dueForSettle([loan(0, "Active", 101)], 100)).toEqual([]);
  });
  it("never touches closed or defaulted loans", () => {
    expect(dueForSettle([loan(0, "Closed", 0), loan(1, "Defaulted", 0)], 100)).toEqual([]);
  });
});

describe("price relay", () => {
  const src = { price: 355_500_672n, conf: 380_995n, expo: -8, publishTime: 1_000 };
  it("pushes a newer, fresh source price", () => {
    expect(relayDecision(src, 990, 1_010)).toEqual({ push: true });
  });
  it("skips a price it already pushed", () => {
    expect(relayDecision(src, 1_000, 1_010)).toEqual({ push: false, why: "not newer" });
  });
  it("never relays a stale source: the pool would refuse it anyway", () => {
    expect(relayDecision(src, 0, 1_091)).toEqual({ push: false, why: "source stale" });
  });
  it("skips when the source has no price", () => {
    expect(relayDecision(null, 0, 1_000)).toEqual({ push: false, why: "no source price" });
  });
});

describe("keeper health", () => {
  const started = 1_000;
  it("is healthy right after a push", () => {
    expect(keeperHealth({ startedAt: started, lastPushAt: 1_200, lastPublishTime: 1_190 }, 1_230)).toEqual({ ok: true, relayPriceAgeSecs: 40, secsSincePush: 30 });
  });
  it("gives a fresh process two minutes before calling it unhealthy", () => {
    expect(keeperHealth({ startedAt: started, lastPushAt: 0, lastPublishTime: 0 }, started + 119).ok).toBe(true);
    expect(keeperHealth({ startedAt: started, lastPushAt: 0, lastPublishTime: 0 }, started + 121).ok).toBe(false);
  });
  it("is unhealthy after two minutes without a push, so the host restarts it", () => {
    const h = keeperHealth({ startedAt: started, lastPushAt: 1_200, lastPublishTime: 1_190 }, 1_321);
    expect(h).toEqual({ ok: false, relayPriceAgeSecs: 131, secsSincePush: 121 });
  });
});

describe("all loans", () => {
  it("pages past the first 100, because closed loans stay in the map", async () => {
    const all = Array.from({ length: 250 }, (_, i) => loan(i, i < 240 ? "Closed" : "Active", 100));
    const calls: number[] = [];
    const got = await allLoans(async (from, limit) => { calls.push(from); return all.slice(from, from + limit); });
    expect(got.length).toBe(250);
    expect(calls).toEqual([0, 100, 200]);
    expect(dueForSettle(got, 100)).toEqual([240, 241, 242, 243, 244, 245, 246, 247, 248, 249]);
  });
});

describe("relay at 90 s", () => {
  it("still relays a source price 75 s old", () => {
    expect(relayDecision({ price: 1n, conf: 0n, expo: -8, publishTime: 1_000 }, 0, 1_075)).toEqual({ push: true });
  });
});
