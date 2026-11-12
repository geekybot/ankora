# Ankora contracts

Testnet hackathon build: fixed-term USDC loans against NEAR staked with the borrower's own validator, with no liquidation during a term. Not audited.

## Mechanism

- **Plans:** borrow up to 30% LTV for 30 days at 9.7%, 40% for 14 days at 10.1%, or 50% for 7 days at 11.3% (annual, simple). A stressed menu only shortens terms (14, 7 and 3 days; 9.7%, 10.1%, 11.7%). The first term's interest is taken from the principal.
- **Price:** read only when a term starts or renews. Collateral is valued at the lower of spot and a 1-hour average; a price older than 90 s or with a confidence band wider than 1% is refused, and no new loan starts while spot and average differ by more than 3%.
- **Collateral:** plain NEAR goes into a vault account created for the loan, which stakes it with the borrower's chosen validator (any pool on the lockup whitelist). Native stakers unstake once first, about 28 hours.
- **At expiry:** at 50% LTV or below the loan renews and the next term's interest is added to the debt. Above it: 72 hours' notice to pay down, 48 hours' grace, then a 24-hour Dutch auction from 100% to 50% of the oracle value. Any surplus goes to the borrower. No late fee.
- **Lenders:** the senior tranche earns a fixed 6.5%. The junior tranche takes the first loss and keeps what's left, so it can lose everything. Junior must be at least 15% of loans, and junior deposits are locked for 36 days.

| Crate | What it is |
|---|---|
| `ankora-core` | Pure Rust rules: plans menu, unit-safe maths, Pyth checks, senior/junior ledger, loan state machine. No chain code |
| `ankora-vault` | One NEAR account per loan. Stakes with the borrower's validator after a lockup-whitelist check. The pool can only stake once and hand the vault over once. No upgrade method |
| `ankora-pool` | Lender tranches, borrowing, repayment, settlement, Dutch auction, withdrawals, claimable auction surplus, views |
| `ankora-mocks` | Sandbox and testnet stand-in for USDC, Pyth, the whitelist and a staking pool. Never mainnet |

## Build and test

```bash
./build.sh                                   # vault first (the pool embeds it), then pool and mocks
cargo test --workspace --lib                 # unit tests
cargo test -p ankora-pool --test flow -- --test-threads=1   # end-to-end on a local sandbox (downloads near-sandbox once)
```

The toolchain is pinned to Rust 1.95.0 in `rust-toolchain.toml`. Build with `cargo-near` 0.23.

## Price source (checked 2026-11-11)

Pyth is gone on NEAR. Pyth Core dropped NEAR in its 26 Aug 2026 upgrade: `pyth-oracle.near` last published NEAR/USD on 25 Aug, `pyth-oracle.testnet` holds no NEAR/USD price, and Hermes now needs an API key (401 without one).

- **Mainnet:** Rhea's lending reads `aggregate-oracle.near` (Rhea's agg-oracle v0.4.1, source repo private). A relayer posts signed Pyth Pro payloads about every 40 s. It answers the Pyth-shaped `get_price_no_older_than` with the same NEAR/USD id, but has **no EMA method** and no testnet deployment. Before a mainnet launch, the pool needs its own average, or a decision to drop min(spot, EMA) and the 3% breaker.
- **Testnet (this build):** the pool reads a price relay we run: `ankora-mocks` on your own account, where only the deploying account can call `set_prices`. The keeper in `../client` copies the mainnet spot from `aggregate-oracle.near`, keeps the source's publish time, and adds a 1-hour EMA, so the pool's 90 s age limit, min(spot, EMA) and breaker run unchanged. The relay is a trust point; say so in the demo.
- **Effect on the app:** prices are pushed by the keeper, so a borrow is a single transaction with no price push. The app should check the price age before asking for approval: if the relay lags past 90 s, the borrow refunds (`Stale`).

