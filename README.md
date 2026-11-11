# Ankora

Fixed-term USDC loans against NEAR that stays staked with the borrower's own validator. A price dip during a term can't sell the collateral; the price is checked only when a term starts or renews. NEAR testnet hackathon build, not audited.

| Folder | What it is |
|---|---|
| [`contracts/`](contracts/) | Rust smart contracts: the pool (lender tranches, loans, renewal, auction), the per-loan vault, and test stand-ins. Mechanism, build, test and deploy steps are in its README |
| [`client/`](client/) | TypeScript chain client for the app: pool views, wallet-agnostic actions, quote maths mirrored from the contracts, and the testnet keeper (price relay and settlement) |
| [`design/`](design/) | Mobile-first UI prototype and landing page |

```bash
cd contracts && ./build.sh && cargo test --workspace --lib
```
```bash
cd client && npm install && npm test
```
