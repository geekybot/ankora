//! TEST NETWORKS ONLY (sandbox, testnet; never mainnet: `mint` is open). One contract that stands in for USDC (NEP-141 subset), Pyth, the lockup whitelist and a staking pool.
//! Deployed to four sandbox accounts, each using its own subset. On testnet: test USDC (open mint, a faucet) and the
//! price relay (Pyth-shaped views; only the deploying account can set prices, the clock or the whitelist).
use near_sdk::json_types::{I64, U128, U64};
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{env, ext_contract, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue, PromiseResult};

#[ext_contract(ext_receiver)]
pub trait Receiver {
    fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128>;
}

#[near(serializers = [json])]
#[derive(Clone)]
pub struct Price { pub price: I64, pub conf: U64, pub expo: i32, pub publish_time: i64 }

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Mock {
    balances: LookupMap<AccountId, u128>,
    pools: LookupSet<AccountId>,
    staked: LookupMap<AccountId, u128>,
    unstaked: LookupMap<AccountId, u128>,
    clock_offset: u64,
    spot: i64,
    ema: i64,
    conf: u64,
    price_ts: u64,
    /// Test switch: `is_whitelisted` answers a non-bool, so the caller's callback fails to parse it.
    garbage_whitelist: bool,
    /// The deploying account. Sets prices, the clock and the whitelist.
    owner: AccountId,
}

fn now_base() -> u64 { env::block_timestamp() / 1_000_000_000 }

impl Mock {
    fn now(&self) -> u64 { now_base() + self.clock_offset }
    fn only_owner(&self) { require!(env::predecessor_account_id() == self.owner, "owner only"); }
    fn bal(&self, a: &AccountId) -> u128 { self.balances.get(a).copied().unwrap_or(0) }
    fn mv(&mut self, from: &AccountId, to: &AccountId, amount: u128) {
        let f = self.bal(from);
        require!(f >= amount, "not enough balance");
        self.balances.insert(from.clone(), f - amount);
        let t = self.bal(to);
        self.balances.insert(to.clone(), t + amount);
    }
    fn price(&self, p: i64, age: u64) -> Option<Price> {
        if self.price_ts == 0 || self.now().abs_diff(self.price_ts) > age { return None; }
        Some(Price { price: I64(p), conf: U64(self.conf), expo: -8, publish_time: self.price_ts as i64 })
    }
}

#[near]
impl Mock {
    #[init]
    pub fn new() -> Self {
        Self { balances: LookupMap::new(b"b"), pools: LookupSet::new(b"p"), staked: LookupMap::new(b"s"), unstaked: LookupMap::new(b"u"), clock_offset: 0, spot: 0, ema: 0, conf: 0, price_ts: 0, garbage_whitelist: false, owner: env::predecessor_account_id() }
    }

