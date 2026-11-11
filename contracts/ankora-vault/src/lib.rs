//! Ankora vault: one account per loan. Holds the borrower's NEAR staked with the borrower's own validator.
//! The pool can only (1) stake once and (2) hand the vault to a new owner. No upgrade method, no Ankora keys.
use near_sdk::json_types::U128;
use near_sdk::{env, ext_contract, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError, PromiseOrValue, PublicKey};

const GAS_VIEW: Gas = Gas::from_tgas(5);
const GAS_STAKE: Gas = Gas::from_tgas(50);
const GAS_CB: Gas = Gas::from_tgas(15);
const BUFFER: NearToken = NearToken::from_millinear(50);

#[ext_contract(ext_whitelist)]
pub trait Whitelist { fn is_whitelisted(&self, staking_pool_account_id: AccountId) -> bool; }

#[ext_contract(ext_staking_pool)]
pub trait StakingPool {
    fn deposit_and_stake(&mut self);
    fn unstake_all(&mut self);
    fn withdraw_all(&mut self);
}

#[near(serializers = [json])]
pub struct VaultInfo { pub pool: AccountId, pub borrower: AccountId, pub validator: AccountId, pub owner: AccountId, pub released: bool, pub staked: U128 }

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Vault { pool: AccountId, borrower: AccountId, validator: AccountId, whitelist: AccountId, owner: AccountId, released: bool, staked: u128, stake_started: bool }

impl Vault {
    fn only_pool(&self) { require!(env::predecessor_account_id() == self.pool, "only the pool"); }
    fn only_owner_after_release(&self) {
        require!(self.released, "vault is locked while the loan is open");
        require!(env::predecessor_account_id() == self.owner, "only the owner");
    }
    /// NEAR this account must keep for its own storage.
    fn reserve() -> NearToken { env::storage_byte_cost().saturating_mul(env::storage_usage() as u128).saturating_add(BUFFER) }
    fn free_balance() -> NearToken { env::account_balance().saturating_sub(Self::reserve()) }
}

#[near]
impl Vault {
    #[init]
    pub fn new(pool: AccountId, borrower: AccountId, validator: AccountId, whitelist: AccountId) -> Self {
        require!(env::predecessor_account_id() == pool, "only the pool");
        Self { owner: pool.clone(), pool, borrower, validator, whitelist, released: false, staked: 0, stake_started: false }
    }

