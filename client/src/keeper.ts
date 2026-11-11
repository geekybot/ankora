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

export interface KeeperState { startedAt: number; lastPushAt: number; lastPublishTime: number }
export interface KeeperHealth { ok: boolean; relayPriceAgeSecs: number | null; secsSincePush: number }
const MAX_SILENCE_SECS = 120;

/** Unhealthy after 2 minutes without a successful relay push (counted from start until the first push),
 *  so the host restarts the process. The pool itself refuses prices older than 60 s. */
export function keeperHealth(s: KeeperState, nowSecs: number): KeeperHealth {
  const secsSincePush = nowSecs - (s.lastPushAt > 0 ? s.lastPushAt : s.startedAt);
  return { ok: secsSincePush <= MAX_SILENCE_SECS, relayPriceAgeSecs: s.lastPublishTime > 0 ? nowSecs - s.lastPublishTime : null, secsSincePush };
}

/** Every loan, page by page. Closed loans stay in the pool's map, so the first page alone misses new ones. */
export async function allLoans(page: (fromIndex: number, limit: number) => Promise<LoanView[]>, limit = 100): Promise<LoanView[]> {
  const out: LoanView[] = [];
  for (let from = 0; ; from += limit) {
    const p = await page(from, limit);
    out.push(...p);
    if (p.length < limit) return out;
  }
}
