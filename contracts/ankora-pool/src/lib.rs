//! Ankora pool: lender tranches, loan book, oracle checks and settlement. Logic lives in `ankora-core`.
//! Borrow flow: price first (Pyth spot + EMA), then create the vault and stake, then pay out USDC.
//! A bad price refunds the borrower's NEAR before anything is staked.
use near_sdk::json_types::{I64, U128, U64};
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError, PromiseOrValue};
use ankora_core::loans::{Loan, LoanState, RepayOutcome, SettleOutcome, AUCTION_SECS};
use ankora_core::math::{collateral_value_usdc, ltv_bps};
use ankora_core::oracle::{collateral_price, PythPrice, MAX_PRICE_AGE_SECS};
use ankora_core::plans::{plan, PlanId, VolState};
use ankora_core::tranche::{Ledger, Tranche};

const VAULT_WASM: &[u8] = include_bytes!("../../target/near/ankora_vault/ankora_vault.wasm");
/// NEAR each vault keeps for its own storage (121 KB of code plus state).
const VAULT_RESERVE: NearToken = NearToken::from_millinear(1_500);
const MIN_ATTACHED: NearToken = NearToken::from_near(5);
/// Smallest lender deposit (6 dp): each position costs the pool storage.
#[cfg(not(feature = "mainnet"))]
const MIN_DEPOSIT: u128 = 10_000_000;
/// Mainnet: 0.5 USDC, so a first cross-chain deposit can be tiny (1 USDC sent through 1Click arrives as ~0.995).
#[cfg(feature = "mainnet")]
const MIN_DEPOSIT: u128 = 500_000;
/// Mainnet launch caps, in the code so no owner call can raise them: raising them is a visible upgrade.
/// The contract is unaudited; the caps bound what anyone, the team included, can put at risk.
#[cfg(feature = "mainnet")]
pub const CAP_DEPOSITS: u128 = 200_000_000; // cash + loans, 200 USDC
#[cfg(feature = "mainnet")]
pub const CAP_LOANS: u128 = 100_000_000; // outstanding + reserved, 100 USDC
const MIN_GAS: Gas = Gas::from_tgas(220);
const GAS_PYTH: Gas = Gas::from_tgas(10);
const GAS_ON_PRICED: Gas = Gas::from_tgas(170);
const GAS_VAULT_INIT: Gas = Gas::from_tgas(10);
const GAS_VAULT_STAKE: Gas = Gas::from_tgas(100);
const GAS_ON_STAKED: Gas = Gas::from_tgas(35);
const GAS_FT: Gas = Gas::from_tgas(10);
const GAS_CB: Gas = Gas::from_tgas(10);
const GAS_PROBE: Gas = Gas::from_tgas(5);
const GAS_ON_SETTLE: Gas = Gas::from_tgas(40);

#[ext_contract(ext_pyth)]
pub trait Pyth {
    fn get_price_no_older_than(&self, price_id: String, age: u64) -> Option<PythPriceJson>;
    fn get_ema_price_no_older_than(&self, price_id: String, age: u64) -> Option<PythPriceJson>;
}
#[ext_contract(ext_vault)]
pub trait Vault {
    fn stake(&mut self) -> U128;
    fn release(&mut self, new_owner: AccountId);
    fn get_info(&self) -> near_sdk::serde_json::Value;
}
#[ext_contract(ext_ft)]
pub trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

/// Pyth NEAR's `Price` JSON.
#[near(serializers = [json])]
#[derive(Clone)]
pub struct PythPriceJson { pub price: I64, pub conf: U64, pub expo: i32, pub publish_time: i64 }
impl From<PythPriceJson> for PythPrice {
    fn from(p: PythPriceJson) -> Self { PythPrice { price: p.price.0, conf: p.conf.0, expo: p.expo, publish_time: p.publish_time } }
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PlanArg { P30, P40, P50 }
impl From<PlanArg> for PlanId {
    fn from(p: PlanArg) -> Self { match p { PlanArg::P30 => PlanId::P30, PlanArg::P40 => PlanId::P40, PlanArg::P50 => PlanId::P50 } }
}

#[near(serializers = [json])]
#[serde(rename_all = "lowercase")]
#[derive(Clone, Copy)]
pub enum TrancheArg { Senior, Junior }
impl From<TrancheArg> for Tranche {
    fn from(t: TrancheArg) -> Self { match t { TrancheArg::Senior => Tranche::Senior, TrancheArg::Junior => Tranche::Junior } }
}

/// `msg` of `ft_transfer_call` into the pool.
#[near(serializers = [json])]
#[serde(rename_all = "lowercase")]
pub enum FtMsg { Deposit(TrancheArg), DepositFor(DepositFor), Repay(u64), Bid(u64), Recovery(u64) }
/// `{"depositfor":{"tranche":"senior","account":"alice.near"}}`: the shares go to `account`, not to the sender.
/// For deposits relayed by NEAR Intents from another chain, where the sender is the intents contract.
#[near(serializers = [json])]
pub struct DepositFor { pub tranche: TrancheArg, pub account: AccountId }

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Pending { borrower: AccountId, validator: AccountId, principal: u128, plan: PlanId, attached: u128, price: Option<(i64, i32)> }

#[near(serializers = [borsh])]
#[derive(Clone, Default)]
pub struct Lender { senior_shares: u128, junior_shares: u128, junior_deposited_at: u64 }

#[near]
#[derive(BorshStorageKey)]
enum Key { Loans, Lenders, Pending, Claimable }

#[near(serializers = [json])]
pub struct LedgerView {
    pub cash: U128, pub outstanding: U128, pub unearned: U128, pub treasury: U128, pub reserved: U128,
    pub nav: U128, pub senior_value: U128, pub junior_value: U128, pub senior_shares: U128, pub junior_shares: U128, pub utilisation_bps: u32,
}
/// One auction, from start to its end. Stored under its own storage keys (not in the contract's state struct),
/// so adding it needs no state migration. outcome: "live", "sold", "repaid" (borrower stopped it) or "no_buyer".
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct AuctionRecord {
    pub id: u64,
    pub started_at: u64,
    pub start_value: U128,
    pub debt: U128,
    pub collateral: U128,
    pub validator: String,
    pub outcome: String,
    pub ended_at: u64,
    pub price: U128,
    pub buyer: Option<AccountId>,
    pub surplus: U128,
}
const AUC_N: &[u8] = b"auc:n";
fn auc_key(i: u64) -> Vec<u8> { [b"auc:r".as_slice(), &i.to_le_bytes()].concat() }
fn auc_idx_key(loan: u64) -> Vec<u8> { [b"auc:l".as_slice(), &loan.to_le_bytes()].concat() }
fn auc_count() -> u64 { env::storage_read(AUC_N).map(|b| u64::from_le_bytes(b.try_into().unwrap_or([0; 8]))).unwrap_or(0) }
fn auc_put(i: u64, r: &AuctionRecord) { env::storage_write(&auc_key(i), &near_sdk::borsh::to_vec(r).unwrap()); }
fn auc_get(i: u64) -> Option<AuctionRecord> { env::storage_read(&auc_key(i)).and_then(|b| near_sdk::borsh::from_slice(&b).ok()) }
/// Open a record when a loan's auction starts.
fn auc_open(l: &Loan, t: u64) {
    let start_value = match l.state { LoanState::Auction { start_value, .. } => start_value, _ => 0 };
    let i = auc_count();
    auc_put(i, &AuctionRecord { id: l.id, started_at: t, start_value: U128(start_value), debt: U128(l.debt), collateral: U128(l.collateral_yocto), validator: l.validator.clone(),
        outcome: "live".into(), ended_at: 0, price: U128(0), buyer: None, surplus: U128(0) });
    env::storage_write(&auc_idx_key(l.id), &i.to_le_bytes());
    env::storage_write(AUC_N, &(i + 1).to_le_bytes());
}
/// Close the loan's open record with how it ended.
fn auc_close(loan: u64, outcome: &str, t: u64, price: u128, buyer: Option<AccountId>, surplus: u128) {
    let Some(i) = env::storage_read(&auc_idx_key(loan)).map(|b| u64::from_le_bytes(b.try_into().unwrap_or([0; 8]))) else { return };
    let Some(mut r) = auc_get(i) else { return };
    if r.outcome != "live" { return; }
    r.outcome = outcome.into(); r.ended_at = t; r.price = U128(price); r.buyer = buyer; r.surplus = U128(surplus);
    auc_put(i, &r);
}

#[near(serializers = [json])]
pub struct LoanView {
    pub id: u64, pub borrower: AccountId, pub vault: AccountId, pub validator: AccountId, pub collateral: U128, pub debt: U128,
    pub plan: String, pub term_interest: U128, pub term_start: u64, pub expiry: u64, pub auto_renew: bool, pub state: String, pub auction_price: U128,
    /// When the next `settle` can act: term end, notice or grace end, auction end; 0 once closed or defaulted.
    pub deadline: u64,
}
#[near(serializers = [json])]
pub struct LenderView { pub senior_shares: U128, pub junior_shares: U128, pub junior_unlocks_at: u64 }
#[near(serializers = [json])]
pub struct PlanView { pub plan: String, pub ltv_cap_bps: u32, pub term_secs: u64, pub rate_bps: u32 }

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Pool {
    owner: AccountId,
    usdc: AccountId,
    pyth: AccountId,
    price_id: String,
    whitelist: AccountId,
    ledger: Ledger,
    loans: IterableMap<u64, Loan>,
    lenders: LookupMap<AccountId, Lender>,
    pending: LookupMap<u64, Pending>,
    /// Auction surplus whose transfer failed (borrower not registered on USDC); held outside the ledger.
    claimable: LookupMap<AccountId, u128>,
    next_id: u64,
    vol: VolState,
}

#[cfg(feature = "test-clock")]
const CLOCK_KEY: &[u8] = b"__test_clock_offset";

fn now() -> u64 {
    let base = env::block_timestamp() / 1_000_000_000;
    #[cfg(feature = "test-clock")]
    if let Some(v) = env::storage_read(CLOCK_KEY) { return base + u64::from_le_bytes(v.try_into().unwrap_or([0; 8])); }
    base
}
/// The accrual clock: (clock, wall time) at the last checkpoint, under its own storage key (no state migration).
/// It advances at the pool's utilisation, so Fixed's 6.5% accrues only on lent cash. Absent = starts now.
const ACC_KEY: &[u8] = b"acc:clock";
fn acc_read() -> Option<(u64, u64)> {
    env::storage_read(ACC_KEY).map(|b| (u64::from_le_bytes(b[..8].try_into().unwrap()), u64::from_le_bytes(b[8..16].try_into().unwrap())))
}
fn acc_write(clock: u64, wall: u64) { env::storage_write(ACC_KEY, &[clock.to_le_bytes(), wall.to_le_bytes()].concat()); }
fn state_name(s: LoanState) -> &'static str {
    match s { LoanState::Active => "Active", LoanState::Notice { .. } => "Notice", LoanState::Grace { .. } => "Grace",
        LoanState::Auction { .. } => "Auction", LoanState::Closed => "Closed", LoanState::Defaulted => "Defaulted" }
}
fn to_price(r: Result<Option<PythPriceJson>, PromiseError>) -> Option<PythPrice> { r.ok().flatten().map(Into::into) }

