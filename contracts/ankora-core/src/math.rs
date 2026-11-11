//! Unit-safe loan maths. USDC has 6 decimals, NEAR is yocto (1e24), Pyth prices carry a negative exponent.
pub const BPS: u128 = 10_000;
pub const YEAR_SECS: u128 = 31_536_000;
pub const FEE_BPS: u128 = 500;
const YOCTO_TO_MICRO: u128 = 1_000_000_000_000_000_000; // 1e18: yocto -> 6-decimal NEAR

/// USDC value (6 dp) of `yocto` NEAR at Pyth `price * 10^expo`. Scales yocto down first so 10M NEAR at $20 fits u128.
pub fn collateral_value_usdc(yocto: u128, price: i64, expo: i32) -> u128 {
    assert!(price > 0, "price must be positive");
    assert!(expo < 0, "expo must be negative");
    (yocto / YOCTO_TO_MICRO) * price as u128 / 10u128.pow((-expo) as u32)
}

/// Debt over collateral value in basis points; u32::MAX when collateral is worthless.
pub fn ltv_bps(debt_usdc: u128, value_usdc: u128) -> u32 {
    if value_usdc == 0 { return u32::MAX; }
    u32::try_from(debt_usdc * BPS / value_usdc).unwrap_or(u32::MAX)
}

/// Simple interest for one term, rounded down.
pub fn interest(debt_usdc: u128, rate_bps: u32, term_secs: u64) -> u128 {
    debt_usdc * rate_bps as u128 * term_secs as u128 / (BPS * YEAR_SECS)
}

/// Ankora's 5% share of interest.
pub fn fee(interest: u128) -> u128 { interest * FEE_BPS / BPS }

#[cfg(test)]
mod tests {
    use super::*;
    const NEAR: u128 = 1_000_000_000_000_000_000_000_000;

    #[test]
    fn value_10k_near_at_3_62() {
        assert_eq!(collateral_value_usdc(10_000 * NEAR, 362_000_000, -8), 36_200_000_000);
    }

    #[test]
    fn value_10m_near_at_20_does_not_overflow() {
        assert_eq!(collateral_value_usdc(10_000_000 * NEAR, 2_000_000_000, -8), 200_000_000_000_000);
    }

    #[test]
    #[should_panic(expected = "price must be positive")]
    fn non_positive_price_panics() {
        collateral_value_usdc(NEAR, 0, -8);
    }

    #[test]
    fn ltv_of_14480_on_36200_is_40_percent() {
        assert_eq!(ltv_bps(14_480_000_000, 36_200_000_000), 4000);
        assert_eq!(ltv_bps(1, 0), u32::MAX);
    }

    #[test]
    fn fourteen_day_interest_and_fee() {
        let i = interest(14_480_000_000, 1010, 14 * 86_400);
        assert_eq!(i, 56_095_123);
        assert_eq!(fee(i), 2_804_756);
    }
}
