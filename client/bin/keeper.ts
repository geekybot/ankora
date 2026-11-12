// Testnet keeper: (1) relays the mainnet NEAR/USD spot from aggregate-oracle.near into the testnet price relay with a
// 1-hour EMA, (2) calls `settle` on loans whose deadline has passed. It signs as the relay's owner.
//
//   ANKORA_RELAY=<you>-mocks.testnet ANKORA_POOL=<you>-ankora.testnet npm run keeper
//   DRY_RUN=1 npm run keeper      # read and decide, send nothing (no account needed)
//
// Keys: KEEPER_PRIVATE_KEY (ed25519:..., for a hosted container) or ~/.near-credentials/testnet/<account>.json
// (`cargo near create-dev-account ... save-to-legacy-keychain` writes it). GET /health on PORT (default 8080) answers
// 200 while relay pushes succeed and 503 after 2 minutes without one, so the host restarts the process.
import { InMemoryKeyStore, Near } from "near-kit";
import { FileKeyStore } from "near-kit/keys/file";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { MAINNET, NEAR_USD_ID, TESTNET } from "../src/config.ts";
import { allLoans, dueForSettle, keeperHealth, relayDecision, type KeeperState } from "../src/keeper.ts";
import { Ema, MAX_PRICE_AGE_SECS, parsePythPrice } from "../src/oracle.ts";
import { views, type Action } from "../src/pool.ts";

const DRY = process.env.DRY_RUN === "1";
const RELAY = process.env.ANKORA_RELAY ?? "";
const POOL = process.env.ANKORA_POOL ?? "";
const SIGNER = process.env.KEEPER_ACCOUNT ?? RELAY;
const PRICE_EVERY_MS = 5_000; // the source posts every ~25-57 s; the pool accepts prices up to 60 s old
const SETTLE_EVERY_MS = 60_000;
if (!DRY && (!RELAY || !POOL)) throw new Error("set ANKORA_RELAY and ANKORA_POOL (or DRY_RUN=1)");

const STATE_FILE = process.env.KEEPER_STATE_FILE ?? ".keeper-state.json";
const mainnets = [MAINNET.rpc, "https://rpc.mainnet.near.org"].map((rpcUrl) => new Near({ network: "mainnet", rpcUrl }));
const withTimeout = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, no) => setTimeout(() => no(new Error(`timeout ${ms} ms`)), ms))]);
/** Primary RPC first, then the fallback; a hung free-tier request must not stall the loop. */
async function sourceView(method: string, args: object): Promise<unknown> {
  let last: unknown;
  for (const n of mainnets) {
    try { return await withTimeout(n.view(MAINNET.priceSource, method, args), 8_000); } catch (e) { last = e; }
  }
  throw last;
}
const testnet = new Near({
  network: "testnet", rpcUrl: TESTNET.rpc,
  ...(DRY ? {} : {
    keyStore: process.env.KEEPER_PRIVATE_KEY
      ? new InMemoryKeyStore({ [SIGNER]: process.env.KEEPER_PRIVATE_KEY })
      : new FileKeyStore(`${homedir()}/.near-credentials`, "testnet"),
    defaultSignerId: SIGNER,
  }),
});
const now = () => Math.floor(Date.now() / 1000);
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const send = async (a: Action) => {
  if (DRY) return log("dry-run:", a.receiverId, a.methodName, JSON.stringify(a.args));
  await testnet.call(a.receiverId, a.methodName, a.args, { gas: `${Number(a.gas / 1_000_000_000_000n)} Tgas`, attachedDeposit: `${a.deposit} yocto` });
};

/** Seed the EMA from the last 3 hours of closed Binance 1-minute candles, so the breaker works from the first minute.
 *  The newest candle is still open and stamped in the future; it is dropped so live samples aren't ignored. */
async function seedEma(ema: Ema): Promise<void> {
  try {
    const r = await fetch("https://api.binance.com/api/v3/klines?symbol=NEARUSDT&interval=1m&limit=181");
    if (!r.ok) throw new Error(`binance ${r.status}`);
    for (const k of ((await r.json()) as [number, string, string, string, string][]).slice(0, -1)) {
      ema.update(BigInt(Math.round(Number(k[4]) * 1e8)), Math.floor(k[0] / 1000));
    }
    log("EMA seeded from Binance:", Number(ema.value) / 1e8);
  } catch (e) {
    log("EMA seed skipped (starts at first relayed spot):", (e as Error).message);
  }
}

async function main() {
  let saved: unknown = null;
  try { saved = JSON.parse(readFileSync(STATE_FILE, "utf8")).ema; } catch { /* first run */ }
  const ema = Ema.restore(3600, saved);
  if (now() - ema.lastTime > 2 * 3600) await seedEma(ema);
  else log(`EMA restored from ${STATE_FILE}:`, Number(ema.value) / 1e8);
  let lastPushed = 0;
  const state: KeeperState = { startedAt: now(), lastPushAt: 0, lastPublishTime: 0 };
  createServer((req, res) => {
    const h = keeperHealth(state, now());
    // /health drives restarts (503 when stale); /status always answers 200 so the app can show a live/lagging badge.
    const path = (req.url ?? "").split("?")[0];
    const code = path === "/health" ? (h.ok ? 200 : 503) : path === "/status" ? 200 : 404;
    res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" });
    res.end(JSON.stringify({ ...h, relay: RELAY, pool: POOL, dryRun: DRY }));
  }).listen(Number(process.env.PORT ?? 8080));
  const pool = POOL ? views(testnet as never, POOL) : null;

  const priceTick = async () => {
    const src = parsePythPrice(await sourceView("get_price_no_older_than", { price_id: NEAR_USD_ID, age: MAX_PRICE_AGE_SECS }));
    const d = relayDecision(src, lastPushed, now());
    if (!d.push || !src) return d.push ? undefined : log("relay skip:", d.why);
    ema.update(src.price, src.publishTime);
    await send({
      receiverId: RELAY || "<relay>", methodName: "set_prices",
      args: { spot: src.price.toString(), ema: ema.value.toString(), conf: src.conf.toString(), publish_time: src.publishTime },
      gas: 10_000_000_000_000n, deposit: 0n,
    });
    lastPushed = src.publishTime;
    state.lastPushAt = now();
    state.lastPublishTime = src.publishTime;
    try { writeFileSync(STATE_FILE, JSON.stringify({ ema: ema.save() })); } catch (e) { log("state save failed:", (e as Error).message); }
    log(`relayed spot ${Number(src.price) / 1e8} ema ${(Number(ema.value) / 1e8).toFixed(4)} age ${now() - src.publishTime}s`);
  };
  const settleTick = async () => {
    if (!pool) return;
    const due = dueForSettle(await allLoans(pool.loans), now());
    for (const id of due) {
      try { await send({ receiverId: POOL, methodName: "settle", args: { id }, gas: 100_000_000_000_000n, deposit: 0n }); log("settled", id); }
      catch (e) { log("settle", id, "failed:", (e as Error).message.slice(0, 160)); }
    }
  };
  const loop = (f: () => Promise<unknown>, ms: number) => {
    const run = () => f().catch((e) => log("error:", (e as Error).message.slice(0, 160))).finally(() => setTimeout(run, ms));
    run();
  };
  log(DRY ? "DRY RUN: nothing is sent" : `keeper signing as ${SIGNER}: relay ${RELAY}, pool ${POOL}`);
  loop(priceTick, PRICE_EVERY_MS);
  loop(settleTick, SETTLE_EVERY_MS);
}

main();