impl Pool {
    fn price_calls(&self) -> Promise {
        let age = MAX_PRICE_AGE_SECS as u64;
        let spot = ext_pyth::ext(self.pyth.clone()).with_static_gas(GAS_PYTH).get_price_no_older_than(self.price_id.clone(), age);
        // Mainnet's live source has no EMA: read spot twice, so the min(spot, EMA) and 3% breaker checks see spot == EMA.
        #[cfg(feature = "mainnet")]
        let second = ext_pyth::ext(self.pyth.clone()).with_static_gas(GAS_PYTH).get_price_no_older_than(self.price_id.clone(), age);
        #[cfg(not(feature = "mainnet"))]
        let second = ext_pyth::ext(self.pyth.clone()).with_static_gas(GAS_PYTH).get_ema_price_no_older_than(self.price_id.clone(), age);
        spot.and(second)
    }
    fn me() -> AccountId { env::current_account_id() }
    fn vault_id(id: u64) -> AccountId { format!("v{id}.{}", Self::me()).parse().unwrap() }
    /// Drop a borrow in flight: free the reserved cover and, if the NEAR is still here, send it back.
    fn fail_pending(&mut self, id: u64, refund: bool, why: &str) -> PromiseOrValue<bool> {
        if let Some(p) = self.pending.remove(&id) {
            self.ledger.release(p.principal);
            if refund { Promise::new(p.borrower).transfer(NearToken::from_yoctonear(p.attached)).detach(); }
        }
        env::log_str(&format!("borrow {id} cancelled: {why}"));
        PromiseOrValue::Value(false)
    }
    fn release_vault(vault: &AccountId, to: AccountId) {
        ext_vault::ext(vault.clone()).with_static_gas(GAS_CB).release(to).detach();
    }
    fn usdc_transfer(&self, to: AccountId, amount: u128, memo: &str) -> Promise {
        ext_ft::ext(self.usdc.clone()).with_attached_deposit(NearToken::from_yoctonear(1)).with_static_gas(GAS_FT).ft_transfer(to, U128(amount), Some(memo.into()))
    }
    /// Send auction surplus; if the transfer fails it becomes claimable instead of stranded.
    fn pay_surplus(&self, to: AccountId, amount: u128) {
        if amount == 0 { return; }
        self.usdc_transfer(to.clone(), amount, "ankora auction surplus")
            .then(Self::ext(Self::me()).with_static_gas(GAS_CB).on_surplus_paid(to, U128(amount)))
            .detach();
    }
    fn loan(&self, id: u64) -> Loan { self.loans.get(&id).cloned().unwrap_or_else(|| env::panic_str("no such loan")) }
    fn view(&self, l: &Loan) -> LoanView {
        LoanView {
            id: l.id, borrower: l.borrower.parse().unwrap(), vault: l.vault.parse().unwrap(), validator: l.validator.parse().unwrap(),
            collateral: U128(l.collateral_yocto), debt: U128(l.debt), plan: format!("{:?}", l.plan), term_interest: U128(l.term_interest),
            term_start: l.term_start, expiry: l.expiry, auto_renew: l.auto_renew, state: state_name(l.state).into(), auction_price: U128(l.auction_price(now())),
            deadline: match l.state {
                LoanState::Active => l.expiry,
                LoanState::Notice { until } | LoanState::Grace { until } => until,
                LoanState::Auction { start, .. } => start + AUCTION_SECS,
                LoanState::Closed | LoanState::Defaulted => 0,
            },
        }
    }
}

