// A full Ankora stack on a local NEAR sandbox, so the app runs end to end before testnet exists.
//
//   (cd contracts && ./build.sh) && npm run local
//
// Starts near-sandbox (the binary the Rust sandbox tests already fetched, or NEAR_SANDBOX_BIN_PATH), deploys the
// test-clock pool, test USDC + price relay, a whitelist and a staking pool, seeds both tranches, relays the live
// mainnet NEAR/USD every 10 s, writes app/.env.local, and serves a dev control API on :8090:
//   GET  /status                 keeper-style status (the app's relay badge)
//   POST /advance?secs=86400     move the pool's and the relay's clocks together (demo notice, grace, auction)
//   POST /settle?id=0            settle a loan now
// The app signs as `judge.<root>` with VITE_DEV_KEY: local only, never on testnet. Ctrl-C stops everything.
import { InMemoryKeyStore, Near } from "near-kit";
import { Sandbox } from "near-kit/sandbox";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MAINNET, NEAR_USD_ID } from "../src/config.ts";
import { keeperHealth, type KeeperState } from "../src/keeper.ts";
import { Ema, parsePythPrice } from "../src/oracle.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const wasm = (dir: string, name = dir) => readFileSync(join(root, "contracts/target/near", dir, `${name}.wasm`));
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const U = 1_000_000n;

function sandboxBinary(): string | undefined {
  if (process.env.NEAR_SANDBOX_BIN_PATH) return process.env.NEAR_SANDBOX_BIN_PATH;
  const build = join(root, "contracts/target/debug/build");
  if (!existsSync(build)) return undefined;
  for (const d of readdirSync(build).filter((x) => x.startsWith("near-sandbox-"))) {
    const near = join(build, d, "out/.near");
    if (!existsSync(near)) continue;
    for (const v of readdirSync(near)) {
      const bin = join(near, v, "near-sandbox");
      if (existsSync(bin)) return bin;
    }
  }
  return undefined;
}

