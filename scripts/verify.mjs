#!/usr/bin/env node
// Checks Ankora's public claims against NEAR mainnet, NEAR testnet, NEAR Intents 1Click and the hosted app.
// Read-only: it sends no transaction and needs no keys or installs. Node 22 or newer.
//
//   node scripts/verify.mjs
const MAINNET_POOL = "ankora.geekybot-1.near";
const TESTNET_POOL = "geekybot-ankora.testnet";
const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const ORACLE = "aggregate-oracle.near";
const NEAR_USD = "c415de8d2eba7db216527dff4b60e8f3a5311c740dadb233e13e12547e226750";
const APP = "https://ankora.utpal.dev";
const RPC = { mainnet: ["https://free.rpc.fastnear.com", "https://rpc.mainnet.near.org"], testnet: ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"] };

let fails = 0;
const ok = (m) => console.log(`PASS  ${m}`);
const bad = (m) => { fails++; console.log(`FAIL  ${m}`); };
const info = (m) => console.log(`INFO  ${m}`);
const check = (cond, pass, fail = pass) => (cond ? ok(pass) : bad(fail));

async function rpc(net, params) {
  let last;
  for (const url of RPC[net]) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { finality: "final", ...params } }), signal: AbortSignal.timeout(15000) });
      const j = await r.json();
      if (j.result && !j.result.error) return j.result;
      last = j.error?.cause?.name ?? j.result?.error ?? JSON.stringify(j.error);
    } catch (e) { last = e.message; }
  }
  throw new Error(String(last));
}
const view = async (net, account_id, method_name, args = {}) => {
  const r = await rpc(net, { request_type: "call_function", account_id, method_name, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
  return JSON.parse(Buffer.from(r.result).toString());
};
const usd = (x) => (Number(BigInt(x)) / 1e6).toFixed(2);

console.log(`\nAnkora verify · ${new Date().toISOString()}\n\n— Mainnet pool ${MAINNET_POOL}`);
try {
  const acct = await rpc("mainnet", { request_type: "view_account", account_id: MAINNET_POOL });
  ok(`account exists, code hash ${acct.code_hash}`);
  const meta = await view("mainnet", MAINNET_POOL, "contract_source_metadata").catch(() => null);
  if (meta?.build_info) ok(`reproducible build: ${meta.build_info.source_code_snapshot} (image ${meta.build_info.build_environment.split("@")[0]})`);
  else info(`no reproducible build info in contract_source_metadata (link ${meta?.link ?? "none"})`);
  info(`source verification: https://nearblocks.io/address/${MAINNET_POOL}?tab=contract`);
  const lim = await view("mainnet", MAINNET_POOL, "get_limits").catch(() => null);
  if (lim) {
    check(lim.build === "mainnet", `build is the capped mainnet build`, `build is "${lim.build}", not "mainnet"`);
    check(lim.cap_deposits === "200000000", `deposits capped at ${usd(lim.cap_deposits ?? 0)} USDC`, `deposit cap is ${lim.cap_deposits}`);
    check(lim.cap_loans === "100000000", `loans capped at ${usd(lim.cap_loans ?? 0)} USDC`, `loan cap is ${lim.cap_loans}`);
    check(lim.price_source === ORACLE && lim.usdc === USDC, `prices from ${ORACLE}, native USDC`, `price source ${lim.price_source}, usdc ${lim.usdc}`);
    info(`owner ${lim.owner}, minimum deposit ${usd(lim.min_deposit)} USDC, price age limit ${lim.max_price_age_secs} s, validators from ${lim.whitelist}`);
  } else bad("get_limits not available: this deployment predates the limits view");
  const keys = (await rpc("mainnet", { request_type: "view_access_key_list", account_id: MAINNET_POOL })).keys;
  const full = keys.filter((k) => k.access_key.permission === "FullAccess").length;
  info(`${keys.length} access key(s), ${full} full-access: ${full ? "the contract is upgradable by that key (disclosed in the docs)" : "locked, no full-access key"}`);
  const reg = await view("mainnet", USDC, "storage_balance_of", { account_id: MAINNET_POOL });
  check(!!reg, "registered with USDC, so NEAR Intents can deliver to it", "not registered with USDC: deposits from other chains would fail");
  const L = await view("mainnet", MAINNET_POOL, "get_ledger");
  info(`pool: ${usd(L.cash)} USDC cash, ${usd(L.outstanding)} USDC lent, Fixed ${usd(L.senior_value)}, First-loss ${usd(L.junior_value)}`);
  const loans = await view("mainnet", MAINNET_POOL, "get_loans", { from_index: 0, limit: 50 });
  info(`${loans.length} loan(s)${loans.length ? `: ${loans.map((l) => `#${l.id} ${l.state} ${usd(l.debt)} USDC on ${l.validator}`).join(", ")}` : ""}`);
  const px = await view("mainnet", ORACLE, "get_price_no_older_than", { price_id: NEAR_USD, age: 90 });
  check(px && Date.now() / 1000 - px.publish_time <= 90, `oracle fresh: NEAR $${(Number(px?.price) * 10 ** (px?.expo ?? 0)).toFixed(4)}, ${Math.round(Date.now() / 1000 - (px?.publish_time ?? 0))} s old`, "oracle price older than 90 s: new loans would refund");
} catch (e) { bad(`mainnet pool unreadable: ${e.message}`); }

console.log(`\n— Testnet pool ${TESTNET_POOL}`);
try {
  const L = await view("testnet", TESTNET_POOL, "get_ledger");
  ok(`live: ${usd(L.cash)} USDC cash, ${usd(L.outstanding)} lent, utilisation ${(L.utilisation_bps / 100).toFixed(1)}%`);
  const loans = await view("testnet", TESTNET_POOL, "get_loans", { from_index: 0, limit: 100 });
  const hist = await view("testnet", TESTNET_POOL, "get_auction_history", { from_index: 0, limit: 50 }).catch(() => []);
  info(`${loans.length} loan(s) on record, ${hist.length} auction(s) in history`);
} catch (e) { bad(`testnet pool unreadable: ${e.message}`); }

console.log("\n— NEAR Intents route into the mainnet pool");
try {
  const r = await fetch("https://1click.chaindefuser.com/v0/quote", { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(20000), body: JSON.stringify({
    dry: true, swapType: "EXACT_INPUT", slippageTolerance: 100, originAsset: "nep141:pol-0x3c499c542cef5e3811e1192ce70d8cc03d5c3359.omdep.near",
    destinationAsset: `nep141:${USDC}`, amount: "10000000", depositType: "ORIGIN_CHAIN", refundType: "ORIGIN_CHAIN", recipientType: "DESTINATION_CHAIN",
    refundTo: "0x0000000000000000000000000000000000000001", recipient: MAINNET_POOL, customRecipientMsg: JSON.stringify({ depositfor: { tranche: "senior", account: "alice.near" } }),
    deadline: new Date(Date.now() + 15 * 60_000).toISOString() }) });
  const j = await r.json();
  check(!!j.quote, `10 USDC on Polygon → ${j.quote?.amountOutFormatted} USDC delivered to the pool as a deposit, ~${j.quote?.timeEstimate} s`, `1Click refused: ${j.message}`);
} catch (e) { bad(`1Click unreachable: ${e.message}`); }

console.log("\n— Hosted app");
for (const [path, what] of [["/", "landing"], ["/app/", "app"], ["/docs/", "docs"], ["/keeper/health", "testnet keeper"]]) {
  try { const r = await fetch(APP + path, { signal: AbortSignal.timeout(15000) }); check(r.ok, `${what} ${APP}${path} answers ${r.status}`, `${what} ${APP}${path} answers ${r.status}`); }
  catch (e) { bad(`${what} unreachable: ${e.message}`); }
}

console.log(fails ? `\n${fails} check(s) failed.` : "\nEvery check passed.");
process.exit(fails ? 1 : 0);
