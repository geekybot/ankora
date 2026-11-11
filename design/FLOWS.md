# Ankora flows and tap counts (revision 2, v1 contracts)

2026-11-11. Prototype: `design/proto/index.html?d=b&p=petrol` (the recommended app). Every number below was counted by the prototype's flow runner (top bar, "Run a flow") in direction B with the Petrol palette, not estimated. Directions A and C share the same engine and screens but were not re-run after the copy changes.

## How a tap is counted

- Start: the app is open and the wallet is already connected.
- A tap is any deliberate press inside the app or the wallet sheet: a button, an option, a toggle, a tab, a slider release.
- The wallet's own "Approve" counts as a tap.
- Typing an amount is not a tap. Prototype-only controls (direction and palette switches, "skip the 28-hour wait") are not counted.
- End: the moment the outcome exists (USDC in the wallet, loan repaid, deposit placed, surplus claimed).

## Summary

| # | Flow | Path | Taps |
|---|---|---|---|
| 1 | Borrow with NEAR in your wallet | Home **Continue** → Review **Borrow 4,464.12 USDC** → Wallet **Approve** | **3** (target ≤ 3 ✓) |
| 2 | Borrow against native stake, keep your validator | **Continue** → validator check shown → **Start unstaking** → **Approve** → *guided wait, about 28 h* → **Withdraw** → **Approve** → **Borrow** → **Approve** | **7** + 28 h |
| 3 | Your loan: next price check, LTV against the 50% limit | Opens on launch when a loan exists | **0** |
| 4 | Switch renewal off | **Renew automatically** switch → wallet **Approve** (v1 asks the wallet to confirm) | **2** |
| 5 | Renewal notice, repay part (default) | Home is the notice → **Repay 250 USDC** → **Approve** | **2** |
| 6 | Renewal notice, repay all | **Repay all** → **Repay all 4,500.00 USDC** → **Approve** | **3** |
| 7 | Auction running, repay to stop it | Home is the auction → **Repay 4,500.00 USDC and stop the auction** → **Approve** | **2** |
| 8 | Claim auction surplus | Home shows the claim → **Claim 1,314.02 USDC** → **Approve** | **2** |
| 9 | Repay early | Loan **Repay** → **Repay 4,500.00 USDC** → **Approve** | **3** |
| 10 | Lend, senior | **Lend** → tick the risk box → **Max** → **Deposit to Senior** → **Approve** | **5** |
| 11 | Lend, junior (first loss) | **Lend** → **Junior** → tick the risk box → **Max** → **Deposit to Junior** → **Approve** | **6** |
| 12 | Risk | **Risk** tab, or "How this can fail" from the loan | **1** |

## What changed from revision 1, and why

| Change | Source |
|---|---|
| Collateral is plain NEAR only; liquid staking tokens left every flow (roadmap only) | v1 contracts; copy doc D6, 4.8 |
| The vault keeps 1.5 NEAR back for storage, shown on the review ("Send 5,001.5 NEAR") | copy `quote.reserve` |
| Plans are named by LTV ("30% plan") with the term as a live label | copy 4.1 |
| Notice: repay part or all in USDC. The vault selling collateral is gone | copy D7 |
| No late fee. Late days are charged only when a loan renews late, at the new plan's rate | copy D8 |
| Auction screen: price falls from the vault's value to half over 24 h; full repay allowed until a bid lands | copy D9, `renew.auction.*` |
| Renewal off: the wallet confirms the change; if not repaid at expiry, grace starts straight away | peer brief; copy D10 |
| Unclaimed auction surplus shows as claimable | peer brief; `renew.auction.surplus_claim` |
| Native stake: validator check before the unstake; withdraw is its own signed step (+1 tap, now 7) | copy 4.4 |
| Lending: no deposit queue; both tranches need the risk box ticked (senior +1, now 5); junior locked 36 days from the latest junior deposit | copy D4, D12, 4.7 |
| Anyone can trigger a renewal once the term ends (shown on the loan screen) | copy section 3 |

## Assumption to check in the build

Wallets in Wallet Selector should show one approval for a batched `signAndSendTransactions` (price update, vault creation and deposit, stake, borrow). A wallet that asks per transaction adds up to 3 taps to flow 1.