| Role | Testnet account |
|---|---|
| Price relay + test USDC | `<you>-mocks.testnet` (one `ankora-mocks` deploy). USDC `mint` is open, a faucet for judges; prices, clock and whitelist are owner-only |
| Lockup whitelist | `whitelist.f863973.m0` (`is_whitelisted("legends.pool.f863973.m0")` returns true). Mainnet is `lockup-whitelist.near` |
| Validators | Any `*.pool.f863973.m0` on the whitelist, for example `kiln.pool.f863973.m0` |
| NEAR/USD id | `c415de8d2eba7db216527dff4b60e8f3a5311c740dadb233e13e12547e226750` (the same id on `aggregate-oracle.near`) |

## Live on NEAR testnet (deployed 2026-11-12)

| Role | Account |
|---|---|
| Pool | `geekybot-ankora.testnet` |
| Test USDC, price relay, pool owner | `geekybot-mocks.testnet` |
| First loan's vault | `v0.geekybot-ankora.testnet`, 3.735 NEAR staked with `kiln.pool.f863973.m0` |

## Deploy (the founder creates the accounts; Claude never does)

1. Create two testnet accounts with keys in `~/.near-credentials` (uses `cargo-near`; no near CLI needed):
   ```bash
   cargo near create-dev-account use-specific-account-id <you>-mocks.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
   ```
   ```bash
   cargo near create-dev-account use-specific-account-id <you>-ankora.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
   ```
2. Build, then deploy, seed and run a smoke borrow in one idempotent script (rerun it if a step fails):
   ```bash
   ./build.sh
   ```
   ```bash
   cd ../client && npm install && ANKORA_RELAY=<you>-mocks.testnet ANKORA_POOL=<you>-ankora.testnet npm run deploy:testnet
   ```
   It deploys the relay and test USDC, then the pool (owner, USDC and price relay all `<you>-mocks.testnet`), deposits 3,000 First-loss and 17,000 Fixed test USDC, and borrows against 3.5 NEAR staked with `kiln.pool.f863973.m0`. `CHECK_ONLY=1` runs the read-only preflight.
3. Start the keeper (relays prices every 5 s, settles due loans every 60 s, `GET /health` on port 8080):
   ```bash
   ANKORA_RELAY=<you>-mocks.testnet ANKORA_POOL=<you>-ankora.testnet npm run keeper
   ```
   Hosted: `client/Dockerfile`, with `KEEPER_PRIVATE_KEY` set as a host secret.

A demo pool that can fast-forward time for the video: build with `--features test-clock` (`target/near/ankora_pool_testclock/`) and deploy it to a separate account; `test_advance_clock` is owner-only. Move the relay's clock with it (`advance_clock`).

## Known limits

- **Collateral:** plain NEAR only. Liquid staking tokens and the vault selling its own collateral are roadmap.
- **Volatility:** the stressed menu is an owner switch (`set_stressed`), not an on-chain volatility average.
- **No deposit queue:** junior cover of at least 15% of outstanding loans is enforced, and junior deposits are locked for 36 days.
- **Price relay (testnet):** the keeper's account sets prices. On mainnet, `aggregate-oracle.near` has no EMA, so min(spot, EMA) and the breaker need a replacement before launch.
- **Upgradability:** the pool account keeps the deployer's full-access key, so the pool is upgradable. Vaults are not.
- **Vault storage:** each vault costs about 1.2 NEAR of storage. NEAR global contracts (NEP-591, supported by `near-api`) could cut this.
- **No external audit.** An internal pass with the `near-contract-audit` checklist fixed three findings: one-yocto deposits on `set_auto_renew`, `withdraw`, `claim` and `set_stressed`; unsold vaults go to the owner; a 10 USDC minimum deposit.
- **Unsold auctions:** an unsold vault goes to the pool owner, who unstakes and sells the NEAR and books the USDC with a `recovery` message. That's a trust point.
