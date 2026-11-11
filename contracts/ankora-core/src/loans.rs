//! Loan state machine (ankora-mechanism.md, "At expiry"). Pure: `now` and prices are passed in.
//! Active -> (expiry) renew into the plan the LTV allows, or Notice 72h -> Grace 48h -> Dutch auction 24h -> Closed/Defaulted.
//! Nothing happens to collateral before expiry + notice + grace.
use crate::math::{collateral_value_usdc, interest, ltv_bps};
use crate::plans::{plan_for_ltv, Plan, PlanId, VolState};

pub const NOTICE_SECS: u64 = 259_200;
pub const GRACE_SECS: u64 = 172_800;
pub const AUCTION_SECS: u64 = 86_400;
pub const AUCTION_FLOOR_BPS: u128 = 5_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "borsh", derive(borsh::BorshSerialize, borsh::BorshDeserialize, borsh::BorshSchema))]
pub enum LoanState { Active, Notice { until: u64 }, Grace { until: u64 }, Auction { start: u64, start_value: u128 }, Closed, Defaulted }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SettleOutcome { NotDue, Renewed(PlanId), NoticeStarted, GraceStarted, AuctionStarted, AuctionExpired }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RepayOutcome { Partial, Full { vest_now: u128 } }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BidOutcome { pub recovered: u128, pub surplus_to_borrower: u128, pub loss: u128 }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LoanError { NotInAuction, AuctionOver, BidTooLow, LoanClosed, OverRepay, ZeroAmount }

#[derive(Clone, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "borsh", derive(borsh::BorshSerialize, borsh::BorshDeserialize, borsh::BorshSchema))]
pub struct Loan {
    pub id: u64,
    pub borrower: String,
    pub vault: String,
    pub validator: String,
    pub collateral_yocto: u128,
    pub debt: u128,
    pub plan: PlanId,
    pub term_interest: u128,
    pub vested: u128,
    pub vest_owed: u128,
    pub term_start: u64,
    pub expiry: u64,
    pub auto_renew: bool,
    pub state: LoanState,
}

impl Loan {
    /// New loan; the first term's interest is prepaid (deducted from the payout by the pool).
    pub fn open(id: u64, borrower: String, vault: String, validator: String, collateral_yocto: u128, principal: u128, p: Plan, now: u64) -> Self {
        Self {
            id, borrower, vault, validator, collateral_yocto, debt: principal, plan: p.id,
            term_interest: interest(principal, p.rate_bps, p.term_secs), vested: 0, vest_owed: 0,
            term_start: now, expiry: now + p.term_secs, auto_renew: true, state: LoanState::Active,
        }
    }

    /// Interest earned since the last call, linear over the term. The pool passes it to `Ledger::vest`.
    pub fn vest_to(&mut self, now: u64) -> u128 {
        if matches!(self.state, LoanState::Closed | LoanState::Defaulted) { return 0; }
        let term = self.expiry - self.term_start;
        let target = self.term_interest * now.saturating_sub(self.term_start).min(term) as u128 / term as u128;
        let d = target.saturating_sub(self.vested);
        self.vested += d;
        d
    }
    /// Vesting stashed by `settle`, for the pool to book.
    pub fn take_vest_owed(&mut self) -> u128 { std::mem::take(&mut self.vest_owed) }

    pub fn value(&self, price: (i64, i32)) -> u128 { collateral_value_usdc(self.collateral_yocto, price.0, price.1) }
    pub fn ltv(&self, price: (i64, i32)) -> u32 { ltv_bps(self.debt, self.value(price)) }

    fn renew(&mut self, p: Plan, now: u64) -> SettleOutcome {
        let gap = now.saturating_sub(self.expiry);
        let i = interest(self.debt, p.rate_bps, gap) + interest(self.debt, p.rate_bps, p.term_secs);
        self.debt += i;
        self.plan = p.id;
        self.term_interest = i;
        self.vested = 0;
        self.term_start = now;
        self.expiry = now + p.term_secs;
        self.state = LoanState::Active;
        SettleOutcome::Renewed(p.id)
    }