    /// Pool only, once: check the validator against the lockup whitelist, then stake everything above the storage reserve.
    pub fn stake(&mut self) -> Promise {
        self.only_pool();
        require!(!self.stake_started, "stake runs only once");
        self.stake_started = true;
        ext_whitelist::ext(self.whitelist.clone()).with_static_gas(GAS_VIEW).is_whitelisted(self.validator.clone())
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_STAKE.saturating_add(GAS_CB).saturating_add(GAS_CB)).on_whitelist())
    }

    #[private]
    pub fn on_whitelist(&mut self, #[callback_result] ok: Result<bool, PromiseError>) -> PromiseOrValue<U128> {
        let amount = Self::free_balance();
        if ok != Ok(true) {
            if !amount.is_zero() { Promise::new(self.borrower.clone()).transfer(amount).detach(); }
            return PromiseOrValue::Value(U128(0));
        }
        ext_staking_pool::ext(self.validator.clone()).with_attached_deposit(amount).with_static_gas(GAS_STAKE).deposit_and_stake()
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CB).on_staked(U128(amount.as_yoctonear())))
            .into()
    }

    /// A failed deposit is refunded to this account by the protocol; pass it back to the borrower.
    #[private]
    pub fn on_staked(&mut self, amount: U128, #[callback_result] ok: Result<(), PromiseError>) -> U128 {
        if ok.is_ok() { self.staked = amount.0; return amount; }
        let refund = Self::free_balance();
        if !refund.is_zero() { Promise::new(self.borrower.clone()).transfer(refund).detach(); }
        U128(0)
    }

    /// Pool only, once: the borrower after repayment, the winning bidder after an auction, or the pool after an unsold auction.
    pub fn release(&mut self, new_owner: AccountId) {
        self.only_pool();
        require!(!self.released, "release happens only once");
        self.owner = new_owner;
        self.released = true;
    }

    #[payable]
    pub fn unstake_all(&mut self) -> Promise {
        near_sdk::assert_one_yocto();
        self.only_owner_after_release();
        ext_staking_pool::ext(self.validator.clone()).with_static_gas(GAS_STAKE).unstake_all()
    }

    #[payable]
    pub fn withdraw_all(&mut self) -> Promise {
        near_sdk::assert_one_yocto();
        self.only_owner_after_release();
        ext_staking_pool::ext(self.validator.clone()).with_static_gas(GAS_STAKE).withdraw_all()
    }

    #[payable]
    pub fn transfer(&mut self, to: AccountId, amount: U128) -> Promise {
        near_sdk::assert_one_yocto();
        self.only_owner_after_release();
        let a = NearToken::from_yoctonear(amount.0);
        require!(a <= Self::free_balance(), "amount above free balance");
        Promise::new(to).transfer(a)
    }

    /// Gives the owner full control of this account, so stake never has to move.
    #[payable]
    pub fn add_full_access_key(&mut self, public_key: PublicKey) -> Promise {
        near_sdk::assert_one_yocto();
        self.only_owner_after_release();
        Promise::new(env::current_account_id()).add_full_access_key(public_key)
    }

    pub fn get_info(&self) -> VaultInfo {
        VaultInfo { pool: self.pool.clone(), borrower: self.borrower.clone(), validator: self.validator.clone(), owner: self.owner.clone(), released: self.released, staked: U128(self.staked) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::{testing_env, NearToken};

    fn ctx(predecessor: AccountId) -> VMContextBuilder {
        let mut b = VMContextBuilder::new();
        b.current_account_id("v1.pool.testnet".parse().unwrap())
            .predecessor_account_id(predecessor)
            .attached_deposit(NearToken::from_yoctonear(1)) // owner calls attach 1 yocto, as a wallet would
            .account_balance(NearToken::from_near(10_002));
        b
    }
    fn pool() -> AccountId { "pool.testnet".parse().unwrap() }
    fn vault() -> Vault {
        testing_env!(ctx(pool()).build());
        Vault::new(pool(), accounts(1), "bisontrails.poolv1.near".parse().unwrap(), "lockup-whitelist.near".parse().unwrap())
    }

    #[test]
    fn owner_is_pool_until_release() {
        let v = vault();
        assert_eq!(v.get_info().owner, pool());
        assert!(!v.get_info().released);
    }

    #[test]
    #[should_panic(expected = "only the pool")]
    fn stake_by_anyone_else_panics() {
        let mut v = vault();
        testing_env!(ctx(accounts(1)).build());
        let _ = v.stake();
    }

    #[test]
    #[should_panic(expected = "only the pool")]
    fn release_by_anyone_else_panics() {
        let mut v = vault();
        testing_env!(ctx(accounts(1)).build());
        v.release(accounts(1));
    }

    #[test]
    #[should_panic(expected = "vault is locked")]
    fn borrower_cannot_unstake_before_release() {
        let mut v = vault();
        testing_env!(ctx(accounts(1)).build());
        let _ = v.unstake_all();
    }

    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn owner_transfer_needs_one_yocto_so_the_wallet_confirms() {
        let mut v = vault();
        v.release(accounts(1));
        testing_env!(ctx(accounts(1)).attached_deposit(NearToken::from_yoctonear(0)).build());
        let _ = v.transfer(accounts(1), U128(1));
    }

    #[test]
    fn owner_transfer_with_one_yocto_works() {
        let mut v = vault();
        v.release(accounts(1));
        testing_env!(ctx(accounts(1)).attached_deposit(NearToken::from_yoctonear(1)).build());
        let _ = v.transfer(accounts(1), U128(1));
    }

    #[test]
    #[should_panic(expected = "only the owner")]
    fn stranger_cannot_unstake_after_release() {
        let mut v = vault();
        v.release(accounts(1));
        testing_env!(ctx(accounts(2)).build());
        let _ = v.unstake_all();
    }

    #[test]
    fn borrower_controls_vault_after_release() {
        let mut v = vault();
        v.release(accounts(1));
        assert_eq!(v.get_info().owner, accounts(1));
        testing_env!(ctx(accounts(1)).build());
        let _ = v.unstake_all();
        let _ = v.withdraw_all();
    }

    #[test]
    #[should_panic(expected = "only once")]
    fn pool_cannot_release_twice() {
        let mut v = vault();
        v.release(accounts(1));
        testing_env!(ctx(pool()).build());
        v.release(pool());
    }

    #[test]
    fn rejected_validator_refunds_and_reports_zero() {
        let mut v = vault();
        testing_env!(ctx("v1.pool.testnet".parse().unwrap()).build());
        match v.on_whitelist(Ok(false)) {
            near_sdk::PromiseOrValue::Value(x) => assert_eq!(x.0, 0),
            _ => panic!("expected a value"),
        }
    }

    #[test]
    fn failed_stake_reports_zero_and_success_records_amount() {
        let mut v = vault();
        testing_env!(ctx("v1.pool.testnet".parse().unwrap()).build());
        assert_eq!(v.on_staked(U128(5), Err(near_sdk::PromiseError::Failed)).0, 0);
        assert_eq!(v.on_staked(U128(7), Ok(())).0, 7);
        assert_eq!(v.get_info().staked.0, 7);
    }
}