#[near]
impl Pool {
    /// The accrual clock now: the last checkpoint plus elapsed wall time scaled by utilisation since then.
    /// Utilisation only changes inside a call, and every call that changes it checkpoints first.
    fn clock(&self, wall: u64) -> u64 {
        let (c0, w0) = acc_read().unwrap_or((wall, wall));
        let g = &self.ledger;
        let base = g.cash + g.outstanding;
        let u_ppm = if base == 0 { 0 } else { g.outstanding.min(base) * 1_000_000 / base };
        c0 + (wall.saturating_sub(w0) as u128 * u_ppm / 1_000_000) as u64
    }
    fn checkpoint(&self, wall: u64) { acc_write(self.clock(wall), wall); }

    #[init]
    pub fn new(owner: AccountId, usdc: AccountId, pyth: AccountId, price_id: String, whitelist: AccountId) -> Self {
        require!(price_id.len() == 64, "price_id is 64 hex characters, no 0x");
        Self {
            owner, usdc, pyth, price_id, whitelist, ledger: Ledger::new(now()),
            loans: IterableMap::new(Key::Loans), lenders: LookupMap::new(Key::Lenders), pending: LookupMap::new(Key::Pending), claimable: LookupMap::new(Key::Claimable),
            next_id: 0, vol: VolState::Normal,
        }.started()
    }
    fn started(self) -> Self { acc_write(self.ledger.t0, self.ledger.t0); self }

    /// Attach the NEAR to stake (plus 1.5 NEAR vault storage) and at least 220 Tgas.
    /// A sandbox borrow burns about 49 Tgas; the rest is headroom for real validators and Pyth, refunded if unused.
    #[payable]
    pub fn borrow(&mut self, validator: AccountId, principal: U128, plan: PlanArg) -> Promise {
        let attached = env::attached_deposit();
        require!(attached >= MIN_ATTACHED, "attach at least 5 NEAR");
        require!(env::prepaid_gas() >= MIN_GAS, "attach at least 220 Tgas");
        require!(principal.0 > 0, "principal must be positive");
        require!(self.ledger.can_lend(principal.0, self.clock(now())), "junior cover or free cash too low for this loan");
        #[cfg(feature = "mainnet")]
        require!(self.ledger.outstanding + self.ledger.reserved + principal.0 <= CAP_LOANS, "mainnet cap: loans are limited to 100 USDC in total");
        self.ledger.reserve(principal.0);
        let id = self.next_id;
        self.next_id += 1;
        self.pending.insert(id, Pending { borrower: env::predecessor_account_id(), validator, principal: principal.0, plan: plan.into(), attached: attached.as_yoctonear(), price: None });
        self.price_calls().then(Self::ext(Self::me()).with_static_gas(GAS_ON_PRICED).on_priced(id))
    }

    #[private]
    pub fn on_priced(&mut self, id: u64, #[callback_result] spot: Result<Option<PythPriceJson>, PromiseError>, #[callback_result] ema: Result<Option<PythPriceJson>, PromiseError>) -> PromiseOrValue<bool> {
        let Some(mut p) = self.pending.get(&id).cloned() else { return PromiseOrValue::Value(false) };
        let px = match collateral_price(to_price(spot), to_price(ema), now() as i64, true) {
            Ok(px) => px,
            Err(e) => return self.fail_pending(id, true, &format!("{e:?}")),
        };
        let est = p.attached.saturating_sub(VAULT_RESERVE.as_yoctonear());
        let cap = plan(p.plan, self.vol).ltv_cap_bps;
        if ltv_bps(p.principal, collateral_value_usdc(est, px.0, px.1)) > cap { return self.fail_pending(id, true, "LTV above plan cap"); }
        p.price = Some(px);
        self.pending.insert(id, p.clone());
        let vault = Self::vault_id(id);
        let args = near_sdk::serde_json::json!({ "pool": Self::me(), "borrower": p.borrower, "validator": p.validator, "whitelist": self.whitelist }).to_string().into_bytes();
        Promise::new(vault.clone()).create_account().transfer(NearToken::from_yoctonear(p.attached))
            .deploy_contract(VAULT_WASM.to_vec()).function_call("new", args, NearToken::from_yoctonear(0), GAS_VAULT_INIT)
            .then(ext_vault::ext(vault).with_static_gas(GAS_VAULT_STAKE).stake())
            .then(Self::ext(Self::me()).with_static_gas(GAS_ON_STAKED).on_staked(id))
            .into()
    }

    /// `Ok(0)`: the vault already refunded the borrower; hand over the empty vault so its storage NEAR can be recovered.
    /// `Err`: either the vault never came up (the NEAR is back here) or it exists and holds the NEAR. Probe before refunding.
    #[private]
    pub fn on_staked(&mut self, id: u64, #[callback_result] staked: Result<U128, PromiseError>) -> PromiseOrValue<bool> {
        let Some(p) = self.pending.get(&id).cloned() else { return PromiseOrValue::Value(false) };
        let vault = Self::vault_id(id);
        let staked = match staked {
            Err(_) => return ext_vault::ext(vault).with_static_gas(GAS_PROBE).get_info()
                .then(Self::ext(Self::me()).with_static_gas(GAS_CB).on_vault_probe(id)).into(),
            Ok(U128(0)) => {
                Self::release_vault(&vault, p.borrower.clone());
                return self.fail_pending(id, false, "validator rejected or stake failed");
            }
            Ok(U128(s)) => s,
        };
        let px = p.price.expect("priced");
        let pl = plan(p.plan, self.vol);
        if ltv_bps(p.principal, collateral_value_usdc(staked, px.0, px.1)) > pl.ltv_cap_bps {
            Self::release_vault(&vault, p.borrower.clone());
            return self.fail_pending(id, false, "staked amount below estimate");
        }
        let t = now();
        let loan = Loan::open(id, p.borrower.to_string(), vault.to_string(), p.validator.to_string(), staked, p.principal, pl, t);
        self.checkpoint(now());
        self.ledger.open_loan(p.principal, loan.term_interest);
        let payout = p.principal - loan.term_interest;
        self.loans.insert(id, loan);
        self.pending.remove(&id);
        ext_ft::ext(self.usdc.clone()).with_attached_deposit(NearToken::from_yoctonear(1)).with_static_gas(GAS_FT)
            .ft_transfer(p.borrower, U128(payout), Some(format!("ankora loan {id}")))
            .then(Self::ext(Self::me()).with_static_gas(GAS_CB).on_paid(id))
            .into()
    }

    /// After a staking error. A batch either applies in full or not at all, so a vault that answers holds the NEAR:
    /// it goes to the borrower. No answer means the batch failed and the protocol returned the NEAR to the pool.
    #[private]
    pub fn on_vault_probe(&mut self, id: u64, #[callback_result] info: Result<near_sdk::serde_json::Value, PromiseError>) -> bool {
        let Some(p) = self.pending.get(&id).cloned() else { return false };
        if info.is_ok() {
            Self::release_vault(&Self::vault_id(id), p.borrower);
            let _ = self.fail_pending(id, false, "stake failed; vault handed to the borrower");
        } else {
            let _ = self.fail_pending(id, true, "vault creation failed");
        }
        false
    }

    /// Payout bounced (e.g. borrower not registered on USDC): unbook the loan and hand the vault to the borrower.
    #[private]
    pub fn on_paid(&mut self, id: u64, #[callback_result] ok: Result<(), PromiseError>) -> bool {
        if ok.is_ok() { return true; }
        env::log_str(&format!("borrow {id} cancelled: payout failed"));
        if let Some(l) = self.loans.remove(&id) {
            self.checkpoint(now());
            self.ledger.cancel_loan(l.debt, l.term_interest);
            Self::release_vault(&l.vault.parse().unwrap(), l.borrower.parse().unwrap());
        }
        false
    }