    /// Anyone may call at or after expiry. The price is used only to pick a plan or start the auction.
    pub fn settle(&mut self, price: (i64, i32), vol: VolState, now: u64) -> SettleOutcome {
        match self.state {
            LoanState::Active => {
                if now < self.expiry { return SettleOutcome::NotDue; }
                let d = self.vest_to(now);
                self.vest_owed += d;
                if !self.auto_renew {
                    self.state = LoanState::Grace { until: now + GRACE_SECS };
                    return SettleOutcome::GraceStarted;
                }
                match plan_for_ltv(self.ltv(price), vol) {
                    Some(p) => self.renew(p, now),
                    None => { self.state = LoanState::Notice { until: now + NOTICE_SECS }; SettleOutcome::NoticeStarted }
                }
            }
            LoanState::Notice { until } => match plan_for_ltv(self.ltv(price), vol) {
                Some(p) if self.auto_renew => self.renew(p, now),
                _ if now >= until => { self.state = LoanState::Grace { until: now + GRACE_SECS }; SettleOutcome::GraceStarted }
                _ => SettleOutcome::NotDue,
            },
            LoanState::Grace { until } => match plan_for_ltv(self.ltv(price), vol) {
                Some(p) if self.auto_renew => self.renew(p, now),
                _ if now >= until => {
                    self.state = LoanState::Auction { start: now, start_value: self.value(price) };
                    SettleOutcome::AuctionStarted
                }
                _ => SettleOutcome::NotDue,
            },
            LoanState::Auction { start, .. } => {
                if now >= start + AUCTION_SECS { self.state = LoanState::Defaulted; SettleOutcome::AuctionExpired } else { SettleOutcome::NotDue }
            }
            LoanState::Closed | LoanState::Defaulted => SettleOutcome::NotDue,
        }
    }

    /// Dutch auction: 100% of the oracle value at auction start, falling linearly to 50% over 24h.
    pub fn auction_price(&self, now: u64) -> u128 {
        match self.state {
            LoanState::Auction { start, start_value } => {
                let el = now.saturating_sub(start).min(AUCTION_SECS) as u128;
                start_value - start_value * (10_000 - AUCTION_FLOOR_BPS) * el / (10_000 * AUCTION_SECS as u128)
            }
            _ => 0,
        }
    }

    /// Highest-first Dutch bid: the pool keeps at most the debt; any surplus goes to the borrower.
    pub fn bid(&mut self, amount: u128, now: u64) -> Result<BidOutcome, LoanError> {
        match self.state {
            LoanState::Closed => Err(LoanError::LoanClosed),
            LoanState::Auction { start, .. } => {
                if now >= start + AUCTION_SECS { return Err(LoanError::AuctionOver); }
                if amount < self.auction_price(now) { return Err(LoanError::BidTooLow); }
                let recovered = amount.min(self.debt);
                let out = BidOutcome { recovered, surplus_to_borrower: amount - recovered, loss: self.debt - recovered };
                self.debt = 0;
                self.state = LoanState::Closed;
                Ok(out)
            }
            _ => Err(LoanError::NotInAuction),
        }
    }

