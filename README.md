# Ankora

Borrow USDC against NEAR for a fixed term, with no liquidation during the term. Your NEAR stays staked with the validator you choose, inside a vault account opened for your loan. The price is read only when a term starts or renews; if NEAR has fallen too far by then, you get 72 hours' notice and 48 hours' grace before anything is auctioned, and any surplus comes back to you.

**Status: NEAR testnet hackathon build. Not audited. Not on mainnet.**

## What the team controls on testnet (read this first)

| Control | Who | Why it matters |
|---|---|---|
| The NEAR/USD price the pool reads | A relay contract the team owns, fed by our keeper from mainnet `aggregate-oracle.near` (the Pyth Pro feed Rhea's lending also reads) | The price at renewal decides notice and the auction's start price. Pyth no longer serves NEAR (Pyth Core dropped it on 26 Aug 2026), so testnet needs a relay |
| The pool contract | Upgradable through the deployer's full-access key | Per-loan vaults are not upgradable |
| Unsold auctions | The vault goes to the pool owner, who sells the NEAR and books the USDC | A trust point until a market sale replaces it |
| Test USDC | A test token with an open faucet (1,000 per call) | Not real money |
| Volatility menu | An owner switch (normal / stressed); stressed only shortens terms | Not yet an on-chain average |

**Before mainnet:** the pool's key removed or behind a timelock; prices verified on chain from two sources, with an on-chain average; a market sale for unsold vaults; an external audit.

## How it works

1. **Borrow.** Bring NEAR and pick a plan: up to 30% of its value for 30 days at 9.7% a year, 40% for 14 days at 10.1%, or 50% for 7 days at 11.3%. The first term's interest is taken from the loan.
2. **It stays staked.** A vault account created for your loan stakes the NEAR with your validator (any pool on the lockup whitelist). Native stakers unstake once (about 28 hours) to move in.
3. **At renewal.** At 50% LTV or below, the loan renews and the next term's interest is added to the debt. Above it: 72 hours' notice to pay down, 48 hours' grace, then a 24-hour Dutch auction from 100% to 50% of the price. No late fee.
4. **Repay any time.** The vault is handed back to you; unstake and withdraw from it like any staking account.
5. **Lend.** *Fixed 6.5%* is paid first and loses money only after every First-loss deposit is gone. *First-loss* takes losses first and keeps what the pool earns beyond that; it can lose everything and is locked for 36 days. Ankora keeps 5% of interest.

## Try it

- **Testnet app:** `ankora.utpal.dev` (launching this week). You need a testnet wallet with at least 5 NEAR; get test USDC from the app's faucet.
- **On your machine, no testnet needed:** a full stack on a local NEAR sandbox, with the live mainnet price and controls to crash the price and skip time.
  ```bash
  cd contracts && ./build.sh
  ```
  ```bash
  cd client && npm install && npm run local
  ```
  ```bash
  cd app && npm install && npm run dev
  ```
  The app signs as a local dev account. `POST localhost:8090/price?usd=1` holds NEAR at $1; `POST localhost:8090/advance?secs=604800` skips a week.

## Code

| Folder | What it is |
|---|---|
| [`contracts/`](contracts/) | Rust (near-sdk 5.30): the pool (tranches, loans, renewal, notice, auction), the per-loan vault, test stand-ins. Mechanism, deploy steps and known limits in its README |
| [`client/`](client/) | TypeScript (`@ankora/client`): pool views and actions, quote maths mirrored from the contracts, the testnet keeper, deploy and local-chain scripts |
| [`app/`](app/) | The web app (Vite + TypeScript), reading and writing only through `@ankora/client` |
| [`design/`](design/) | Landing page and design system |

Tests: 99 contract tests (unit and sandbox end to end), 43 client tests. CI runs them on every push.

```bash
cd contracts && ./build.sh && cargo test --workspace --lib && cargo test -p ankora-pool --test flow -- --test-threads=1
```
```bash
cd client && npm test
```