    // ---- USDC (NEP-141 subset, no storage registration) ----
    pub fn mint(&mut self, account_id: AccountId, amount: U128) {
        let b = self.bal(&account_id);
        self.balances.insert(account_id, b + amount.0);
    }
    pub fn ft_balance_of(&self, account_id: AccountId) -> U128 { U128(self.bal(&account_id)) }
    #[payable]
    pub fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        require!(env::attached_deposit() == NearToken::from_yoctonear(1), "attach 1 yocto");
        let _ = memo;
        self.mv(&env::predecessor_account_id(), &receiver_id, amount.0);
    }
    #[payable]
    pub fn ft_transfer_call(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>, msg: String) -> Promise {
        require!(env::attached_deposit() == NearToken::from_yoctonear(1), "attach 1 yocto");
        let _ = memo;
        let sender = env::predecessor_account_id();
        self.mv(&sender, &receiver_id, amount.0);
        ext_receiver::ext(receiver_id.clone()).with_static_gas(Gas::from_tgas(80)).ft_on_transfer(sender.clone(), amount, msg)
            .then(Self::ext(env::current_account_id()).with_static_gas(Gas::from_tgas(10)).ft_resolve_transfer(sender, receiver_id, amount))
    }
    #[private]
    pub fn ft_resolve_transfer(&mut self, sender_id: AccountId, receiver_id: AccountId, amount: U128) -> U128 {
        let unused = match env::promise_result(0) {
            PromiseResult::Successful(v) => near_sdk::serde_json::from_slice::<U128>(&v).map(|u| u.0.min(amount.0)).unwrap_or(amount.0),
            _ => amount.0,
        };
        let back = unused.min(self.bal(&receiver_id));
        if back > 0 { self.mv(&receiver_id, &sender_id, back); }
        U128(amount.0 - back)
    }

    // ---- Pyth ----
    /// `publish_time`: the source's time when relaying (so staleness is measured from the source), else now.
    pub fn set_prices(&mut self, spot: I64, ema: I64, conf: U64, publish_time: Option<i64>) {
        self.only_owner();
        self.spot = spot.0; self.ema = ema.0; self.conf = conf.0;
        self.price_ts = publish_time.map(|t| t as u64).unwrap_or_else(|| self.now());
    }
    pub fn get_price_no_older_than(&self, price_id: String, age: u64) -> Option<Price> { let _ = price_id; self.price(self.spot, age) }
    pub fn get_ema_price_no_older_than(&self, price_id: String, age: u64) -> Option<Price> { let _ = price_id; self.price(self.ema, age) }

    // ---- Lockup whitelist ----
    pub fn add_staking_pool(&mut self, staking_pool_account_id: AccountId) { self.only_owner(); self.pools.insert(staking_pool_account_id); }
    pub fn is_whitelisted(&self, staking_pool_account_id: AccountId) -> near_sdk::serde_json::Value {
        if self.garbage_whitelist { return near_sdk::serde_json::json!("garbage"); }
        near_sdk::serde_json::json!(self.pools.contains(&staking_pool_account_id))
    }
    pub fn set_garbage_whitelist(&mut self, on: bool) { self.only_owner(); self.garbage_whitelist = on; }

    // ---- Staking pool (unstake is instant here) ----
    #[payable]
    pub fn deposit_and_stake(&mut self) {
        let a = env::predecessor_account_id();
        let s = self.staked.get(&a).copied().unwrap_or(0);
        self.staked.insert(a, s + env::attached_deposit().as_yoctonear());
    }
    pub fn unstake_all(&mut self) {
        let a = env::predecessor_account_id();
        let s = self.staked.insert(a.clone(), 0).unwrap_or(0);
        let u = self.unstaked.get(&a).copied().unwrap_or(0);
        self.unstaked.insert(a, u + s);
    }
    pub fn withdraw_all(&mut self) -> Promise {
        let a = env::predecessor_account_id();
        let u = self.unstaked.insert(a.clone(), 0).unwrap_or(0);
        Promise::new(a).transfer(NearToken::from_yoctonear(u))
    }
    pub fn get_account_staked_balance(&self, account_id: AccountId) -> U128 { U128(self.staked.get(&account_id).copied().unwrap_or(0)) }

    /// Sandbox clock, so tests can fast-forward to exact deadlines.
    pub fn now_secs(&self) -> u64 { self.now() }
    /// Moves this mock's clock (Pyth publish times) in step with the pool's test clock.
    pub fn advance_clock(&mut self, secs: u64) { self.only_owner(); self.clock_offset += secs; }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const T0: u64 = 1_800_000_000;
    fn set(pred: &str, ts: u64) {
        let mut b = VMContextBuilder::new();
        b.current_account_id("relay.testnet".parse().unwrap()).predecessor_account_id(pred.parse().unwrap()).block_timestamp(ts * 1_000_000_000);
        testing_env!(b.build());
    }
    fn relay() -> Mock { set("relay.testnet", T0); Mock::new() }

    #[test]
    #[should_panic(expected = "owner only")]
    fn strangers_cannot_set_prices() {
        let mut m = relay();
        set("stranger.testnet", T0);
        m.set_prices(I64(1), I64(1), U64(0), None);
    }

    #[test]
    #[should_panic(expected = "owner only")]
    fn strangers_cannot_move_the_clock() {
        let mut m = relay();
        set("stranger.testnet", T0);
        m.advance_clock(86_400);
    }

    #[test]
    #[should_panic(expected = "owner only")]
    fn strangers_cannot_whitelist_validators() {
        let mut m = relay();
        set("stranger.testnet", T0);
        m.add_staking_pool("evil.testnet".parse().unwrap());
    }

    #[test]
    fn relayed_price_keeps_the_source_publish_time() {
        let mut m = relay();
        m.set_prices(I64(355_500_672), I64(354_000_000), U64(380_995), Some(T0 as i64 - 30));
        set("anyone.testnet", T0 + 25);
        let p = m.get_price_no_older_than("id".into(), 60).expect("55 s old is inside 60 s");
        assert_eq!((p.price.0, p.publish_time), (355_500_672, T0 as i64 - 30));
        assert_eq!(m.get_ema_price_no_older_than("id".into(), 60).unwrap().price.0, 354_000_000);
        set("anyone.testnet", T0 + 31);
        assert!(m.get_price_no_older_than("id".into(), 60).is_none(), "61 s after the source published: stale");
    }

    #[test]
    fn test_usdc_mint_stays_open() {
        let mut m = relay();
        set("judge.testnet", T0);
        m.mint("judge.testnet".parse().unwrap(), U128(1_000_000_000));
        assert_eq!(m.ft_balance_of("judge.testnet".parse().unwrap()).0, 1_000_000_000);
    }
}
