//! Lender ledger: senior earns a fixed 6.5%, junior owns the rest and takes losses first (ankora-mechanism.md).
//! nav = cash + outstanding - unearned - treasury. Interest vests linearly; 5% of what vests goes to the treasury.
use crate::math::{BPS, FEE_BPS, YEAR_SECS};

pub const SENIOR_BPS: u128 = 650;
pub const JUNIOR_COVER_BPS: u128 = 1_500;
pub const JUNIOR_LOCK_SECS: u64 = 3_110_400; // 36 days
const SCALE: u128 = 1_000_000_000_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "borsh", derive(borsh::BorshSerialize, borsh::BorshDeserialize, borsh::BorshSchema))]
pub enum Tranche { Senior, Junior }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LedgerError { Locked, CoverBreach, InsufficientCash, JuniorWiped, ZeroAmount, NoShares }

#[derive(Clone, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "borsh", derive(borsh::BorshSerialize, borsh::BorshDeserialize, borsh::BorshSchema))]
pub struct Ledger {
    pub cash: u128,
    pub outstanding: u128,
    pub unearned: u128,
    pub treasury: u128,
    pub reserved: u128,
    pub senior_shares: u128,
    pub junior_shares: u128,
    pub t0: u64,
}

impl Ledger {
    pub fn new(t0: u64) -> Self {
        Self { cash: 0, outstanding: 0, unearned: 0, treasury: 0, reserved: 0, senior_shares: 0, junior_shares: 0, t0 }
    }
    fn senior_index(&self, now: u64) -> u128 {
        SCALE + SCALE * SENIOR_BPS * now.saturating_sub(self.t0) as u128 / (BPS * YEAR_SECS)
    }
    pub fn nav(&self, _now: u64) -> u128 {
        (self.cash + self.outstanding).saturating_sub(self.unearned + self.treasury)
    }
    /// The senior claim, capped by NAV once the junior is wiped out.
    pub fn senior_value(&self, now: u64) -> u128 {
        (self.senior_shares * self.senior_index(now) / SCALE).min(self.nav(now))
    }
    pub fn junior_value(&self, now: u64) -> u128 { self.nav(now) - self.senior_value(now) }
    fn free_cash(&self) -> u128 { self.cash.saturating_sub(self.treasury + self.reserved) }

    pub fn deposit(&mut self, t: Tranche, amount: u128, now: u64) -> Result<u128, LedgerError> {
        if amount == 0 { return Err(LedgerError::ZeroAmount); }
        let shares = match t {
            Tranche::Senior => amount * SCALE / self.senior_index(now),
            Tranche::Junior => {
                let v = self.junior_value(now);
                if self.junior_shares == 0 { amount } else if v == 0 { return Err(LedgerError::JuniorWiped); } else { amount * self.junior_shares / v }
            }
        };
        match t { Tranche::Senior => self.senior_shares += shares, Tranche::Junior => self.junior_shares += shares }
        self.cash += amount;
        Ok(shares)
    }

    pub fn withdraw(&mut self, t: Tranche, shares: u128, now: u64, deposited_at: u64) -> Result<u128, LedgerError> {
        let amount = match t {
            Tranche::Senior => {
                if shares == 0 || shares > self.senior_shares { return Err(LedgerError::NoShares); }
                self.senior_value(now) * shares / self.senior_shares
            }
            Tranche::Junior => {
                if shares == 0 || shares > self.junior_shares { return Err(LedgerError::NoShares); }
                if now < deposited_at + JUNIOR_LOCK_SECS { return Err(LedgerError::Locked); }
                let a = self.junior_value(now) * shares / self.junior_shares;
                if (self.junior_value(now) - a) * BPS < JUNIOR_COVER_BPS * (self.outstanding + self.reserved) { return Err(LedgerError::CoverBreach); }
                a
            }
        };
        if amount > self.free_cash() { return Err(LedgerError::InsufficientCash); }
        match t { Tranche::Senior => self.senior_shares -= shares, Tranche::Junior => self.junior_shares -= shares }
        self.cash -= amount;
        Ok(amount)
    }

    /// Junior cover after this loan stays at or above 15%, and there is cash to pay it out.
    pub fn can_lend(&self, principal: u128, now: u64) -> bool {
        self.junior_value(now) * BPS >= JUNIOR_COVER_BPS * (self.outstanding + self.reserved + principal) && principal <= self.free_cash()
    }
    pub fn reserve(&mut self, principal: u128) { self.reserved += principal; }
    pub fn release(&mut self, principal: u128) { self.reserved = self.reserved.saturating_sub(principal); }

    /// Loan starts: the borrower receives principal minus the prepaid interest.
    pub fn open_loan(&mut self, principal: u128, interest: u128) {
        self.release(principal);
        self.cash -= principal - interest;
        self.outstanding += principal;
        self.unearned += interest;
    }
    /// Renewal: the next term's interest is added to the debt.
    pub fn renew(&mut self, interest: u128) { self.outstanding += interest; self.unearned += interest; }
    pub fn vest(&mut self, amount: u128) {
        let a = amount.min(self.unearned);
        self.unearned -= a;
        self.treasury += a * FEE_BPS / BPS;
    }
    pub fn repay(&mut self, amount: u128) { self.cash += amount; self.outstanding -= amount; }
    /// Auction or write-off: the pool keeps at most the debt; the shortfall hits the junior first through NAV.
    pub fn close_default(&mut self, debt: u128, unearned_left: u128, recovered: u128) {
        self.cash += recovered.min(debt);
        self.outstanding -= debt;
        self.unearned -= unearned_left.min(self.unearned);
    }
    /// Payout failed after the loan was booked: undo `open_loan` exactly.
    pub fn cancel_loan(&mut self, principal: u128, interest: u128) {
        self.outstanding -= principal;
        self.cash += principal - interest;
        self.unearned -= interest;
    }
    /// Withdrawal transfer failed: give the shares and cash back.
    pub fn undo_withdraw(&mut self, t: Tranche, shares: u128, amount: u128) {
        match t { Tranche::Senior => self.senior_shares += shares, Tranche::Junior => self.junior_shares += shares }
        self.cash += amount;
    }
    /// USDC from selling collateral the pool kept after an unsold auction.
    pub fn recover(&mut self, amount: u128) { self.cash += amount; }
}

