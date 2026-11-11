// Live mainnet reads (no keys, no writes). Run with `npm run test:live`.
import { Near } from "near-kit";
import { describe, expect, it } from "vitest";
import { MAINNET, NEAR_USD_ID } from "../src/config.ts";
import { parsePythPrice, priceAge } from "../src/oracle.ts";

const live = process.env.LIVE === "1";
const near = new Near({ network: "mainnet", rpcUrl: MAINNET.rpc });
const now = () => Math.floor(Date.now() / 1000);

describe.skipIf(!live)("mainnet price source", () => {
  it("aggregate-oracle.near serves a fresh NEAR/USD in Pyth's shape", async () => {
    const p = parsePythPrice(await near.view(MAINNET.priceSource, "get_price_no_older_than", { price_id: NEAR_USD_ID, age: 60 }));
    expect(p, "no price inside 60 s").not.toBeNull();
    expect(p!.expo).toBe(-8);
    expect(p!.price > 0n).toBe(true);
    expect(priceAge(p!, now())).toBeLessThanOrEqual(60);
  }, 30_000);

  it("pyth-oracle.near is still stale for NEAR/USD (flip the relay plan if this fails)", async () => {
    const p = parsePythPrice(await near.view(MAINNET.pythLegacy, "get_price_unsafe", { price_identifier: NEAR_USD_ID }));
    expect(p === null || priceAge(p, now()) > 30 * 86_400).toBe(true);
  }, 30_000);
});
