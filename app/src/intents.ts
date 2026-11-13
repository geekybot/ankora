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
