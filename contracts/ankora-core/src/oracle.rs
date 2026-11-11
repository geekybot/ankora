//! Oracle rules: the price is read only when a loan starts or renews (ankora-oracle-custody-usp.md, section 1).
//! The oracle can refuse a start or a renewal; it never takes collateral.
pub const MAX_PRICE_AGE_SECS: i64 = 60;
pub const MAX_CONF_BPS: u128 = 100; // 1% of price
pub const BREAKER_BPS: u128 = 300; // 3% spot/EMA gap blocks new loans

/// Mirrors Pyth NEAR's `Price` (I64/U64 JSON strings are converted by the contract layer).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PythPrice { pub price: i64, pub conf: u64, pub expo: i32, pub publish_time: i64 }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OracleError { Missing, Stale, WideConfidence, Breaker, ExpoMismatch, Invalid }

fn check(p: Option<PythPrice>, now: i64) -> Result<PythPrice, OracleError> {
    let p = p.ok_or(OracleError::Missing)?;
    if p.price <= 0 { return Err(OracleError::Invalid); }
    if (now - p.publish_time).abs() > MAX_PRICE_AGE_SECS { return Err(OracleError::Stale); }
    if p.conf as u128 * 10_000 > p.price as u128 * MAX_CONF_BPS { return Err(OracleError::WideConfidence); }
    Ok(p)
}

/// Price to value collateral at: min(spot, EMA), after age, confidence and (for new loans) breaker checks.
pub fn collateral_price(spot: Option<PythPrice>, ema: Option<PythPrice>, now_secs: i64, for_new_loan: bool) -> Result<(i64, i32), OracleError> {
    let (s, e) = (check(spot, now_secs)?, check(ema, now_secs)?);
    if s.expo != e.expo { return Err(OracleError::ExpoMismatch); }
    let gap = (s.price - e.price).unsigned_abs() as u128;
    if for_new_loan && gap * 10_000 > s.price as u128 * BREAKER_BPS { return Err(OracleError::Breaker); }
    Ok((s.price.min(e.price), s.expo))
}

#[cfg(test)]
mod tests {
    use super::*;
    const NOW: i64 = 1_800_000_000;
    fn px(price: i64, conf: u64, age: i64) -> Option<PythPrice> {
        Some(PythPrice { price, conf, expo: -8, publish_time: NOW - age })
    }

    #[test]
    fn missing_price_is_refused() {
        assert_eq!(collateral_price(None, px(362_000_000, 0, 0), NOW, true), Err(OracleError::Missing));
        assert_eq!(collateral_price(px(362_000_000, 0, 0), None, NOW, false), Err(OracleError::Missing));
    }

    #[test]
    fn price_61s_old_or_61s_in_future_is_stale() {
        assert_eq!(collateral_price(px(362_000_000, 0, 61), px(362_000_000, 0, 0), NOW, true), Err(OracleError::Stale));
        assert_eq!(collateral_price(px(362_000_000, 0, -61), px(362_000_000, 0, 0), NOW, true), Err(OracleError::Stale));
        assert!(collateral_price(px(362_000_000, 0, 60), px(362_000_000, 0, 60), NOW, true).is_ok());
    }

    #[test]
    fn confidence_wider_than_1_percent_is_refused() {
        assert_eq!(collateral_price(px(362_000_000, 3_656_200, 0), px(362_000_000, 0, 0), NOW, true), Err(OracleError::WideConfidence));
        assert!(collateral_price(px(362_000_000, 3_620_000, 0), px(362_000_000, 3_620_000, 0), NOW, true).is_ok());
    }

    #[test]
    fn breaker_blocks_new_loans_but_not_renewals() {
        let (spot, ema) = (px(362_000_000, 0, 0), px(373_222_000, 0, 0)); // ema 3.1% above spot
        assert_eq!(collateral_price(spot, ema, NOW, true), Err(OracleError::Breaker));
        assert_eq!(collateral_price(spot, ema, NOW, false), Ok((362_000_000, -8)));
    }

    #[test]
    fn collateral_price_is_min_of_spot_and_ema() {
        assert_eq!(collateral_price(px(362_000_000, 0, 0), px(360_000_000, 0, 0), NOW, true), Ok((360_000_000, -8)));
        assert_eq!(collateral_price(px(360_000_000, 0, 0), px(362_000_000, 0, 0), NOW, true), Ok((360_000_000, -8)));
    }

    #[test]
    fn mismatched_exponent_or_bad_price_is_refused() {
        let mut e = px(362_000_000, 0, 0); e.as_mut().unwrap().expo = -6;
        assert_eq!(collateral_price(px(362_000_000, 0, 0), e, NOW, true), Err(OracleError::ExpoMismatch));
        assert_eq!(collateral_price(px(0, 0, 0), px(362_000_000, 0, 0), NOW, true), Err(OracleError::Invalid));
    }
}
