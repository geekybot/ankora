// Testnet deploy, seed and smoke borrow. Idempotent: every step checks chain state first, so a failed run can be rerun.
//
//   ANKORA_RELAY=<you>-mocks.testnet ANKORA_POOL=<you>-ankora.testnet npm run deploy:testnet
//   CHECK_ONLY=1 ...                         # read-only preflight, sends nothing
//
// Accounts must already exist, with keys in ~/.near-credentials/testnet/ (the founder creates them:
// `cargo near create-dev-account use-specific-account-id <id> autogenerate-new-keypair save-to-legacy-keychain network-config testnet create`).
// Build first: contracts/build.sh. The relay account owns the pool, the relay and test USDC; the keeper signs as it.
import { Near } from "near-kit";
import { FileKeyStore } from "near-kit/keys/file";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { MAINNET, NEAR_USD_ID, TESTNET } from "../src/config.ts";
import { MAX_PRICE_AGE_SECS, parsePythPrice, priceAge } from "../src/oracle.ts";
import { actions, views, type Action, type LoanView } from "../src/pool.ts";
import { NEAR, NORMAL, maxPrincipal, quoteBorrow } from "../src/quote.ts";

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (!v) throw new Error(`set ${k}`);
  return v;
};
const RELAY = env("ANKORA_RELAY");
const POOL = env("ANKORA_POOL");
const VALIDATOR = env("ANKORA_VALIDATOR", TESTNET.exampleValidator);
const CHECK_ONLY = process.env.CHECK_ONLY === "1";
const SMOKE_STAKE = BigInt(Math.round(Number(env("SMOKE_STAKE_NEAR", "3.5")) * 1000)) * NEAR / 1000n; // >= 3.5: borrow needs 5 NEAR attached
const U = 1_000_000n;

const near = new Near({ network: "testnet", rpcUrl: TESTNET.rpc, keyStore: new FileKeyStore(`${homedir()}/.near-credentials`, "testnet") });
const mainnet = new Near({ network: "mainnet", rpcUrl: MAINNET.rpc });
const pool = views(near as never, POOL);
const act = actions({ pool: POOL, usdc: RELAY });

const log = (...a: unknown[]) => console.log("•", ...a);
const wasm = (dir: string) => readFileSync(fileURLToPath(new URL(`../../contracts/target/near/${dir}/${dir}.wasm`, import.meta.url)));
const logsOf = (o: unknown): string[] =>
  ((o as { receipts_outcome?: { outcome: { logs: string[] } }[] }).receipts_outcome ?? []).flatMap((r) => r.outcome.logs);

async function send(signer: string, a: Action): Promise<string[]> {
  const o = await near.transaction(signer)
    .functionCall(a.receiverId, a.methodName, a.args, { gas: `${Number(a.gas / 1_000_000_000_000n)} Tgas`, attachedDeposit: `${a.deposit} yocto` })
    .send();
  return logsOf(o);
}

async function pushPrice(): Promise<void> {
  const src = parsePythPrice(await mainnet.view(MAINNET.priceSource, "get_price_no_older_than", { price_id: NEAR_USD_ID, age: MAX_PRICE_AGE_SECS }));
  if (!src) throw new Error(`${MAINNET.priceSource} has no NEAR/USD inside 60 s; retry in a minute`);
  const now = Math.floor(Date.now() / 1000);
  await send(RELAY, {
    receiverId: RELAY, methodName: "set_prices",
    args: { spot: src.price.toString(), ema: src.price.toString(), conf: src.conf.toString(), publish_time: src.publishTime },
    gas: 10_000_000_000_000n, deposit: 0n,
  });
  log(`price relayed: ${Number(src.price) / 1e8} USD, ${priceAge(src, now)} s old at source`);
}

