import { describe, expect, it } from "vitest";
import { Ema, collateralPrice, priceAge } from "../src/oracle.ts";

const at = (price: bigint, publishTime: number, conf = 0n) => ({ price, conf, expo: -8, publishTime });

describe("relay EMA (about 1 hour, like Pyth's)", () => {
  it("stays put on a flat price", () => {
    const e = new Ema(3600);
    e.update(355_000_000n, 0);
    e.update(355_000_000n, 600);
    expect(e.value).toBe(355_000_000n);
  });
  it("moves 63% of a step after one time constant", () => {
    const e = new Ema(3600);
    e.update(300_000_000n, 0);
    e.update(400_000_000n, 3600);
    expect(Number(e.value)).toBeCloseTo(300_000_000 + 0.632 * 100_000_000, -5);
  });
  it("ignores samples that are not newer", () => {
    const e = new Ema(3600);
    e.update(300_000_000n, 100);
    e.update(900_000_000n, 100);
    e.update(900_000_000n, 50);
    expect(e.value).toBe(300_000_000n);
  });
});

describe("collateral price, mirrored from ankora-core", () => {
  const now = 1_000;
  it("uses the lower of spot and EMA", () => {
    expect(collateralPrice(at(362_000_000n, now), at(360_000_000n, now), now, true)).toEqual({ ok: true, price: 360_000_000n, expo: -8 });
  });
  it("refuses a price older than 60 seconds", () => {
    expect(collateralPrice(at(362_000_000n, now - 61), at(362_000_000n, now), now, true)).toEqual({ ok: false, error: "Stale" });
  });
  it("refuses a confidence band wider than 1%", () => {
    expect(collateralPrice(at(362_000_000n, now, 3_620_001n), at(362_000_000n, now), now, true)).toEqual({ ok: false, error: "WideConfidence" });
  });
  it("trips the breaker for new loans when spot and EMA differ by more than 3%, not for renewals", () => {
    expect(collateralPrice(at(362_000_000n, now), at(351_000_000n, now), now, true)).toEqual({ ok: false, error: "Breaker" });
    expect(collateralPrice(at(362_000_000n, now), at(351_000_000n, now), now, false)).toEqual({ ok: true, price: 351_000_000n, expo: -8 });
  });
  it("reports age so the app can wait for a fresh relay push", () => {
    expect(priceAge(at(1n, 940), 1_000)).toBe(60);
  });
});
