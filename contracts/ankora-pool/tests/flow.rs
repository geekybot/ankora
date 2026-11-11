//! End-to-end on a local NEAR sandbox with stand-in USDC, Pyth, whitelist and staking pool (`ankora-mocks`).
//! Build first: `./build.sh` (vault, pool, mocks wasm), then `cargo test -p ankora-pool --test flow`.
use near_api::{AccountId, Contract, NearGas, NearToken, NetworkConfig, Signer};
use near_sdk::serde_json::{json, Value};
use std::sync::Arc;
use testresult::TestResult;

const U: u128 = 1_000_000;
const NEAR_Y: u128 = 1_000_000_000_000_000_000_000_000;
const PRICE_ID: &str = "c415de8d2eba7db216527dff4b60e8f3a5311c740dadb233e13e12547e226750";

fn wasm(name: &str) -> Vec<u8> { wasm_at(name, name) }
/// `dir` differs from `name` for the pool's test-clock build (`target/near/ankora_pool_testclock/ankora_pool.wasm`).
fn wasm_at(dir: &str, name: &str) -> Vec<u8> {
    let p = format!("{}/../target/near/{dir}/{name}.wasm", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(&p).unwrap_or_else(|_| panic!("missing {p}: run ./build.sh first"))
}

struct World {
    sandbox: near_sandbox::Sandbox,
    net: NetworkConfig,
    signer: Arc<Signer>,
}

impl World {
    async fn account(&self, name: &str, near: u128) -> TestResult<AccountId> {
        // near-sandbox and near-api use different AccountId crates; go through the string.
        self.sandbox.create_account(name.parse()?).initial_balance(NearToken::from_near(near)).send().await?;
        Ok(name.parse()?)
    }
    async fn call(&self, who: &AccountId, contract: &AccountId, method: &str, args: Value, deposit_yocto: u128, tgas: u64) -> TestResult<Value> {
        let r = Contract(contract.clone()).call_function(method, args).transaction()
            .deposit(NearToken::from_yoctonear(deposit_yocto)).gas(NearGas::from_tgas(tgas))
            .with_signer(who.clone(), self.signer.clone()).send_to(&self.net).await?;
        let ok = r.assert_success();
        Ok(ok.json::<Value>().unwrap_or(Value::Null))
    }
    async fn view(&self, contract: &AccountId, method: &str, args: Value) -> TestResult<Value> {
        Ok(Contract(contract.clone()).call_function(method, args).read_only::<Value>().fetch_from(&self.net).await?.data)
    }
    async fn now(&self, mocks: &AccountId) -> TestResult<u64> { Ok(self.view(mocks, "now_secs", json!({})).await?.as_u64().unwrap()) }
}

struct Setup { w: World, usdc: AccountId, pyth: AccountId, wl: AccountId, validator: AccountId, pool: AccountId, owner: AccountId, whale: AccountId }

async fn setup() -> TestResult<Setup> {
    let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
    let net = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
    let signer = Signer::from_secret_key(near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse()?)?;
    let w = World { sandbox, net, signer };
    let usdc = w.account("usdc.sandbox", 50).await?;
    let pyth = w.account("pyth.sandbox", 50).await?;
    let wl = w.account("whitelist.sandbox", 50).await?;
    let validator = w.account("validator.sandbox", 50).await?;
    let pool = w.account("pool.sandbox", 50).await?;
    let owner = w.account("owner.sandbox", 10).await?;
    let whale = w.account("whale.sandbox", 20_000).await?;
    let junior = w.account("junior.sandbox", 10).await?;
    let senior = w.account("senior.sandbox", 10).await?;
    for m in [&usdc, &pyth, &wl, &validator] {
        Contract::deploy(m.clone()).use_code(wasm("ankora_mocks")).with_init_call("new", json!({}))?.with_signer(w.signer.clone()).send_to(&w.net).await?.assert_success();
    }
    Contract::deploy(pool.clone()).use_code(wasm_at("ankora_pool_testclock", "ankora_pool"))
        .with_init_call("new", json!({"owner": owner, "usdc": usdc, "pyth": pyth, "price_id": PRICE_ID, "whitelist": wl}))?
        .with_signer(w.signer.clone()).send_to(&w.net).await?.assert_success();
    w.call(&wl, &wl, "add_staking_pool", json!({"staking_pool_account_id": validator}), 0, 30).await?;
    for (who, amount, tranche) in [(&junior, 3_000 * U, "junior"), (&senior, 17_000 * U, "senior")] {
        w.call(&usdc, &usdc, "mint", json!({"account_id": who, "amount": amount.to_string()}), 0, 30).await?;
        w.call(who, &usdc, "ft_transfer_call", json!({"receiver_id": pool, "amount": amount.to_string(), "msg": json!({"deposit": tranche}).to_string()}), 1, 200).await?;
    }
    Ok(Setup { w, usdc, pyth, wl, validator, pool, owner, whale })
}

async fn set_price(s: &Setup, price: i64) -> TestResult<()> {
    let p = price.to_string();
    s.w.call(&s.pyth, &s.pyth, "set_prices", json!({"spot": p, "ema": p, "conf": "0"}), 0, 30).await?;
    Ok(())
}
/// Moves the pool's and the mock Pyth's clocks together (sandbox fast-forward is ~60 blocks/s, far too slow for days).
async fn advance(s: &Setup, secs: u64) -> TestResult<()> {
    s.w.call(&s.owner, &s.pool, "test_advance_clock", json!({"secs": secs}), 0, 30).await?;
    s.w.call(&s.pyth, &s.pyth, "advance_clock", json!({"secs": secs}), 0, 30).await?;
    s.w.sandbox.fast_forward(2).await?;
    Ok(())
}
async fn loan(s: &Setup) -> TestResult<Value> { s.w.view(&s.pool, "get_loan", json!({"id": 0})).await }
fn u(v: &Value) -> u128 { v.as_str().unwrap().parse().unwrap() }
async fn usdc_of(s: &Setup, who: &AccountId) -> TestResult<u128> { Ok(u(&s.w.view(&s.usdc, "ft_balance_of", json!({"account_id": who})).await?)) }

async fn borrow(s: &Setup) -> TestResult<()> {
    set_price(s, 362_000_000).await?;
    s.w.call(&s.whale, &s.pool, "borrow", json!({"validator": s.validator, "principal": (14_000 * U).to_string(), "plan": "P40"}), 10_001_500 * NEAR_Y / 1_000, 300).await?;
    Ok(())
}

#[tokio::test]
async fn native_borrow_repay_release() -> TestResult<()> {
    let s = setup().await?;
    borrow(&s).await?;
    let l = loan(&s).await?;
    assert_eq!(l["state"], "Active");
    let interest = u(&l["term_interest"]);
    assert_eq!(usdc_of(&s, &s.whale).await?, 14_000 * U - interest, "borrower got principal minus prepaid interest");
    let vault: AccountId = l["vault"].as_str().unwrap().parse()?;
    let staked = u(&s.w.view(&s.validator, "get_account_staked_balance", json!({"account_id": vault})).await?);
    assert_eq!(staked, u(&l["collateral"]), "collateral is staked with the borrower's validator");
    assert!(staked > 9_999 * NEAR_Y, "about 10,000 NEAR staked, got {staked}");
    assert_eq!(s.w.view(&vault, "get_info", json!({})).await?["owner"], s.pool.as_str());

    s.w.call(&s.whale, &s.usdc, "mint", json!({"account_id": s.whale, "amount": interest.to_string()}), 0, 30).await?;
    s.w.call(&s.whale, &s.usdc, "ft_transfer_call", json!({"receiver_id": s.pool, "amount": (14_000 * U).to_string(), "msg": r#"{"repay":0}"#}), 1, 200).await?;
    assert_eq!(loan(&s).await?["state"], "Closed");
    assert_eq!(s.w.view(&vault, "get_info", json!({})).await?["owner"], s.whale.as_str(), "vault handed back to the borrower");
    s.w.call(&s.whale, &vault, "unstake_all", json!({}), 1, 100).await?;
    Ok(())
}

#[tokio::test]
async fn stale_price_refunds_borrower() -> TestResult<()> {
    let s = setup().await?;
    let before = near_api::Tokens::account(s.whale.clone()).near_balance().fetch_from(&s.w.net).await?.total;
    // No price set: Pyth returns None, so the borrow must cancel and refund.
    s.w.call(&s.whale, &s.pool, "borrow", json!({"validator": s.validator, "principal": (14_000 * U).to_string(), "plan": "P40"}), 10_001_500 * NEAR_Y / 1_000, 300).await?;
    assert!(loan(&s).await?.is_null());
    let after = near_api::Tokens::account(s.whale.clone()).near_balance().fetch_from(&s.w.net).await?.total;
    assert!(before.as_yoctonear() - after.as_yoctonear() < NEAR_Y / 10, "only gas spent, NEAR refunded");
    assert_eq!(u(&s.w.view(&s.pool, "get_ledger", json!({})).await?["reserved"]), 0);
    Ok(())
}

#[tokio::test]
async fn renewal_notice_auction_returns_surplus() -> TestResult<()> {
    let s = setup().await?;
    borrow(&s).await?;
    let l = loan(&s).await?;
    let debt = u(&l["debt"]);
    let whale_usdc = usdc_of(&s, &s.whale).await?;
    // Each window runs from the block time its settle landed, so aim at the loan's own deadline, not computed constants.
    for want in ["NoticeStarted", "GraceStarted", "AuctionStarted"] {
        let t = loan(&s).await?["deadline"].as_u64().unwrap();
        let now = s.w.now(&s.pyth).await?;
        if t + 1 > now { advance(&s, t + 1 - now).await?; }
        set_price(&s, 150_000_000).await?;
        let out = s.w.call(&s.whale, &s.pool, "settle", json!({"id": 0}), 0, 100).await?;
        assert_eq!(out, want);
    }
    let l = loan(&s).await?;
    assert_eq!(l["state"], "Auction");
    let price = u(&l["auction_price"]);
    let bidder = s.w.account("bidder.sandbox", 10).await?;
    s.w.call(&s.usdc, &s.usdc, "mint", json!({"account_id": bidder, "amount": (price + 1_000 * U).to_string()}), 0, 30).await?;
    s.w.call(&bidder, &s.usdc, "ft_transfer_call", json!({"receiver_id": s.pool, "amount": price.to_string(), "msg": r#"{"bid":0}"#}), 1, 200).await?;
    let l = loan(&s).await?;
    assert_eq!(l["state"], "Closed");
    let vault: AccountId = l["vault"].as_str().unwrap().parse()?;
    assert_eq!(s.w.view(&vault, "get_info", json!({})).await?["owner"], bidder.as_str(), "winning bidder owns the vault");
    assert!(price > debt, "auction started above the debt");
    let surplus = usdc_of(&s, &s.whale).await? - whale_usdc;
    assert!(surplus + 2 * U >= price - debt && surplus <= price - debt, "borrower got the surplus: {surplus} vs {}", price - debt);
    Ok(())
}

async fn near_of(s: &Setup, who: &AccountId) -> TestResult<u128> {
    Ok(near_api::Tokens::account(who.clone()).near_balance().fetch_from(&s.w.net).await?.total.as_yoctonear())
}

/// The vault exists and holds the NEAR, then its own callback panics (here: the whitelist answers a non-bool).
/// The pool must hand the vault to the borrower, not refund the same NEAR a second time from its own balance.
#[tokio::test]
async fn stake_panic_after_vault_exists_hands_vault_to_borrower() -> TestResult<()> {
    let s = setup().await?;
    s.w.call(&s.wl, &s.wl, "set_garbage_whitelist", json!({"on": true}), 0, 30).await?;
    let pool_before = near_of(&s, &s.pool).await?;
    let whale_before = near_of(&s, &s.whale).await?;
    borrow(&s).await?;
    assert!(loan(&s).await?.is_null(), "no loan booked");
    assert_eq!(u(&s.w.view(&s.pool, "get_ledger", json!({})).await?["reserved"]), 0, "cover released");
    let vault: AccountId = format!("v0.{}", s.pool).parse()?;
    let info = s.w.view(&vault, "get_info", json!({})).await?;
    assert_eq!(info["owner"], s.whale.as_str(), "vault handed to the borrower");
    let vault_near = near_of(&s, &vault).await?;
    assert!(vault_near > 10_000 * NEAR_Y, "the NEAR stayed in the vault: {vault_near}");
    let pool_after = near_of(&s, &s.pool).await?;
    assert!(pool_after + NEAR_Y >= pool_before, "pool paid no second refund: {pool_before} -> {pool_after}");
    let whale_mid = near_of(&s, &s.whale).await?;
    assert!(whale_before - whale_mid > 10_000 * NEAR_Y, "borrower was not refunded from the pool's balance");
    // The borrower takes the NEAR out of the vault it now owns.
    s.w.call(&s.whale, &vault, "transfer", json!({"to": s.whale, "amount": (10_000 * NEAR_Y).to_string()}), 1, 30).await?;
    assert!(whale_before - near_of(&s, &s.whale).await? < 2 * NEAR_Y, "borrower is whole apart from gas and vault storage");
    Ok(())
}
