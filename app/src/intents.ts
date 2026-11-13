// NEAR Intents (1Click API): live quotes for moving USDC between NEAR and other chains.
// Read-only dry-run quotes: no API key, no deposit address, nothing is sent. NEAR Intents has no testnet, so on this
// testnet build the quotes are the real mainnet route; the pool's `depositfor` message is the contract side of it.
const API = "https://1click.chaindefuser.com/v0/quote";
export const NEAR_USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
export interface Chain { id: string; label: string; asset: string; addr: string }
/** USDC on each chain (ids from GET /v0/tokens) and a placeholder address of that chain's format for dry quotes. */
export const CHAINS: Chain[] = [
  { id: "base", label: "Base", asset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", addr: "0x0000000000000000000000000000000000000001" },
  { id: "eth", label: "Ethereum", asset: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near", addr: "0x0000000000000000000000000000000000000001" },
  { id: "arb", label: "Arbitrum", asset: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near", addr: "0x0000000000000000000000000000000000000001" },
  { id: "pol", label: "Polygon", asset: "nep141:pol-0x3c499c542cef5e3811e1192ce70d8cc03d5c3359.omdep.near", addr: "0x0000000000000000000000000000000000000001" },
  { id: "sol", label: "Solana", asset: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near", addr: "So11111111111111111111111111111111111111112" },
];
export interface Quote { out: number; secs: number }
const cache = new Map<string, { at: number; q: Quote | Error }>();

/** USDC (6 decimals) from `from` to `to`. `toNear`: the destination is NEAR (fund a deposit) or the other chain (receive a loan). */
export async function quote(chain: Chain, amount: bigint, toNear: boolean): Promise<Quote> {
  const key = `${chain.id}:${toNear}:${amount}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 30_000) { if (hit.q instanceof Error) throw hit.q; return hit.q; }
  const body = {
    dry: true, swapType: "EXACT_INPUT", slippageTolerance: 100,
    originAsset: toNear ? chain.asset : NEAR_USDC, destinationAsset: toNear ? NEAR_USDC : chain.asset,
    amount: amount.toString(), depositType: "ORIGIN_CHAIN", refundType: "ORIGIN_CHAIN", recipientType: "DESTINATION_CHAIN",
    refundTo: toNear ? chain.addr : "example.near", recipient: toNear ? "example.near" : chain.addr,
    deadline: new Date(Date.now() + 10 * 60_000).toISOString(),
  };
  try {
    const r = await fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok || !j?.quote?.amountOutFormatted) throw new Error(j?.message ?? `quote failed (${r.status})`);
    const q = { out: Number(j.quote.amountOutFormatted), secs: Number(j.quote.timeEstimate ?? 0) };
    cache.set(key, { at: Date.now(), q });
    return q;
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    cache.set(key, { at: Date.now(), q: err });
    throw err;
  }
}

/** Address formats each chain accepts for refunds. */
export const validAddress = (chain: Chain, a: string) => chain.id === "sol" ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a) : /^0x[0-9a-fA-F]{40}$/.test(a);

export interface Deposit { address: string; chain: string; amountIn: string; amountOut: number; minOut: number; deadline: string; secs: number }
/** Mainnet only. A real (non-dry) quote: USDC sent to `address` on `chain` reaches NEAR and is delivered to `pool` with
 *  ft_transfer_call and the message `depositfor`, so the shares are credited to `account`. Refunds go to `refundTo`. */
export async function depositTo(chain: Chain, amount: bigint, refundTo: string, pool: string, account: string, tranche: "senior" | "junior"): Promise<Deposit> {
  const body = {
    dry: false, swapType: "EXACT_INPUT", slippageTolerance: 100,
    originAsset: chain.asset, destinationAsset: NEAR_USDC, amount: amount.toString(),
    depositType: "ORIGIN_CHAIN", refundType: "ORIGIN_CHAIN", recipientType: "DESTINATION_CHAIN",
    refundTo, recipient: pool, customRecipientMsg: JSON.stringify({ depositfor: { tranche, account } }),
    deadline: new Date(Date.now() + 60 * 60_000).toISOString(),
  };
  const r = await fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok || !j?.quote?.depositAddress) throw new Error(j?.message ?? `quote failed (${r.status})`);
  return { address: j.quote.depositAddress, chain: chain.id, amountIn: j.quote.amountInFormatted, amountOut: Number(j.quote.amountOutFormatted),
    minOut: Number(j.quote.minAmountOut) / 1e6, deadline: j.quote.deadline ?? body.deadline, secs: Number(j.quote.timeEstimate ?? 0) };
}
export type DepositStatus = "PENDING_DEPOSIT" | "KNOWN_DEPOSIT_TX" | "PROCESSING" | "SUCCESS" | "INCOMPLETE_DEPOSIT" | "REFUNDED" | "FAILED" | string;
/** 1Click's view of a deposit address: where the transfer is, and the NEAR transaction once it lands. */
export async function depositStatus(address: string): Promise<{ status: DepositStatus; nearTx?: string }> {
  const r = await fetch(`${API.replace(/quote$/, "status")}?depositAddress=${encodeURIComponent(address)}`, { cache: "no-store" });
  if (r.status === 404) return { status: "PENDING_DEPOSIT" };
  const j = await r.json();
  const tx = j?.swapDetails?.destinationChainTxHashes?.[0]?.hash ?? j?.swapDetails?.nearTxHashes?.at?.(-1);
  return { status: j?.status ?? "PENDING_DEPOSIT", nearTx: tx };
}

export interface SendOut { address: string; chain: string; amountIn: string; amountOut: number; deadline: string; secs: number }
/** Mainnet only. USDC from a NEAR wallet to `to` on `chain`. 1Click returns a NEAR deposit address (an implicit account,
 *  not yet registered with USDC): the wallet registers it and transfers in one transaction. Refunds go to `refundNear`. */
export async function sendOut(chain: Chain, amount: bigint, to: string, refundNear: string): Promise<SendOut> {
  const body = {
    dry: false, swapType: "EXACT_INPUT", slippageTolerance: 100,
    originAsset: NEAR_USDC, destinationAsset: chain.asset, amount: amount.toString(),
    depositType: "ORIGIN_CHAIN", refundType: "ORIGIN_CHAIN", recipientType: "DESTINATION_CHAIN",
    refundTo: refundNear, recipient: to, deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
  };
  const r = await fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok || !j?.quote?.depositAddress) throw new Error(j?.message ?? `quote failed (${r.status})`);
  return { address: j.quote.depositAddress, chain: chain.id, amountIn: j.quote.amountInFormatted, amountOut: Number(j.quote.amountOutFormatted), deadline: j.quote.deadline ?? body.deadline, secs: Number(j.quote.timeEstimate ?? 0) };
}
/** Tell 1Click which transaction paid the deposit address, so it starts without waiting to notice it. Best effort. */
export async function submitTx(txHash: string, depositAddress: string): Promise<void> {
  await fetch(API.replace(/quote$/, "deposit/submit"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ txHash, depositAddress }) }).catch(() => undefined);
}
