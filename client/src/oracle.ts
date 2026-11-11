// Price rules mirrored from contracts/ankora-core/src/oracle.rs, plus the relay's EMA.
//
// Why a relay: Pyth Core dropped NEAR on 2026-08-26 (pyth-oracle.near's NEAR/USD stopped on 2026-08-25) and Hermes
// now needs an API key. Rhea's lending reads aggregate-oracle.near (signed Pyth Pro payloads, about every 40 s), which
// serves spot only and has no testnet deployment. On testnet the pool reads a relay we run (ankora-mocks, owner-only
// `set_prices`) that copies the mainnet spot and adds an EMA, so the pool's min(spot, EMA) and 3% breaker still apply.

export const MAX_PRICE_AGE_SECS = 60;
export const MAX_CONF_BPS = 100n;
export const BREAKER_BPS = 300n;

export interface SourcePrice { price: bigint; conf: bigint; expo: number; publishTime: number }
export type CollateralPrice = { ok: true; price: bigint; expo: number } | { ok: false; error: "Missing" | "Invalid" | "Stale" | "WideConfidence" | "ExpoMismatch" | "Breaker" };

export const priceAge = (p: SourcePrice, nowSecs: number): number => Math.abs(nowSecs - p.publishTime);

function check(p: SourcePrice | null, now: number): SourcePrice | CollateralPrice {
  if (!p) return { ok: false, error: "Missing" };
  if (p.price <= 0n) return { ok: false, error: "Invalid" };
  if (priceAge(p, now) > MAX_PRICE_AGE_SECS) return { ok: false, error: "Stale" };
  if (p.conf * 10_000n > p.price * MAX_CONF_BPS) return { ok: false, error: "WideConfidence" };
  return p;
}

/** What the pool will use: the lower of spot and EMA, or the reason it will refuse. */
export function collateralPrice(spot: SourcePrice | null, ema: SourcePrice | null, nowSecs: number, forNewLoan: boolean): CollateralPrice {
  const s = check(spot, nowSecs);
  if ("ok" in s) return s;
  const e = check(ema, nowSecs);
  if ("ok" in e) return e;
  if (s.expo !== e.expo) return { ok: false, error: "ExpoMismatch" };
  const gap = s.price > e.price ? s.price - e.price : e.price - s.price;
  if (forNewLoan && gap * 10_000n > s.price * BREAKER_BPS) return { ok: false, error: "Breaker" };
  return { ok: true, price: s.price < e.price ? s.price : e.price, expo: s.expo };
}

/** Time-weighted EMA with time constant `tauSecs` (Pyth's EMA spans about an hour). */
export class Ema {
  private v: number | null = null;
  private t = -Infinity;
  constructor(readonly tauSecs: number) {}
  get value(): bigint { if (this.v === null) throw new Error("EMA has no samples"); return BigInt(Math.round(this.v)); }
  get lastTime(): number { return this.t; }
  save(): { v: number | null; t: number } { return { v: this.v, t: Number.isFinite(this.t) ? this.t : 0 }; }
  static restore(tauSecs: number, saved: unknown): Ema {
    const e = new Ema(tauSecs);
    const s = saved as { v?: unknown; t?: unknown } | null;
    if (s && typeof s.v === "number" && Number.isFinite(s.v) && typeof s.t === "number") { e.v = s.v; e.t = s.t; }
    return e;
  }
  update(price: bigint, t: number): void {
    if (t <= this.t) return;
    const p = Number(price);
    this.v = this.v === null ? p : this.v + (1 - Math.exp(-(t - this.t) / this.tauSecs)) * (p - this.v);
    this.t = t;
  }
}

/** Parse a Pyth-shaped `get_price_no_older_than` answer ({price, conf, expo, publish_time}). */
export function parsePythPrice(raw: unknown): SourcePrice | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { price: string; conf: string; expo: number; publish_time: number };
  return { price: BigInt(r.price), conf: BigInt(r.conf), expo: r.expo, publishTime: Number(r.publish_time) };
}