    /// Repay any time until the loan is closed, including during an auction (which ends it).
    /// A full repay mid-term vests the rest of the term: prepaid interest is not refunded.
    pub fn repay(&mut self, amount: u128, _now: u64) -> Result<RepayOutcome, LoanError> {
        if matches!(self.state, LoanState::Closed | LoanState::Defaulted) { return Err(LoanError::LoanClosed); }
        if amount == 0 { return Err(LoanError::ZeroAmount); }
        if amount > self.debt { return Err(LoanError::OverRepay); }
        self.debt -= amount;
        if self.debt > 0 { return Ok(RepayOutcome::Partial); }
        let vest_now = if self.state == LoanState::Active { self.term_interest - self.vested } else { 0 };
        self.vested = self.term_interest;
        self.state = LoanState::Closed;
        Ok(RepayOutcome::Full { vest_now })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::{collateral_value_usdc, interest};
    use crate::plans::{plan, PlanId, VolState::Normal, DAY};
    const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
    const T0: u64 = 1_800_000_000;
    const PX: (i64, i32) = (362_000_000, -8);

    fn loan40() -> Loan {
        Loan::open(1, "whale.near".into(), "v1.pool.near".into(), "bisontrails.poolv1.near".into(), 10_000 * NEAR, 14_480_000_000, plan(PlanId::P40, Normal), T0)
    }
    fn price_for_ltv(l: &Loan, ltv_bps: u128) -> (i64, i32) {
        // price (expo -8) at which debt / value == ltv
        let micro = l.collateral_yocto / 1_000_000_000_000_000_000;
        ((l.debt * 10_000 * 100_000_000 / (ltv_bps * micro)) as i64, -8)
    }

    #[test]
    fn open_prepays_first_term_interest() {
        let l = loan40();
        assert_eq!(l.term_interest, 56_095_123);
        assert_eq!(l.expiry, T0 + 14 * DAY);
        assert_eq!(l.state, LoanState::Active);
    }

    #[test]
    fn settle_before_expiry_is_not_due_and_changes_nothing() {
        let mut l = loan40();
        let before = l.clone();
        assert_eq!(l.settle(PX, Normal, T0 + 14 * DAY - 1), SettleOutcome::NotDue);
        assert_eq!(l, before);
    }

    #[test]
    fn renewal_at_37_percent_stays_on_p40_and_adds_interest() {
        let mut l = loan40();
        let p = price_for_ltv(&l, 3_700);
        let out = l.settle(p, Normal, l.expiry);
        assert_eq!(out, SettleOutcome::Renewed(PlanId::P40));
        assert_eq!(l.debt, 14_480_000_000 + 56_095_123);
        assert_eq!(l.expiry, T0 + 28 * DAY);
    }

    #[test]
    fn renewal_at_45_percent_moves_to_p50() {
        let mut l = loan40();
        let p = price_for_ltv(&l, 4_500);
        assert_eq!(l.settle(p, Normal, l.expiry), SettleOutcome::Renewed(PlanId::P50));
        assert_eq!(l.expiry, T0 + 21 * DAY);
    }

    #[test]
    fn at_56_percent_notice_then_top_up_renews_with_gap_interest() {
        let mut l = loan40();
        let p = price_for_ltv(&l, 5_600);
        let exp = l.expiry;
        assert_eq!(l.settle(p, Normal, exp), SettleOutcome::NoticeStarted);
        assert_eq!(l.state, LoanState::Notice { until: exp + NOTICE_SECS });
        let value = collateral_value_usdc(l.collateral_yocto, p.0, p.1);
        let pay = l.debt - value / 2;
        assert_eq!(l.repay(pay, exp + DAY), Ok(RepayOutcome::Partial));
        let debt_before = l.debt;
        assert_eq!(l.settle(p, Normal, exp + DAY), SettleOutcome::Renewed(PlanId::P50));
        let gap_and_term = interest(debt_before, 1130, DAY) + interest(debt_before, 1130, 7 * DAY);
        assert_eq!(l.debt, debt_before + gap_and_term);
    }

    #[test]
    fn no_top_up_goes_notice_grace_auction() {
        let mut l = loan40();
        let p = price_for_ltv(&l, 5_600);
        let exp = l.expiry;
        l.settle(p, Normal, exp);
        assert_eq!(l.settle(p, Normal, exp + NOTICE_SECS - 1), SettleOutcome::NotDue);
        assert_eq!(l.settle(p, Normal, exp + NOTICE_SECS), SettleOutcome::GraceStarted);
        let t = exp + NOTICE_SECS + GRACE_SECS;
        assert_eq!(l.settle(p, Normal, t), SettleOutcome::AuctionStarted);
        let v = collateral_value_usdc(l.collateral_yocto, p.0, p.1);
        assert_eq!(l.state, LoanState::Auction { start: t, start_value: v });
    }

    #[test]
    fn auction_price_falls_from_100_to_50_percent_over_24h() {
        let mut l = loan40();
        l.state = LoanState::Auction { start: T0, start_value: 20_000_000_000 };
        assert_eq!(l.auction_price(T0), 20_000_000_000);
        assert_eq!(l.auction_price(T0 + AUCTION_SECS / 2), 15_000_000_000);
        assert_eq!(l.auction_price(T0 + AUCTION_SECS), 10_000_000_000);
    }

    #[test]
    fn winning_bid_pays_debt_and_returns_surplus() {
        let mut l = loan40();
        l.state = LoanState::Auction { start: T0, start_value: 20_000_000_000 };
        let mid = T0 + AUCTION_SECS / 2;
        assert_eq!(l.bid(14_999_999_999, mid), Err(LoanError::BidTooLow));
        let out = l.bid(15_000_000_000, mid).unwrap();
        assert_eq!(out, BidOutcome { recovered: 14_480_000_000, surplus_to_borrower: 520_000_000, loss: 0 });
        assert_eq!(l.state, LoanState::Closed);
        assert_eq!(l.debt, 0);
    }

    #[test]
    fn bid_below_debt_books_a_loss() {
        let mut l = loan40();
        l.state = LoanState::Auction { start: T0, start_value: 12_000_000_000 };
        let out = l.bid(12_000_000_000, T0).unwrap();
        assert_eq!(out, BidOutcome { recovered: 12_000_000_000, surplus_to_borrower: 0, loss: 2_480_000_000 });
    }

    #[test]
    fn repay_during_auction_closes_and_blocks_later_bids() {
        let mut l = loan40();
        l.state = LoanState::Auction { start: T0, start_value: 20_000_000_000 };
        assert_eq!(l.repay(l.debt, T0 + 60), Ok(RepayOutcome::Full { vest_now: 0 }));
        assert_eq!(l.state, LoanState::Closed);
        assert_eq!(l.bid(20_000_000_000, T0 + 120), Err(LoanError::LoanClosed));
    }

    #[test]
    fn unsold_auction_defaults_after_24h() {
        let mut l = loan40();
        l.state = LoanState::Auction { start: T0, start_value: 12_000_000_000 };
        assert_eq!(l.settle(PX, Normal, T0 + AUCTION_SECS - 1), SettleOutcome::NotDue);
        assert_eq!(l.settle(PX, Normal, T0 + AUCTION_SECS), SettleOutcome::AuctionExpired);
        assert_eq!(l.state, LoanState::Defaulted);
        assert_eq!(l.bid(20_000_000_000, T0 + AUCTION_SECS), Err(LoanError::NotInAuction));
    }

    #[test]
    fn interest_vests_linearly_and_early_repay_vests_the_rest() {
        let mut l = loan40();
        assert_eq!(l.vest_to(T0 + 7 * DAY), 56_095_123 / 2);
        assert_eq!(l.vest_to(T0 + 7 * DAY), 0);
        let rest = 56_095_123 - 56_095_123 / 2;
        assert_eq!(l.repay(l.debt, T0 + 7 * DAY), Ok(RepayOutcome::Full { vest_now: rest }));
    }

    #[test]
    fn repay_more_than_debt_or_zero_is_refused() {
        let mut l = loan40();
        assert_eq!(l.repay(l.debt + 1, T0), Err(LoanError::OverRepay));
        assert_eq!(l.repay(0, T0), Err(LoanError::ZeroAmount));
    }

    #[test]
    fn auto_renew_off_goes_straight_to_grace() {
        let mut l = loan40();
        l.auto_renew = false;
        let exp = l.expiry;
        assert_eq!(l.settle(PX, Normal, exp), SettleOutcome::GraceStarted);
        assert_eq!(l.state, LoanState::Grace { until: exp + GRACE_SECS });
    }
}
