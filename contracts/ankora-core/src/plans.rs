//! Loan menu. Normal state is the through-the-cycle floor; stressed only shortens terms (ankora-rate-formula.md).
pub const DAY: u64 = 86_400;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "borsh", derive(borsh::BorshSerialize, borsh::BorshDeserialize, borsh::BorshSchema))]
pub enum PlanId { P30, P40, P50 }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "borsh", derive(borsh::BorshSerialize, borsh::BorshDeserialize, borsh::BorshSchema))]
pub enum VolState { Normal, Stressed }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Plan { pub id: PlanId, pub ltv_cap_bps: u32, pub term_secs: u64, pub rate_bps: u32 }

pub fn plan(id: PlanId, s: VolState) -> Plan {
    let (cap, days, bps) = match (id, s) {
        (PlanId::P30, VolState::Normal) => (3000, 30, 970),
        (PlanId::P40, VolState::Normal) => (4000, 14, 1010),
        (PlanId::P50, VolState::Normal) => (5000, 7, 1130),
        (PlanId::P30, VolState::Stressed) => (3000, 14, 970), // model 910, floored at normal: stress only tightens
        (PlanId::P40, VolState::Stressed) => (4000, 7, 1010), // model 1000, floored at normal
        (PlanId::P50, VolState::Stressed) => (5000, 3, 1170),
    };
    Plan { id, ltv_cap_bps: cap, term_secs: days * DAY, rate_bps: bps }
}

/// Lowest-LTV plan whose cap covers `ltv_bps`; None above the 50% top cap.
pub fn plan_for_ltv(ltv_bps: u32, s: VolState) -> Option<Plan> {
    [PlanId::P30, PlanId::P40, PlanId::P50].into_iter().map(|id| plan(id, s)).find(|p| ltv_bps <= p.ltv_cap_bps)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ltv_40_picks_p40_in_normal_state() {
        assert_eq!(plan_for_ltv(4000, VolState::Normal).unwrap().id, PlanId::P40);
    }

    #[test]
    fn ltv_30_picks_p30_and_45_picks_p50() {
        assert_eq!(plan_for_ltv(3000, VolState::Normal).unwrap().id, PlanId::P30);
        assert_eq!(plan_for_ltv(4500, VolState::Normal).unwrap().id, PlanId::P50);
    }

    #[test]
    fn above_50_percent_has_no_plan() {
        assert!(plan_for_ltv(5001, VolState::Normal).is_none());
        assert!(plan_for_ltv(5001, VolState::Stressed).is_none());
    }

    #[test]
    fn normal_menu_matches_spec() {
        let p = plan(PlanId::P30, VolState::Normal);
        assert_eq!((p.ltv_cap_bps, p.term_secs, p.rate_bps), (3000, 30 * DAY, 970));
        let p = plan(PlanId::P40, VolState::Normal);
        assert_eq!((p.ltv_cap_bps, p.term_secs, p.rate_bps), (4000, 14 * DAY, 1010));
        let p = plan(PlanId::P50, VolState::Normal);
        assert_eq!((p.ltv_cap_bps, p.term_secs, p.rate_bps), (5000, 7 * DAY, 1130));
    }

    #[test]
    fn stressed_menu_only_tightens() {
        for id in [PlanId::P30, PlanId::P40, PlanId::P50] {
            let (n, s) = (plan(id, VolState::Normal), plan(id, VolState::Stressed));
            assert!(s.term_secs < n.term_secs, "stressed term must be shorter");
            assert_eq!(s.ltv_cap_bps, n.ltv_cap_bps);
            assert!(s.rate_bps >= n.rate_bps, "stressed rate must never be below the normal rate for the same plan");
        }
        assert_eq!(plan(PlanId::P50, VolState::Stressed).term_secs, 3 * DAY);
        assert_eq!(plan(PlanId::P30, VolState::Stressed).rate_bps, 970);
    }
}