    /// USDC arrives with `ft_transfer_call`. Returns the unused amount, which the token refunds.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        require!(env::predecessor_account_id() == self.usdc, "only USDC");
        let m: FtMsg = near_sdk::serde_json::from_str(&msg).unwrap_or_else(|_| env::panic_str("bad msg"));
        let t = now();
        self.checkpoint(t);
        let (m, sender_id) = match m { FtMsg::DepositFor(d) => (FtMsg::Deposit(d.tranche), d.account), m => (m, sender_id) };
        match m {
            FtMsg::Deposit(tr) => {
                #[cfg(not(feature = "mainnet"))]
                require!(amount.0 >= MIN_DEPOSIT, "minimum deposit is 10 USDC");
                #[cfg(feature = "mainnet")]
                require!(amount.0 >= MIN_DEPOSIT, "minimum deposit is 0.5 USDC");
                #[cfg(feature = "mainnet")]
                require!(self.ledger.cash + self.ledger.outstanding + amount.0 <= CAP_DEPOSITS, "mainnet cap: the pool holds at most 200 USDC");
                let shares = self.ledger.deposit(tr.into(), amount.0, self.clock(t)).unwrap_or_else(|e| env::panic_str(&format!("{e:?}")));
                let mut pos = self.lenders.get(&sender_id).cloned().unwrap_or_default();
                match tr { TrancheArg::Senior => pos.senior_shares += shares, TrancheArg::Junior => { pos.junior_shares += shares; pos.junior_deposited_at = t; } }
                self.lenders.insert(sender_id, pos);
                PromiseOrValue::Value(U128(0))
            }
            FtMsg::DepositFor(_) => env::panic_str("unreachable: rewritten to Deposit above"),
            FtMsg::Repay(id) => {
                let mut l = self.loan(id);
                let was_auction = matches!(l.state, LoanState::Auction { .. });
                let v = l.vest_to(t);
                self.ledger.vest(v);
                let pay = amount.0.min(l.debt);
                let out = l.repay(pay, t).unwrap_or_else(|e| env::panic_str(&format!("{e:?}")));
                self.ledger.repay(pay);
                if let RepayOutcome::Full { vest_now } = out {
                    if was_auction { auc_close(id, "repaid", t, pay, None, 0); }
                    self.ledger.vest(vest_now);
                    Self::release_vault(&l.vault.parse().unwrap(), l.borrower.parse().unwrap());
                }
                self.loans.insert(id, l);
                PromiseOrValue::Value(U128(amount.0 - pay))
            }
            FtMsg::Bid(id) => {
                let mut l = self.loan(id);
                let debt = l.debt;
                match l.bid(amount.0, t) {
                    Ok(o) => {
                        auc_close(id, "sold", t, amount.0, Some(sender_id.clone()), o.surplus_to_borrower);
                        self.ledger.close_default(debt, 0, o.recovered);
                        self.pay_surplus(l.borrower.parse().unwrap(), o.surplus_to_borrower);
                        Self::release_vault(&l.vault.parse().unwrap(), sender_id);
                        self.loans.insert(id, l);
                        PromiseOrValue::Value(U128(0))
                    }
                    Err(_) => PromiseOrValue::Value(amount),
                }
            }
            FtMsg::Recovery(id) => {
                require!(sender_id == self.owner, "only the owner books recoveries");
                require!(self.loan(id).state == LoanState::Defaulted, "loan is not defaulted");
                self.ledger.recover(amount.0);
                PromiseOrValue::Value(U128(0))
            }
        }
    }

    /// Anyone may call at or after expiry: reads the price, then renews, starts notice, grace or auction.
    pub fn settle(&mut self, id: u64) -> Promise {
        let _ = self.loan(id);
        self.price_calls().then(Self::ext(Self::me()).with_static_gas(GAS_ON_SETTLE).on_settle_priced(id))
    }

    #[private]
    pub fn on_settle_priced(&mut self, id: u64, #[callback_result] spot: Result<Option<PythPriceJson>, PromiseError>, #[callback_result] ema: Result<Option<PythPriceJson>, PromiseError>) -> String {
        let mut l = self.loan(id);
        let t = now();
        self.checkpoint(t);
        let px = match collateral_price(to_price(spot), to_price(ema), t as i64, false) {
            Ok(px) => px,
            Err(_) if matches!(l.state, LoanState::Auction { .. }) => (1, -8),
            Err(e) => env::panic_str(&format!("oracle unavailable ({e:?}); retry settle")),
        };
        let v = l.vest_to(t);
        self.ledger.vest(v);
        let debt_before = l.debt;
        let out = l.settle(px, self.vol, t);
        self.ledger.vest(l.take_vest_owed());
        match out {
            SettleOutcome::Renewed(_) => self.ledger.renew(l.debt - debt_before),
            SettleOutcome::AuctionStarted => auc_open(&l, t),
            SettleOutcome::AuctionExpired => {
                auc_close(id, "no_buyer", t, 0, None, 0);
                self.ledger.close_default(l.debt, 0, 0);
                // The owner unstakes and sells the NEAR, then books the USDC with a `recovery` message.
                Self::release_vault(&l.vault.parse().unwrap(), self.owner.clone());
            }
            _ => {}
        }
        self.loans.insert(id, l);
        format!("{out:?}")
    }

    #[payable]
    pub fn set_auto_renew(&mut self, id: u64, on: bool) {
        near_sdk::assert_one_yocto();
        let mut l = self.loan(id);
        require!(env::predecessor_account_id().as_str() == l.borrower, "only the borrower");
        l.auto_renew = on;
        self.loans.insert(id, l);
    }

    #[payable]
    pub fn withdraw(&mut self, tranche: TrancheArg, shares: U128) -> Promise {
        near_sdk::assert_one_yocto();
        let who = env::predecessor_account_id();
        let mut pos = self.lenders.get(&who).cloned().unwrap_or_else(|| env::panic_str("no position"));
        let have = match tranche { TrancheArg::Senior => pos.senior_shares, TrancheArg::Junior => pos.junior_shares };
        require!(shares.0 <= have, "more shares than you hold");
        let t = now();
        self.checkpoint(t);
        let amount = self.ledger.withdraw(tranche.into(), shares.0, self.clock(t), t, pos.junior_deposited_at).unwrap_or_else(|e| env::panic_str(&format!("{e:?}")));
        match tranche { TrancheArg::Senior => pos.senior_shares -= shares.0, TrancheArg::Junior => pos.junior_shares -= shares.0 }
        self.lenders.insert(who.clone(), pos);
        ext_ft::ext(self.usdc.clone()).with_attached_deposit(NearToken::from_yoctonear(1)).with_static_gas(GAS_FT)
            .ft_transfer(who.clone(), U128(amount), Some("ankora withdrawal".into()))
            .then(Self::ext(Self::me()).with_static_gas(GAS_CB).on_withdrawn(who, tranche, shares, U128(amount)))
    }

    #[private]
    pub fn on_withdrawn(&mut self, who: AccountId, tranche: TrancheArg, shares: U128, amount: U128, #[callback_result] ok: Result<(), PromiseError>) -> bool {
        if ok.is_ok() { return true; }
        self.checkpoint(now());
        self.ledger.undo_withdraw(tranche.into(), shares.0, amount.0);
        let mut pos = self.lenders.get(&who).cloned().unwrap_or_default();
        match tranche { TrancheArg::Senior => pos.senior_shares += shares.0, TrancheArg::Junior => pos.junior_shares += shares.0 }
        self.lenders.insert(who, pos);
        false
    }

    #[private]
    pub fn on_surplus_paid(&mut self, who: AccountId, amount: U128, #[callback_result] ok: Result<(), PromiseError>) {
        if ok.is_err() {
            let c = self.claimable.get(&who).copied().unwrap_or(0);
            self.claimable.insert(who, c + amount.0);
        }
    }

    /// Collect auction surplus that could not be sent automatically.
    #[payable]
    pub fn claim(&mut self) -> Promise {
        near_sdk::assert_one_yocto();
        let who = env::predecessor_account_id();
        let amount = self.claimable.remove(&who).filter(|a| *a > 0).unwrap_or_else(|| env::panic_str("nothing to claim"));
        self.usdc_transfer(who.clone(), amount, "ankora claim")
            .then(Self::ext(Self::me()).with_static_gas(GAS_CB).on_claimed(who, U128(amount)))
    }

    #[private]
    pub fn on_claimed(&mut self, who: AccountId, amount: U128, #[callback_result] ok: Result<(), PromiseError>) {
        if ok.is_err() { self.on_surplus_paid(who, amount, Err(PromiseError::Failed)); }
    }

    pub fn get_claimable(&self, account_id: AccountId) -> U128 { U128(self.claimable.get(&account_id).copied().unwrap_or(0)) }

    /// Owner switch to the stressed menu (shorter terms only). Hackathon stand-in for the on-chain volatility state.
    #[payable]
    pub fn set_stressed(&mut self, stressed: bool) {
        near_sdk::assert_one_yocto();
        require!(env::predecessor_account_id() == self.owner, "only the owner");
        self.vol = if stressed { VolState::Stressed } else { VolState::Normal };
    }

    pub fn get_ledger(&self) -> LedgerView {
        let (g, t) = (&self.ledger, self.clock(now()));
        let lent = g.outstanding;
        let util = if g.nav(t) == 0 { 0 } else { (lent * 10_000 / (g.cash + lent).max(1)) as u32 };
        LedgerView {
            cash: U128(g.cash), outstanding: U128(g.outstanding), unearned: U128(g.unearned), treasury: U128(g.treasury), reserved: U128(g.reserved),
            nav: U128(g.nav(t)), senior_value: U128(g.senior_value(t)), junior_value: U128(g.junior_value(t)),
            senior_shares: U128(g.senior_shares), junior_shares: U128(g.junior_shares), utilisation_bps: util,
        }
    }
    pub fn get_loan(&self, id: u64) -> Option<LoanView> { self.loans.get(&id).map(|l| self.view(l)) }
    /// Auction records, newest first. `from_index` counts from the newest.
    pub fn get_auction_history(&self, from_index: u32, limit: u32) -> Vec<AuctionRecord> {
        let n = auc_count();
        (0..n).rev().skip(from_index as usize).take(limit.min(50) as usize).filter_map(auc_get).collect()
    }
    pub fn get_loans(&self, from_index: u32, limit: u32) -> Vec<LoanView> {
        self.loans.values().skip(from_index as usize).take(limit.min(100) as usize).map(|l| self.view(l)).collect()
    }
    pub fn get_lender(&self, account_id: AccountId) -> Option<LenderView> {
        self.lenders.get(&account_id).map(|p| LenderView { senior_shares: U128(p.senior_shares), junior_shares: U128(p.junior_shares), junior_unlocks_at: p.junior_deposited_at + ankora_core::tranche::JUNIOR_LOCK_SECS })
    }
    pub fn get_plans(&self) -> Vec<PlanView> {
        [PlanId::P30, PlanId::P40, PlanId::P50].into_iter().map(|id| { let p = plan(id, self.vol); PlanView { plan: format!("{id:?}"), ltv_cap_bps: p.ltv_cap_bps, term_secs: p.term_secs, rate_bps: p.rate_bps } }).collect()
    }
}

