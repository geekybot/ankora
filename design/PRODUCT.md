# Product

<!-- impeccable:product-schema 1 -->

> Written 2026-11-10 from the session brief and `research_docs/` (mechanism, rate formula, oracle/custody/USP). No interview was run; every line is inferred from those sources. Lines marked (assumption) are not confirmed by the user.

## Platform

web

## Stack

Next.js + TypeScript + NEAR Wallet Selector (production, later). These design files are static HTML/CSS/JS so they can be ported component by component.

## Users

- **Borrower, LST holder.** Holds LiNEAR, stNEAR or rNEAR. Wants dollars without selling NEAR. Opens the app on a phone, wallet already connected, wants USDC in as few taps as possible.
- **Borrower, native staker.** About 91% of staked NEAR (about $1.88B) sits with a chosen validator. Loyal to that validator. Must unstake once (about 28 hours) to enter, then re-stakes with the same validator through a per-loan vault.
- **Borrower who can't watch prices** (assumption, from USP doc section 4): large holders and treasuries at 30–50% LTV.
- **Lender.** Deposits USDC (from any chain via 1Click) into senior (fixed 6.5%) or junior (first loss, 15–21% estimated, can lose everything in a crash year).
- The user building this has ADHD; the product principle "one clear next action per screen" comes from that and also serves every borrower in a renewal notice.

## Product Purpose

Fixed-term dollar loans against staked NEAR with no liquidation during a term. Success: a borrower with an LST receives USDC in three taps or fewer from a connected wallet, and a borrower in a renewal notice always knows the one thing to do next.

## Positioning

Price is checked only when a loan starts or renews, never during a term. 60–68% of Rhea liquidations of passive borrowers in 2020–26 were intraday wicks; Ankora cannot act on a wick. If a paydown is ever needed: 72 hours' notice plus 48 hours' grace, no liquidator discount, auction surplus goes back to the borrower. Native stakers keep their own validator (any pool on `lockup-whitelist.near`).

## Operating Context

- Menu (round 11 proposal): 30% LTV for 30 days at about 9.7%; 40% for 14 days at about 10.1%; 50% for 7 days at about 11.3%; nothing above 50%.
- First term's interest is paid upfront (borrower receives loan minus interest). Ankora keeps 5% of interest as its only fee.
- Renewal is automatic by default and can be switched off any time. Next term's interest is added to debt at renewal.
- At expiry above the band limit: 72 hours to pay down (cash or let the vault sell part of the collateral), then 48 hours' grace with a late fee, then a 24-hour Dutch auction with surplus to the borrower.
- Repayment returns vault control immediately, no unstaking wait.
- Early repayment allowed any time; current term's interest is not refunded.
- Price source: signed Pyth update fetched from Hermes in the same transaction; rejected if older than 60 s or wide confidence. Collateral valued at the lower of spot and EMA. Breaker: no new loans while spot and EMA differ by more than 3%.

## Capabilities and Constraints

- Collateral: LiNEAR, stNEAR, rNEAR (instant, via `ft_transfer_call`), or native stake (one-time unstake, about 28 hours, then plain NEAR into the vault, which stakes with the borrower's validator).
- Not supported: lockup contracts, House of Stake veNEAR.
- Lender tranches: senior 85% of pool, fixed 6.5%; junior 15%, first loss, deposits locked until every loan made while they were in has closed (at most about 36 days).
- New loans stop when junior capital is short.
- Undecided: whether the round 11 menu is final (doc says "proposed, not yet adopted"); exact late fee; the fee tip for triggering renewals.

## Brand Commitments

- Name: Ankora. Domain: ankora.utpal.dev.
- Must not resemble Spectra Finance (similar name, yield-tokenization protocol).
- Must not claim "without unstaking" or "no oracle".

## Evidence on Hand

- Numbers only from `research_docs/ankora-mechanism.md`, `ankora-rate-formula.md`, `ankora-oracle-custody-usp.md`.
- No users, TVL, testimonials, audits or partners exist. Every balance or loan shown in a design is synthetic demo data and must be labelled as such.

## Product Principles

1. One clear next action per screen.
2. Show the clock, not the price: the borrower's risk is a date, not a ticker.
3. Say what can't happen as plainly as what can (no wick liquidation; also "you may be asked to pay down").
4. Every risk number has a source the user can open.
5. Fewest taps from connected wallet to USDC.

## Accessibility & Inclusion

ADHD-friendly: one primary action per screen, no competing CTAs, progress always visible, no time pressure in copy except real deadlines. WCAG AA contrast.
