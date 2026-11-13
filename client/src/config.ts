// Addresses checked on chain 2026-11-11.
export const NEAR_USD_ID = "c415de8d2eba7db216527dff4b60e8f3a5311c740dadb233e13e12547e226750";

export const MAINNET = {
  /** Rhea's aggregate oracle: signed Pyth Pro payloads, reported about every 40 s. Pyth-shaped `get_price_no_older_than`; no EMA method. */
  priceSource: "aggregate-oracle.near",
  /** Dead for NEAR since the Pyth Core upgrade: last NEAR/USD publish 2026-08-25. Kept to detect a revival. */
  pythLegacy: "pyth-oracle.near",
  lockupWhitelist: "lockup-whitelist.near",
  rpc: "https://free.rpc.fastnear.com",
} as const;

export const TESTNET = {
  whitelist: "whitelist.f863973.m0",
  exampleValidator: "kiln.pool.f863973.m0",
  rpc: "https://test.rpc.fastnear.com",
} as const;

export interface AnkoraConfig { network: "testnet" | "mainnet"; rpc: string; pool: string; usdc: string; relay: string; faucet: string; validator: string }
/** Native USDC on NEAR mainnet (Circle). */
export const MAINNET_USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
/** The capped mainnet pool (`--features mainnet`). `pool` stays empty until it is deployed. No faucet: real USDC. */
export const MAINNET_APP: AnkoraConfig = {
  network: "mainnet", rpc: MAINNET.rpc, pool: "", usdc: MAINNET_USDC, relay: MAINNET.priceSource, faucet: "", validator: "aurora.poolv1.near",
};
/** Until the founder's accounts exist. Replace with the real ids after deploy. */
export const TESTNET_STUB: AnkoraConfig = {
  network: "testnet", rpc: TESTNET.rpc,
  pool: "ankora-stub.testnet", usdc: "ankora-mocks-stub.testnet", relay: "ankora-mocks-stub.testnet", faucet: "ankora-mocks-stub.testnet",
  validator: TESTNET.exampleValidator,
};