/// Sandbox tests only: moves this contract's clock forward. Absent from any build without `--features test-clock`.
#[cfg(feature = "test-clock")]
#[near]
impl Pool {
    pub fn test_advance_clock(&mut self, secs: u64) {
        require!(env::predecessor_account_id() == self.owner, "only the owner moves the demo clock");
        let cur = env::storage_read(CLOCK_KEY).map(|v| u64::from_le_bytes(v.try_into().unwrap_or([0; 8]))).unwrap_or(0);
        env::storage_write(CLOCK_KEY, &(cur + secs).to_le_bytes());
    }
}

#[cfg(all(test, feature = "mainnet"))]
mod mainnet_tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;
    const U: u128 = 1_000_000;
    const NEAR_Y: u128 = 1_000_000_000_000_000_000_000_000;
    const T0: u64 = 1_800_000_000;
    fn acc(s: &str) -> AccountId { s.parse().unwrap() }
    fn set(pred: &str, deposit_yocto: u128) {
        let mut b = VMContextBuilder::new();
        b.current_account_id(acc("pool.near")).predecessor_account_id(acc(pred)).signer_account_id(acc(pred))
            .attached_deposit(NearToken::from_yoctonear(deposit_yocto)).block_timestamp(T0 * 1_000_000_000)
            .prepaid_gas(Gas::from_tgas(300)).account_balance(NearToken::from_near(1_000));
        testing_env!(b.build());
    }
    fn pool(senior: u128, junior: u128) -> Pool {
        set("owner.near", 0);
        let mut p = Pool::new(acc("owner.near"), acc("usdc.near"), acc("aggregate-oracle.near"),
            "c415de8d2eba7db216527dff4b60e8f3a5311c740dadb233e13e12547e226750".into(), acc("lockup-whitelist.near"));
        set("usdc.near", 0);
        if junior > 0 { let _ = p.ft_on_transfer(acc("j.near"), U128(junior * U), r#"{"deposit":"junior"}"#.into()); }
        if senior > 0 { let _ = p.ft_on_transfer(acc("s.near"), U128(senior * U), r#"{"deposit":"senior"}"#.into()); }
        p
    }

    #[test]
    fn one_usdc_from_intents_is_a_deposit() {
        let mut p = pool(0, 0);
        let r = p.ft_on_transfer(acc("intents.near"), U128(U), r#"{"depositfor":{"tranche":"senior","account":"alice.near"}}"#.into());
        assert!(matches!(r, PromiseOrValue::Value(U128(0))));
        assert!(p.get_lender(acc("alice.near")).unwrap().senior_shares.0 > 0);
    }
    #[test]
    fn deposits_fill_up_to_200_usdc() {
        let mut p = pool(150, 30);
        let _ = p.ft_on_transfer(acc("x.near"), U128(20 * U), r#"{"deposit":"senior"}"#.into());
        assert_eq!(p.get_ledger().cash.0, 200 * U);
    }
    #[test]
    #[should_panic(expected = "mainnet cap: the pool holds at most 200 USDC")]
    fn a_deposit_past_200_usdc_is_refused() {
        let mut p = pool(150, 30);
        let _ = p.ft_on_transfer(acc("x.near"), U128(21 * U), r#"{"deposit":"senior"}"#.into());
    }
    #[test]
    fn a_100_usdc_loan_is_accepted() {
        let mut p = pool(150, 30);
        set("b.near", 1_000 * NEAR_Y);
        let _ = p.borrow(acc("aurora.poolv1.near"), U128(100 * U), PlanArg::P30);
        assert_eq!(p.get_ledger().reserved.0, 100 * U);
    }
    #[test]
    #[should_panic(expected = "mainnet cap: loans are limited to 100 USDC in total")]
    fn loans_past_100_usdc_are_refused() {
        let mut p = pool(150, 30);
        set("b.near", 1_000 * NEAR_Y);
        let _ = p.borrow(acc("aurora.poolv1.near"), U128(60 * U), PlanArg::P30);
        let _ = p.borrow(acc("aurora.poolv1.near"), U128(41 * U), PlanArg::P30);
    }
}

#[cfg(all(test, not(feature = "mainnet")))]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;
    use ankora_core::math::interest;

    const U: u128 = 1_000_000;
    const NEAR_Y: u128 = 1_000_000_000_000_000_000_000_000;
    const T0: u64 = 1_800_000_000;
    const DAY: u64 = 86_400;

    fn acc(s: &str) -> AccountId { s.parse().unwrap() }
    fn set(pred: &str, deposit_yocto: u128, ts: u64) {
        let mut b = VMContextBuilder::new();
        b.current_account_id(acc("pool.testnet")).predecessor_account_id(acc(pred))
            .signer_account_id(acc(pred))
            .attached_deposit(NearToken::from_yoctonear(deposit_yocto)).block_timestamp(ts * 1_000_000_000)
            .prepaid_gas(Gas::from_tgas(300)).account_balance(NearToken::from_near(1_000_000));
        testing_env!(b.build());
    }
    fn px(price: i64, ts: u64) -> Result<Option<PythPriceJson>, PromiseError> {
        Ok(Some(PythPriceJson { price: I64(price), conf: U64(0), expo: -8, publish_time: ts as i64 }))
    }
    fn new_pool() -> Pool {
        set("owner.testnet", 0, T0);
        Pool::new(acc("owner.testnet"), acc("usdc.testnet"), acc("pyth-oracle.testnet"),
            "c415de8d2eba7db216527dff4b60e8f3a5311c740dadb233e13e12547e226750".into(), acc("lockup-whitelist.testnet"))
    }
    fn funded() -> Pool {
        let mut p = new_pool();
        set("usdc.testnet", 0, T0);
        let _ = p.ft_on_transfer(acc("junior.testnet"), U128(3_000 * U), r#"{"deposit":"junior"}"#.into());
        let _ = p.ft_on_transfer(acc("senior.testnet"), U128(17_000 * U), r#"{"deposit":"senior"}"#.into());
        p
    }
    /// 10,001.5 NEAR attached: 10,000 NEAR collateral after the 1.5 NEAR vault reserve. 14,000 USDC on P40.
    fn start_borrow(p: &mut Pool) -> u64 {
        set("whale.testnet", 10_001_500 * NEAR_Y / 1_000, T0);
        let _ = p.borrow(acc("bisontrails.poolv1.testnet"), U128(14_000 * U), PlanArg::P40);
        p.next_id - 1
    }
    fn booked(p: &mut Pool) -> u64 {
        let id = start_borrow(p);
        set("pool.testnet", 0, T0);
        let _ = p.on_priced(id, px(362_000_000, T0), px(362_000_000, T0));
        let _ = p.on_staked(id, Ok(U128(10_000 * NEAR_Y)));
        id
    }
    fn state(p: &Pool, id: u64) -> String { p.get_loan(id).unwrap().state }

    const YEAR: u64 = 31_536_000;
    #[test]
    fn fixed_earns_nothing_on_idle_cash() {
        let p = funded();
        set("anyone.testnet", 0, T0 + YEAR);
        let g = p.get_ledger();
        assert_eq!(g.senior_value.0, 17_000 * U, "no loans, no coupon");
        assert_eq!(g.junior_value.0, 3_000 * U, "and First-loss is not drained by idle cash");
    }

    #[test]
    fn fixed_accrues_at_the_pools_utilisation() {
        let mut p = funded();
        let _ = booked(&mut p);
        let g0 = p.get_ledger();
        let (lent, cash) = (g0.outstanding.0 as f64, g0.cash.0 as f64);
        let u = lent / (lent + cash);
        set("anyone.testnet", 0, T0 + YEAR);
        let got = p.get_ledger().senior_value.0 as f64 / U as f64;
        let want = 17_000.0 * (1.0 + 0.065 * u);
        assert!((got - want).abs() < 0.01, "senior {got} vs 17,000 x (1 + 6.5% x {u:.3}) = {want}");
        assert!(got < 17_000.0 * 1.065, "below the full 6.5% while part of the pool is idle");
    }

    #[test]
    fn upgrade_keeps_what_fixed_already_earned_then_accrues_on_lent_cash() {
        let p = funded();
        near_sdk::env::storage_remove(super::ACC_KEY); // a pool deployed before the accrual clock existed
        set("anyone.testnet", 0, T0 + YEAR);
        assert_eq!(p.get_ledger().senior_value.0, 17_000 * U * 1_065 / 1_000, "the old full-rate year is kept, nothing is clawed back");
        let mut p = p;
        set("usdc.testnet", 0, T0 + YEAR);
        let _ = p.ft_on_transfer(acc("senior2.testnet"), U128(10 * U), r#"{"deposit":"senior"}"#.into()); // first call after the upgrade: checkpoint
        let at_upgrade = p.get_ledger().senior_value.0;
        set("anyone.testnet", 0, T0 + 2 * YEAR);
        assert_eq!(p.get_ledger().senior_value.0, at_upgrade, "after the upgrade an idle pool pays Fixed nothing");
    }

    #[test]
    fn deposit_for_credits_the_named_account() {
        let mut p = funded();
        set("usdc.testnet", 0, T0);
        let r = p.ft_on_transfer(acc("intents.near"), U128(100 * U), r#"{"depositfor":{"tranche":"senior","account":"alice.testnet"}}"#.into());
        assert!(matches!(r, PromiseOrValue::Value(U128(0))));
        assert!(p.get_lender(acc("alice.testnet")).unwrap().senior_shares.0 > 0);
        assert!(p.get_lender(acc("intents.near")).is_none(), "the relayer gets nothing");
    }

    #[test]
    fn deposits_mint_shares_and_add_cash() {
        let p = funded();
        assert_eq!(p.get_lender(acc("junior.testnet")).unwrap().junior_shares.0, 3_000 * U);
        assert_eq!(p.get_ledger().cash.0, 20_000 * U);
    }

    #[test]
    #[should_panic(expected = "only USDC")]
    fn other_tokens_are_refused() {
        let mut p = new_pool();
        set("fake.testnet", 0, T0);
        let _ = p.ft_on_transfer(acc("x.testnet"), U128(1), r#"{"deposit":"senior"}"#.into());
    }

    #[test]
    #[should_panic(expected = "junior cover")]
    fn borrow_without_junior_cover_panics() {
        let mut p = new_pool();
        set("usdc.testnet", 0, T0);
        let _ = p.ft_on_transfer(acc("senior.testnet"), U128(20_000 * U), r#"{"deposit":"senior"}"#.into());
        start_borrow(&mut p);
    }

    #[test]
    fn stale_price_refunds_and_records_nothing() {
        let mut p = funded();
        let id = start_borrow(&mut p);
        assert_eq!(p.get_ledger().reserved.0, 14_000 * U);
        set("pool.testnet", 0, T0);
        assert!(matches!(p.on_priced(id, Ok(None), px(362_000_000, T0)), PromiseOrValue::Value(false)));
        assert_eq!(p.get_ledger().reserved.0, 0);
        assert!(p.get_loan(id).is_none());
        assert!(p.pending.get(&id).is_none());
    }

    #[test]
    fn ltv_above_plan_cap_refunds() {
        let mut p = funded();
        let id = start_borrow(&mut p);
        set("pool.testnet", 0, T0);
        assert!(matches!(p.on_priced(id, px(300_000_000, T0), px(300_000_000, T0)), PromiseOrValue::Value(false)));
        assert_eq!(p.get_ledger().reserved.0, 0);
    }

    #[test]
    fn good_price_then_stake_books_the_loan() {
        let mut p = funded();
        let id = booked(&mut p);
        let i = interest(14_000 * U, 1010, 14 * DAY);
        let l = p.get_loan(id).unwrap();
        assert_eq!((l.debt.0, l.term_interest.0, l.state.as_str()), (14_000 * U, i, "Active"));
        let g = p.get_ledger();
        assert_eq!((g.outstanding.0, g.cash.0, g.reserved.0), (14_000 * U, 20_000 * U - (14_000 * U - i), 0));
        assert_eq!(l.vault.as_str(), "v0.pool.testnet");
    }

    #[test]
    fn rejected_validator_releases_cover() {
        let mut p = funded();
        let id = start_borrow(&mut p);
        set("pool.testnet", 0, T0);
        let _ = p.on_priced(id, px(362_000_000, T0), px(362_000_000, T0));
        assert!(matches!(p.on_staked(id, Ok(U128(0))), PromiseOrValue::Value(false)));
        assert!(p.get_loan(id).is_none());
        assert_eq!(p.get_ledger().reserved.0, 0);
        assert_eq!(calls_to("v0.pool.testnet", "release"), vec![r#"{"new_owner":"whale.testnet"}"#.to_string()], "borrower gets the empty vault back to recover its storage NEAR");
    }

    fn actions_to(to: &str) -> Vec<near_sdk::mock::MockAction> {
        near_sdk::test_utils::get_created_receipts().into_iter().filter(|r| r.receiver_id.as_str() == to).flat_map(|r| r.actions).collect()
    }
    fn calls_to(to: &str, method: &str) -> Vec<String> {
        actions_to(to).into_iter().filter_map(|a| match a {
            near_sdk::mock::MockAction::FunctionCallWeight { method_name, args, .. } if method_name == method.as_bytes() => Some(String::from_utf8(args).unwrap()),
            _ => None,
        }).collect()
    }
    fn refunded_to(to: &str) -> u128 {
        actions_to(to).into_iter().map(|a| match a { near_sdk::mock::MockAction::Transfer { deposit, .. } => deposit.as_yoctonear(), _ => 0 }).sum()
    }
    fn staking_errored(p: &mut Pool) -> u64 {
        let id = start_borrow(p);
        set("pool.testnet", 0, T0);
        let _ = p.on_priced(id, px(362_000_000, T0), px(362_000_000, T0));
        set("pool.testnet", 0, T0);
        let _ = p.on_staked(id, Err(PromiseError::Failed));
        id
    }

    #[test]
    fn stake_error_probes_the_vault_before_any_refund() {
        let mut p = funded();
        let _ = staking_errored(&mut p);
        assert_eq!(refunded_to("whale.testnet"), 0, "the vault may exist and hold the NEAR: refunding now could pay twice");
        assert_eq!(calls_to("v0.pool.testnet", "get_info").len(), 1);
        assert!(p.get_loan(0).is_none());
    }

    #[test]
    fn existing_vault_after_stake_error_goes_to_borrower() {
        let mut p = funded();
        let id = staking_errored(&mut p);
        set("pool.testnet", 0, T0);
        assert!(!p.on_vault_probe(id, Ok(near_sdk::serde_json::json!({"released": false}))));
        assert_eq!(refunded_to("whale.testnet"), 0, "the NEAR is in the vault, not here");
        assert_eq!(calls_to("v0.pool.testnet", "release"), vec![r#"{"new_owner":"whale.testnet"}"#.to_string()]);
        assert_eq!(p.get_ledger().reserved.0, 0);
    }

    #[test]
    fn missing_vault_after_stake_error_refunds_from_pool() {
        let mut p = funded();
        let id = staking_errored(&mut p);
        set("pool.testnet", 0, T0);
        assert!(!p.on_vault_probe(id, Err(PromiseError::Failed)));
        assert_eq!(refunded_to("whale.testnet"), 10_001_500 * NEAR_Y / 1_000, "the failed batch returned the NEAR to the pool");
        assert!(calls_to("v0.pool.testnet", "release").is_empty());
        assert_eq!(p.get_ledger().reserved.0, 0);
        set("pool.testnet", 0, T0);
        assert!(!p.on_vault_probe(id, Err(PromiseError::Failed)));
        assert_eq!(refunded_to("whale.testnet"), 0, "a second probe callback can't refund again");
    }

    #[test]
    fn failed_payout_rolls_the_loan_back() {
        let mut p = funded();
        let id = booked(&mut p);
        assert!(!p.on_paid(id, Err(PromiseError::Failed)));
        assert!(near_sdk::test_utils::get_logs().iter().any(|l| l == &format!("borrow {id} cancelled: payout failed")), "a bounced payout logs like every other cancel");
        assert!(p.get_loan(id).is_none());
        let g = p.get_ledger();
        assert_eq!((g.cash.0, g.outstanding.0, g.unearned.0), (20_000 * U, 0, 0));
    }

    #[test]
    fn full_repay_closes_and_returns_excess() {
        let mut p = funded();
        let id = booked(&mut p);
        set("usdc.testnet", 0, T0 + DAY);
        let r = p.ft_on_transfer(acc("whale.testnet"), U128(14_005 * U), format!(r#"{{"repay":{id}}}"#));
        assert!(matches!(r, PromiseOrValue::Value(U128(x)) if x == 5 * U));
        assert_eq!(state(&p, id), "Closed");
        assert_eq!(p.get_ledger().outstanding.0, 0);
    }

    #[test]
    fn settle_at_expiry_renews_and_grows_debt() {
        let mut p = funded();
        let id = booked(&mut p);
        let exp = T0 + 14 * DAY;
        set("pool.testnet", 0, exp);
        assert_eq!(p.on_settle_priced(id, px(362_000_000, exp), px(362_000_000, exp)), "Renewed(P40)");
        let grown = 14_000 * U + interest(14_000 * U, 1010, 14 * DAY);
        assert_eq!(p.get_loan(id).unwrap().debt.0, grown);
        assert_eq!(p.get_ledger().outstanding.0, grown);
    }

    #[test]
    #[should_panic(expected = "oracle unavailable")]
    fn settle_without_a_price_waits() {
        let mut p = funded();
        let id = booked(&mut p);
        set("pool.testnet", 0, T0 + 14 * DAY);
        p.on_settle_priced(id, Ok(None), Ok(None));
    }

    fn to_auction(p: &mut Pool, id: u64) -> u64 {
        let exp = T0 + 14 * DAY;
        for (t, want) in [(exp, "NoticeStarted"), (exp + 259_200, "GraceStarted"), (exp + 259_200 + 172_800, "AuctionStarted")] {
            set("pool.testnet", 0, t);
            assert_eq!(p.on_settle_priced(id, px(150_000_000, t), px(150_000_000, t)), want);
        }
        exp + 259_200 + 172_800
    }

    #[test]
    fn loan_view_shows_the_next_deadline() {
        let mut p = funded();
        let id = booked(&mut p);
        let exp = T0 + 14 * DAY;
        assert_eq!(p.get_loan(id).unwrap().deadline, exp, "active: the term's end");
        set("pool.testnet", 0, exp);
        let _ = p.on_settle_priced(id, px(150_000_000, exp), px(150_000_000, exp));
        assert_eq!(p.get_loan(id).unwrap().deadline, exp + 259_200, "notice: 72 hours to pay down");
        let g = exp + 259_200;
        set("pool.testnet", 0, g);
        assert_eq!(p.on_settle_priced(id, px(150_000_000, g), px(150_000_000, g)), "GraceStarted");
        assert_eq!(p.get_loan(id).unwrap().deadline, g + 172_800, "grace: 48 hours");
        let a = g + 172_800;
        set("pool.testnet", 0, a);
        assert_eq!(p.on_settle_priced(id, px(150_000_000, a), px(150_000_000, a)), "AuctionStarted");
        assert_eq!(p.get_loan(id).unwrap().deadline, a + 86_400, "auction: its 24-hour end");
    }

    #[test]
    fn auction_bid_pays_debt_and_returns_surplus() {
        let mut p = funded();
        let id = booked(&mut p);
        let t = to_auction(&mut p, id);
        set("usdc.testnet", 0, t);
        let r = p.ft_on_transfer(acc("bidder.testnet"), U128(15_000 * U), format!(r#"{{"bid":{id}}}"#));
        assert!(matches!(r, PromiseOrValue::Value(U128(0))));
        assert_eq!(state(&p, id), "Closed");
        assert_eq!(p.get_ledger().outstanding.0, 0);
    }

    #[test]
    fn auction_history_records_start_and_sale() {
        let mut p = funded();
        let id = booked(&mut p);
        let t = to_auction(&mut p, id);
        let h = p.get_auction_history(0, 10);
        assert_eq!(h.len(), 1);
        assert_eq!((h[0].id, h[0].outcome.as_str(), h[0].started_at), (id, "live", t));
        assert!(h[0].start_value.0 > 0 && h[0].debt.0 > 0);
        set("usdc.testnet", 0, t + 60);
        let _ = p.ft_on_transfer(acc("bidder.testnet"), U128(15_000 * U), format!(r#"{{"bid":{id}}}"#));
        let h = p.get_auction_history(0, 10);
        assert_eq!(h[0].outcome, "sold");
        assert_eq!(h[0].price.0, 15_000 * U);
        assert_eq!(h[0].buyer.as_ref().map(|a| a.as_str()), Some("bidder.testnet"));
        assert_eq!(h[0].ended_at, t + 60);
    }

    #[test]
    fn auction_history_records_no_buyer() {
        let mut p = funded();
        let id = booked(&mut p);
        let t = to_auction(&mut p, id);
        set("pool.testnet", 0, t + 86_400);
        assert_eq!(p.on_settle_priced(id, Ok(None), Ok(None)), "AuctionExpired");
        let h = p.get_auction_history(0, 10);
        assert_eq!((h[0].outcome.as_str(), h[0].ended_at, h[0].buyer.is_none()), ("no_buyer", t + 86_400, true));
    }

    #[test]
    fn low_bid_is_refunded() {
        let mut p = funded();
        let id = booked(&mut p);
        let t = to_auction(&mut p, id);
        set("usdc.testnet", 0, t);
        let r = p.ft_on_transfer(acc("bidder.testnet"), U128(14_000 * U), format!(r#"{{"bid":{id}}}"#));
        assert!(matches!(r, PromiseOrValue::Value(U128(x)) if x == 14_000 * U));
        assert_eq!(state(&p, id), "Auction");
    }

    #[test]
    fn failed_surplus_payout_becomes_claimable() {
        let mut p = funded();
        set("pool.testnet", 0, T0);
        p.on_surplus_paid(acc("whale.testnet"), U128(520 * U), Err(PromiseError::Failed));
        assert_eq!(p.get_claimable(acc("whale.testnet")).0, 520 * U);
        p.on_surplus_paid(acc("other.testnet"), U128(7 * U), Ok(()));
        assert_eq!(p.get_claimable(acc("other.testnet")).0, 0);
    }

    #[test]
    fn claim_pays_out_and_a_failed_claim_restores_it() {
        let mut p = funded();
        set("pool.testnet", 0, T0);
        p.on_surplus_paid(acc("whale.testnet"), U128(520 * U), Err(PromiseError::Failed));
        set("whale.testnet", 1, T0);
        let _ = p.claim();
        assert_eq!(p.get_claimable(acc("whale.testnet")).0, 0);
        set("pool.testnet", 0, T0);
        p.on_claimed(acc("whale.testnet"), U128(520 * U), Err(PromiseError::Failed));
        assert_eq!(p.get_claimable(acc("whale.testnet")).0, 520 * U);
    }

    #[test]
    #[should_panic(expected = "nothing to claim")]
    fn claim_with_nothing_owed_panics() {
        let mut p = funded();
        set("whale.testnet", 1, T0);
        let _ = p.claim();
    }

    // Audit fixes (near-contract-audit, 2026-11-10)
    #[test]
    #[should_panic(expected = "exactly 1 yoctoNEAR")]
    fn switching_auto_renew_needs_a_full_access_key() {
        let mut p = funded();
        let id = booked(&mut p);
        set("whale.testnet", 0, T0);
        p.set_auto_renew(id, false);
    }

    #[test]
    #[should_panic(expected = "exactly 1 yoctoNEAR")]
    fn withdraw_needs_a_full_access_key() {
        let mut p = funded();
        set("senior.testnet", 0, T0);
        let _ = p.withdraw(TrancheArg::Senior, U128(1));
    }

    #[test]
    #[should_panic(expected = "exactly 1 yoctoNEAR")]
    fn stress_switch_needs_a_full_access_key() {
        let mut p = funded();
        set("owner.testnet", 0, T0);
        p.set_stressed(true);
    }

    #[test]
    #[should_panic(expected = "minimum deposit is 10 USDC")]
    fn dust_deposits_are_refused() {
        let mut p = funded();
        set("usdc.testnet", 0, T0);
        let _ = p.ft_on_transfer(acc("dust.testnet"), U128(9_999_999), r#"{"deposit":"senior"}"#.into());
    }

    #[test]
    fn unsold_auction_hands_vault_to_owner_for_recovery() {
        let mut p = funded();
        let id = booked(&mut p);
        let t = to_auction(&mut p, id);
        set("pool.testnet", 0, t + 86_400);
        assert_eq!(p.on_settle_priced(id, Ok(None), Ok(None)), "AuctionExpired");
        let release = near_sdk::test_utils::get_created_receipts().into_iter()
            .filter(|r| r.receiver_id.as_str() == "v0.pool.testnet")
            .flat_map(|r| r.actions)
            .find_map(|a| match a { near_sdk::mock::MockAction::FunctionCallWeight { method_name, args, .. } if method_name == b"release" => Some(String::from_utf8(args).unwrap()), _ => None })
            .expect("release scheduled");
        assert!(release.contains("owner.testnet"), "vault goes to the owner, who can unstake and sell: {release}");
    }

    #[cfg(feature = "test-clock")]
    #[test]
    #[should_panic(expected = "only the owner")]
    fn strangers_cannot_move_the_demo_clock() {
        let mut p = funded();
        set("whale.testnet", 0, T0);
        p.test_advance_clock(14 * DAY);
    }

    #[cfg(feature = "test-clock")]
    #[test]
    fn test_clock_moves_contract_time() {
        let mut p = funded();
        let id = booked(&mut p);
        set("owner.testnet", 0, T0);
        p.test_advance_clock(14 * DAY);
        let t = T0 + 14 * DAY;
        assert_eq!(p.on_settle_priced(id, px(362_000_000, t), px(362_000_000, t)), "Renewed(P40)");
    }
}
