// Keeper decisions, kept pure so they are tested without a chain. `bin/keeper.ts` wires them to RPC.
import { MAX_PRICE_AGE_SECS, priceAge, type SourcePrice } from "./oracle.ts";
import type { LoanView } from "./pool.ts";

const OPEN = new Set(["Active", "Notice", "Grace", "Auction"]);

/** Loans a `settle` can move now: renew, start notice/grace/auction, or close an unsold auction. */
export const dueForSettle = (loans: LoanView[], nowSecs: number): number[] =>
  loans.filter((l) => OPEN.has(l.state) && l.deadline > 0 && l.deadline <= nowSecs).map((l) => l.id);

export type RelayDecision = { push: true } | { push: false; why: "no source price" | "not newer" | "source stale" };

/** Push only a newer, still-fresh source price. Staleness is measured from the source's own publish time. */
export function relayDecision(src: SourcePrice | null, lastPushedPublishTime: number, nowSecs: number): RelayDecision {
  if (!src) return { push: false, why: "no source price" };
  if (src.publishTime <= lastPushedPublishTime) return { push: false, why: "not newer" };
  if (priceAge(src, nowSecs) > MAX_PRICE_AGE_SECS) return { push: false, why: "source stale" };
  return { push: true };
}