#[cfg(test)]
mod tests {
    use super::*;
    const U: u128 = 1_000_000; // 1 USDC
    const T0: u64 = 1_800_000_000;
    fn pool(junior: u128, senior: u128) -> Ledger {
        let mut l = Ledger::new(T0);
        if junior > 0 { l.deposit(Tranche::Junior, junior * U, T0).unwrap(); }
        if senior > 0 { l.deposit(Tranche::Senior, senior * U, T0).unwrap(); }
        l
    }

    #[test]
    fn senior_1000_is_worth_1065_after_a_year() {
        let l = pool(1_000, 1_000);
        assert_eq!(l.senior_value(T0 + 31_536_000), 1_065 * U);
        assert_eq!(l.junior_value(T0 + 31_536_000), 935 * U);
    }

    #[test]
    fn junior_absorbs_loss_before_senior() {
        let mut l = pool(1_000, 1_000);
        l.open_loan(500 * U, 0);
        l.close_default(500 * U, 0, 400 * U);
        assert_eq!(l.senior_value(T0), 1_000 * U);
        assert_eq!(l.junior_value(T0), 900 * U);
    }

    #[test]
    fn loss_beyond_junior_impairs_senior_pro_rata() {
        let mut l = pool(100, 1_000);
        l.open_loan(500 * U, 0);
        l.close_default(500 * U, 0, 0);
        assert_eq!(l.junior_value(T0), 0);
        let shares = l.senior_shares;
        assert_eq!(l.withdraw(Tranche::Senior, shares, T0, T0).unwrap(), 600 * U);
    }

    #[test]
    fn junior_cover_of_15_percent_gates_lending() {
        let l = pool(150, 850);
        assert!(l.can_lend(1_000 * U, T0));
        assert!(!l.can_lend(1_000 * U + 1, T0));
    }

    #[test]
    fn reserved_borrows_count_against_cover() {
        let mut l = pool(150, 850);
        l.reserve(600 * U);
        assert!(!l.can_lend(500 * U, T0));
        l.release(600 * U);
        assert!(l.can_lend(500 * U, T0));
    }

    #[test]
    fn junior_is_locked_for_36_days() {
        let mut l = pool(150, 850);
        let s = l.junior_shares;
        assert_eq!(l.withdraw(Tranche::Junior, s, T0 + 3_110_399, T0), Err(LedgerError::Locked));
        assert!(l.withdraw(Tranche::Junior, s, T0 + 3_110_400, T0).is_ok());
    }

    #[test]
    fn junior_withdrawal_cannot_break_cover() {
        let mut l = pool(200, 800);
        l.open_loan(1_000 * U, 0);
        let s = l.junior_shares;
        assert_eq!(l.withdraw(Tranche::Junior, s / 2, T0 + 3_110_400, T0), Err(LedgerError::CoverBreach));
    }

    #[test]
    fn withdrawal_beyond_free_cash_is_refused() {
        let mut l = pool(500, 500);
        l.open_loan(900 * U, 0);
        let s = l.senior_shares;
        assert_eq!(l.withdraw(Tranche::Senior, s, T0, T0), Err(LedgerError::InsufficientCash));
    }

    #[test]
    fn origination_leaves_nav_flat_and_vesting_pays_95_percent() {
        let mut l = pool(1_000, 1_000);
        let before = l.nav(T0);
        l.open_loan(1_000 * U, 10 * U);
        assert_eq!(l.nav(T0), before);
        l.vest(10 * U);
        assert_eq!(l.nav(T0), before + 9_500_000);
        assert_eq!(l.treasury, 500_000);
    }

    #[test]
    fn deposits_into_a_wiped_junior_are_refused() {
        let mut l = pool(100, 1_000);
        l.open_loan(500 * U, 0);
        l.close_default(500 * U, 0, 0);
        assert_eq!(l.deposit(Tranche::Junior, 100 * U, T0), Err(LedgerError::JuniorWiped));
    }

    #[test]
    fn cancel_loan_reverses_open_exactly() {
        let mut l = pool(1_000, 1_000);
        let before = l.clone();
        l.reserve(500 * U);
        l.open_loan(500 * U, 5 * U);
        l.cancel_loan(500 * U, 5 * U);
        assert_eq!(l, before);
    }

    #[test]
    fn undo_withdraw_restores_shares_and_cash() {
        let mut l = pool(1_000, 1_000);
        let before = l.clone();
        let s = l.senior_shares / 2;
        let a = l.withdraw(Tranche::Senior, s, T0, T0).unwrap();
        l.undo_withdraw(Tranche::Senior, s, a);
        assert_eq!(l, before);
    }

    #[test]
    fn recovery_adds_cash_and_nav() {
        let mut l = pool(1_000, 1_000);
        l.recover(50 * U);
        assert_eq!(l.nav(T0), 2_050 * U);
    }
}