async function main() {
  const bin = sandboxBinary();
  if (!bin) throw new Error("no near-sandbox binary: run `cargo test -p ankora-pool --test flow` once, or set NEAR_SANDBOX_BIN_PATH");
  const sb = await Sandbox.start({ binaryPath: bin, detached: false });
  const rootId = sb.rootAccount.id;
  const id = (n: string) => `${n}.${rootId}`;
  const [usdc, wl, validator, pool, judge] = ["usdc", "whitelist", "validator", "pool", "judge"].map(id) as [string, string, string, string, string];
  // Every local account carries the root key, so one keystore signs for all of them.
  const sk = sb.rootAccount.secretKey;
  const keyStore = new InMemoryKeyStore(Object.fromEntries([rootId, usdc, wl, validator, pool, judge].map((a) => [a, sk])));
  const near = new Near({ network: sb, keyStore, defaultSignerId: rootId });
  const pub = (await near.getAccessKeys(rootId)).keys[0]!.public_key;
  for (const [acct, bal] of [[usdc, "100 NEAR"], [wl, "20 NEAR"], [validator, "20 NEAR"], [pool, "50 NEAR"], [judge, "20000 NEAR"]] as const) {
    await near.transaction(rootId).createAccount(acct).transfer(acct, bal).addKey(pub, { type: "fullAccess" }).send();
  }
  const mocks = wasm("ankora_mocks");
  for (const m of [usdc, wl, validator]) await near.transaction(m).deployContract(m, mocks).functionCall(m, "new", {}, { gas: "30 Tgas" }).send();
  await near.transaction(pool).deployContract(pool, wasm("ankora_pool_testclock", "ankora_pool"))
    .functionCall(pool, "new", { owner: usdc, usdc, pyth: usdc, price_id: NEAR_USD_ID, whitelist: wl }, { gas: "30 Tgas" }).send();
  const call = (signer: string, c: string, m: string, args: object, deposit = "0 yocto", gas = "30 Tgas") =>
    near.transaction(signer).functionCall(c, m, args, { gas: gas as `${number} Tgas`, attachedDeposit: deposit as never }).send();
  await call(wl, wl, "add_staking_pool", { staking_pool_account_id: validator });

  // Live mainnet price, stamped with the sandbox's own clock (the relay sets publish time to now when none is given).
  const mainnet = new Near({ network: "mainnet", rpcUrl: MAINNET.rpc });
  const ema = new Ema(3600);
  const state: KeeperState = { startedAt: Math.floor(Date.now() / 1000), lastPushAt: 0, lastPublishTime: 0 };
  const push = async () => {
    const src = parsePythPrice(await mainnet.view(MAINNET.priceSource, "get_price_no_older_than", { price_id: NEAR_USD_ID, age: 600 }));
    if (!src) return log("no mainnet price; keeping the last one");
    ema.update(src.price, src.publishTime);
    await call(usdc, usdc, "set_prices", { spot: src.price.toString(), ema: ema.value.toString(), conf: src.conf.toString() });
    state.lastPushAt = state.lastPublishTime = Math.floor(Date.now() / 1000);
  };
  await push();

  // Lenders: 3,000 First-loss + 17,000 Fixed. The judge gets 5,000 test USDC to repay and lend with.
  await call(usdc, usdc, "mint", { account_id: usdc, amount: (20_000n * U).toString() });
  for (const [tr, amt] of [["junior", 3_000n], ["senior", 17_000n]] as const) {
    await call(usdc, usdc, "ft_transfer_call", { receiver_id: pool, amount: (amt * U).toString(), msg: JSON.stringify({ deposit: tr }) }, "1 yocto", "200 Tgas");
  }
  await call(usdc, usdc, "mint", { account_id: judge, amount: (5_000n * U).toString() });

  const envFile = join(root, "app/.env.local");
  writeFileSync(envFile, [
    "# Written by client/bin/local-chain.ts: a LOCAL sandbox, not testnet. Delete this file to go back to testnet.",
    `VITE_RPC=${sb.rpcUrl}`, `VITE_POOL=${pool}`, `VITE_RELAY=${usdc}`, `VITE_USDC=${usdc}`, `VITE_FAUCET=${usdc}`,
    `VITE_VALIDATOR=${validator}`, "VITE_KEEPER_URL=http://localhost:8090",
    `VITE_DEV_ACCOUNT=${judge}`, `VITE_DEV_KEY=${sb.rootAccount.secretKey}`, "",
  ].join("\n"));

  createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("content-type", "application/json");
    try {
      if (u.pathname === "/status") return res.end(JSON.stringify({ ...keeperHealth(state, Math.floor(Date.now() / 1000)), relay: usdc, pool, local: true }));
      if (req.method === "POST" && u.pathname === "/advance") {
        const secs = Number(u.searchParams.get("secs") ?? 0);
        await call(usdc, pool, "test_advance_clock", { secs });
        await call(usdc, usdc, "advance_clock", { secs });
        await push();
        return res.end(JSON.stringify({ advanced: secs }));
      }
      if (req.method === "POST" && u.pathname === "/settle") {
        const o = await call(usdc, pool, "settle", { id: Number(u.searchParams.get("id") ?? 0) }, "0 yocto", "100 Tgas");
        const v = (o as { status?: { SuccessValue?: string } }).status?.SuccessValue;
        return res.end(JSON.stringify({ outcome: v ? JSON.parse(Buffer.from(v, "base64").toString()) : null }));
      }
      if (req.method === "OPTIONS") { res.setHeader("access-control-allow-methods", "GET, POST"); return res.end(); }
      res.statusCode = 404; res.end("{}");
    } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: (e as Error).message.slice(0, 300) })); }
  }).listen(8090);

  setInterval(() => push().catch((e) => log("price push failed:", (e as Error).message.slice(0, 120))), 10_000);
  log(`local chain at ${sb.rpcUrl}: pool ${pool}, USDC + relay ${usdc}, validator ${validator}, judge ${judge}`);
  log(`app/.env.local written; dev control on http://localhost:8090. Ctrl-C to stop.`);
  const stop = async () => { await sb.stop(); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e) => { console.error("✗", (e as Error).message); process.exit(1); });
