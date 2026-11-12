# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Static HTML/CSS landing page in `site/` (built on the taste-skill kit), deployed at `ankora.utpal.dev`. The app is a separate Vite + TypeScript build in `app/`.

## Users

- **Borrowers:** NEAR holders, native stakers loyal to a validator, and treasuries. They want dollars without selling their NEAR or risking a forced sale on a 3am dip.
- **Lenders:** stablecoin holders choosing a fixed 6.5% (paid first) or the First-loss tranche (variable, can lose everything, locked 36 days).

## Product Purpose

Fixed-term USDC loans against NEAR that stays staked with the borrower's own validator, in a vault account created for each loan. The price is read only when a term starts or renews. Above 50% LTV at renewal: 72 hours' notice, 48 hours' grace, then a 24-hour Dutch auction with any surplus returned to the borrower.

## Positioning

A dip during a term can't sell your NEAR. In a 2020–26 backtest, 60–68% of liquidations on a liquidation-line lender came on a day NEAR closed back above the line.

## Constraints

- NEAR testnet hackathon build. Unaudited. A team-run price relay feeds the testnet price; the pool contract is upgradable.
- Never say risk-free, guaranteed, or safe. First-loss can lose everything; Fixed loses once First-loss is gone.
- Plans: up to 30% LTV for 30 days at 9.7%, 40% for 14 days at 10.1%, 50% for 7 days at 11.3% (a year).
