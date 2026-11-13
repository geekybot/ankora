// Deploys the capped mainnet pool. The founder runs this; it signs with keys from ~/.near-credentials/mainnet/.
//
//   npx tsx bin/deploy-mainnet.ts <pool-account> <owner-account>          # dry run: checks, prints the plan, sends nothing
//   npx tsx bin/deploy-mainnet.ts <pool-account> <owner-account> --send   # deploys
//
// <pool-account>: a fresh named account that holds only this contract (its key must be in the keystore).
// <owner-account>: books auction recoveries and can mark the market stressed. It holds no funds of the pool.
// The pool is built with `--features mainnet`: deposits capped at 200 USDC, loans at 100 USDC, 1 USDC minimum,
// spot-only price from Rhea's aggregate-oracle.near (Pyth's own NEAR feed stopped 2026-08-25).
import { Near } from "near-kit";
import { FileKeyStore } from "near-kit/keys/file";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { MAINNET, NEAR_USD_ID } from "../src/config.ts";

const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const [pool, owner, flag] = process.argv.slice(2);
if (!pool || !owner) throw new Error("usage: deploy-mainnet.ts <pool-account> <owner-account> [--send]");
const send = flag === "--send";
const wasm = readFileSync(fileURLToPath(new URL("../../contracts/target/near/ankora_pool_mainnet/ankora_pool.wasm", import.meta.url)));
const near = new Near({ network: "mainnet", rpcUrl: MAINNET.rpc, keyStore: new FileKeyStore(`${homedir()}/.near-credentials`, "mainnet") });
const log = (...a: unknown[]) => console.log(...a);

// --- checks, read-only ---
const bal = await near.getBalance(pool).catch(() => null);
if (bal === null) throw new Error(`${pool} does not exist on mainnet: create and fund it first`);
const needNear = wasm.length / 100_000 + 0.5; // 1 NEAR per 100 KB of storage, plus state and gas
log(`pool account   ${pool}: ${bal} NEAR (needs about ${needNear.toFixed(1)})`);
const acct = await (await fetch(MAINNET.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_account", finality: "final", account_id: pool } }) })).json() as { result?: { code_hash: string } };
const code = acct.result?.code_hash === "11111111111111111111111111111111" ? "no contract" : `has contract ${acct.result?.code_hash}`;
log(`pool contract  ${code}`);
log(`owner          ${owner}: ${await near.getBalance(owner).catch(() => "MISSING")}`);
const px = (await near.view<{ price: string; expo: number; publish_time: number }>(MAINNET.priceSource, "get_price_no_older_than", { price_id: NEAR_USD_ID, age: 90 }))!;
log(`price          $${(Number(px.price) * 10 ** px.expo).toFixed(4)} from ${MAINNET.priceSource}, ${Math.floor(Date.now() / 1000) - px.publish_time} s old`);
log(`whitelist      aurora.poolv1.near whitelisted: ${await near.view(MAINNET.lockupWhitelist, "is_whitelisted", { staking_pool_account_id: "aurora.poolv1.near" })}`);
log(`wasm           ${wasm.length} bytes, sha256 ${createHash("sha256").update(wasm).digest("hex")}`);
if (code !== "no contract") throw new Error("the pool account already has a contract: refusing to deploy over it");
if (Number(bal) < needNear) throw new Error(`fund ${pool} with at least ${needNear.toFixed(1)} NEAR first`);
if (!send) { log("\ndry run: nothing sent. Re-run with --send to deploy."); process.exit(0); }

// --- deploy, init, register the pool with USDC so it can receive ft_transfer_call ---
log("\ndeploying…");
await near.transaction(pool).deployContract(pool, wasm)
  .functionCall(pool, "new", { owner, usdc: USDC, pyth: MAINNET.priceSource, price_id: NEAR_USD_ID, whitelist: MAINNET.lockupWhitelist }, { gas: "30 Tgas" })
  .send();
await near.transaction(pool).functionCall(USDC, "storage_deposit", { account_id: pool, registration_only: true }, { gas: "30 Tgas", attachedDeposit: "0.00125 NEAR" }).send();
const retry = async <T,>(f: () => Promise<T>): Promise<T> => { for (let i = 0; ; i++) { try { return await f(); } catch (e) { if (i >= 9) throw e; await new Promise((r) => setTimeout(r, 1500)); } } };
const ledger = await retry(() => near.view<Record<string, string>>(pool, "get_ledger", {}));
const reg = await retry(() => near.view(USDC, "storage_balance_of", { account_id: pool }));
log("ledger", JSON.stringify(ledger));
log("USDC registration", JSON.stringify(reg));
log(`plans`, JSON.stringify(await near.view(pool, "get_plans", {})));
log(`\ndone: ${pool} is live. Explorer: https://nearblocks.io/address/${pool}`);
