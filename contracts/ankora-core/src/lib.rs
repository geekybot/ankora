//! Pure Ankora logic: plans, maths, oracle checks, lender ledger, loan state machine.
//! No chain code, so every rule is unit-tested off-chain. Mechanism summary: contracts/README.md.
pub mod math;
pub mod plans;
pub mod oracle;
pub mod tranche;
pub mod loans;
