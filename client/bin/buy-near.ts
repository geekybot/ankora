// Buy NEAR with USDC on Base through NEAR Intents 1Click, delivered to a NEAR account. Sends nothing by itself:
// it prints a one-time Base deposit address, you send the USDC from your own Base wallet, and it watches until the
// NEAR lands (or 1Click refunds the USDC to your Base address).
//
//   npx tsx bin/buy-near.ts <you.near> <your-0x-address> <usdc-amount> [base|polygon]
// Polygon: native USDC only (0x3c499c542cef5e3811e1192ce70d8cc03d5c3359), not bridged USDC.e.
import { MAINNET } from "../src/config.ts";

const [to, refund, usd, chainArg = "base"] = process.argv.slice(2);
const CHAINS: Record<string, { name: string; asset: string }> = {
  base: { name: "Base", asset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near" },
  polygon: { name: "Polygon (native USDC, not USDC.e)", asset: "nep141:pol-0x3c499c542cef5e3811e1192ce70d8cc03d5c3359.omdep.near" },
};
const chain = CHAINS[chainArg];
if (!chain) throw new Error("chain must be base or polygon");
if (!to || !/^0x[0-9a-fA-F]{40}$/.test(refund ?? "") || !(Number(usd) > 0)) throw new Error("usage: buy-near.ts <you.near> <0x address> <usdc amount> [base|polygon]");
const API = "https://1click.chaindefuser.com/v0";
const exists = await (await fetch(MAINNET.rpc, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_account", finality: "final", account_id: to } }) })).json();
if (!exists.result) throw new Error(`${to} doesn't exist on NEAR mainnet: check the name`);

const r = await fetch(`${API}/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
  dry: false, swapType: "EXACT_INPUT", slippageTolerance: 100, originAsset: chain.asset, destinationAsset: "nep141:wrap.near",
  amount: String(Math.round(Number(usd) * 1e6)), depositType: "ORIGIN_CHAIN", refundType: "ORIGIN_CHAIN", recipientType: "DESTINATION_CHAIN",
  refundTo: refund, recipient: to, deadline: new Date(Date.now() + 60 * 60_000).toISOString(),
}) });
const j = await r.json();
if (!r.ok || !j?.quote?.depositAddress) throw new Error(j?.message ?? `quote failed (${r.status})`);
const q = j.quote;
console.log(`\nSend exactly ${q.amountInFormatted} USDC on ${chain.name} to:\n\n    ${q.depositAddress}\n`);
console.log(`You get about ${Number(q.amountOutFormatted).toFixed(3)} NEAR in ${to}, in ~${q.timeEstimate} s after the transfer confirms.`);
console.log(`Valid for 1 hour. If anything fails, the USDC is refunded to ${refund} on ${chain.name}.\nWatching… (Ctrl-C stops watching; the swap still completes)\n`);

let last = "";
for (;;) {
  await new Promise((s) => setTimeout(s, 5000));
  const s = await fetch(`${API}/status?depositAddress=${q.depositAddress}`).then((x) => x.json()).catch(() => null);
  const st = s?.status ?? "PENDING_DEPOSIT";
  if (st !== last) { console.log(new Date().toISOString().slice(11, 19), st); last = st; }
  if (["SUCCESS", "REFUNDED", "FAILED"].includes(st)) {
    const tx = s?.swapDetails?.destinationChainTxHashes?.[0]?.hash;
    if (tx) console.log(`NEAR transaction: https://nearblocks.io/txns/${tx}`);
    break;
  }
}