async function main() {
  // 1. Preflight: accounts, keys, balances, build, whitelist.
  for (const [id, min] of [[RELAY, 8], [POOL, 5]] as const) {
    if (!(await near.accountExists(id))) throw new Error(`${id} does not exist on testnet: create it first (see header)`);
    const s = await near.getAccount(id);
    log(`${id}: ${s.balance} NEAR, contract ${s.hasContract ? "deployed" : "none"}`);
    if (!s.hasContract && Number(s.balance) < min) throw new Error(`${id} needs about ${min} NEAR before deploy`);
  }
  const poolWasm = wasm("ankora_pool");
  if (Buffer.from(poolWasm).includes("test_advance_clock")) throw new Error("target/near/ankora_pool is the test-clock build: rerun contracts/build.sh");
  if ((await near.view<boolean>(TESTNET.whitelist, "is_whitelisted", { staking_pool_account_id: VALIDATOR })) !== true)
    throw new Error(`${VALIDATOR} is not on ${TESTNET.whitelist}`);
  log(`validator ${VALIDATOR} is whitelisted`);
  if (CHECK_ONLY) return log("CHECK_ONLY: preflight passed, nothing sent");

  // 2. Relay + test USDC, then the pool. Deploy and init in one transaction each.
  if (!(await near.getAccount(RELAY)).hasContract) {
    await near.transaction(RELAY).deployContract(RELAY, wasm("ankora_mocks")).functionCall(RELAY, "new", {}, { gas: "30 Tgas" }).send();
    log("relay + test USDC deployed");
  }
  if (!(await near.getAccount(POOL)).hasContract) {
    await near.transaction(POOL).deployContract(POOL, poolWasm)
      .functionCall(POOL, "new", { owner: RELAY, usdc: RELAY, pyth: RELAY, price_id: NEAR_USD_ID, whitelist: TESTNET.whitelist }, { gas: "30 Tgas" })
      .send();
    log("pool deployed");
  }

  // 3. Seed lenders: 3,000 First-loss and 17,000 Fixed (15% junior cover, the contract minimum).
  if (BigInt((await pool.ledger()).junior_shares) === 0n) {
    await send(RELAY, { receiverId: RELAY, methodName: "mint", args: { account_id: RELAY, amount: (20_000n * U).toString() }, gas: 10_000_000_000_000n, deposit: 0n });
    await send(RELAY, act.deposit("junior", 3_000n * U));
    await send(RELAY, act.deposit("senior", 17_000n * U));
    log("seeded 3,000 First-loss + 17,000 Fixed test USDC");
  }
  const ledger = await pool.ledger();
  log(`ledger: cash ${Number(ledger.cash) / 1e6} USDC, NAV ${Number(ledger.nav) / 1e6}, utilisation ${ledger.utilisation_bps / 100}%`);

  // 4. Smoke borrow against NEAR staked with a real testnet validator: the first untested integration.
  let loans: LoanView[] = await pool.loans(0, 10);
  if (loans.length === 0) {
    await pushPrice();
    const src = parsePythPrice(await near.view(RELAY, "get_price_no_older_than", { price_id: NEAR_USD_ID, age: MAX_PRICE_AGE_SECS }));
    if (!src) throw new Error("relay price is stale right after the push");
    const price = { price: src.price, expo: src.expo };
    const principal = maxPrincipal(SMOKE_STAKE, price, 3000) * 9n / 10n;
    const q = quoteBorrow({ stakeYocto: SMOKE_STAKE, principal, plan: "P30", price, menu: NORMAL });
    log(`borrowing ${Number(principal) / 1e6} USDC on P30 against ${Number(SMOKE_STAKE * 1000n / NEAR) / 1000} NEAR (LTV ${q.ltvBps / 100}%)`);
    const logs = await send(RELAY, act.borrow({ validator: VALIDATOR, principal, plan: "P30", stakeYocto: SMOKE_STAKE }));
    for (const l of logs) log(`  log: ${l}`);
    loans = await pool.loans(0, 10);
    if (loans.length === 0) throw new Error("borrow did not book a loan: see the logs above");
  }
  const l = loans[0]!;
  const staked = await near.view<string>(l.validator, "get_account_staked_balance", { account_id: l.vault });
  log(`loan ${l.id}: ${l.state}, debt ${Number(l.debt) / 1e6} USDC, vault ${l.vault} has ${Number(BigInt(staked ?? "0") * 1000n / NEAR) / 1000} NEAR staked with ${l.validator}, next price check ${new Date(l.deadline * 1000).toISOString()}`);
  log("done. Start the keeper: ANKORA_RELAY=... ANKORA_POOL=... npm run keeper");
}

main().catch((e) => { console.error("✗", (e as Error).message); process.exit(1); });
