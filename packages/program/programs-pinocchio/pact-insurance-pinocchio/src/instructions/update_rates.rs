//! `update_rates` (discriminator 9) — Pinocchio port.
//!
//! Oracle-signed rate update on a per-provider `CoveragePool`. C-02
//! (continuation): the rate-updater is a crank run by a dedicated oracle
//! signer, deliberately separate from the cold admin authority — so the
//! signer check is `oracle_signer == config.oracle`, NOT `== config.authority`.
//!
//! Anchor source of truth:
//! `packages/program/programs/pact-insurance/src/instructions/update_rates.rs`.
//! The Anchor crate uses two distinct errors for the two bound violations
//! (`RateOutOfBounds` for `> 10_000` and `RateBelowFloor` for
//! `< pool.min_premium_bps`); both are already present in `PactError`
//! from WP-2 (codes 6027 and 6028), so this handler adds ZERO new variants.
//!
//! Accounts (order matches the Anchor builder):
//!   0. `config`        — readonly, PDA `[b"protocol"]`
//!   1. `pool`          — writable, PDA `[b"pool", hostname]`
//!   2. `oracle_signer` — signer, must equal `config.oracle`
//!
//! Wire format (after the 1-byte discriminator stripped by the entrypoint):
//!   offset 0..2 `new_rate_bps: u16` LE — matches the Anchor
//!   `update_rates(new_rate_bps: u16)` Borsh layout bit-for-bit. Using `u16`
//!   (not `u64`) keeps the TS client a trivial 2-byte encode and avoids a
//!   silent layout drift at WP-17 cut-over.
//!
//! Validation ordering: structural (account count / signer / writable / PDA)
//! → decode `new_rate_bps` → bound checks → load config + oracle check →
//! load pool + floor check → mutation. The bound check against the hard cap
//! (10_000) is stateless so it runs before any borrow; the floor check must
//! read `pool.min_premium_bps` so it lives alongside the mutation.

use pinocchio::{
    account::AccountView,
    error::ProgramError,
    sysvars::{clock::Clock, Sysvar},
    ProgramResult,
};

use crate::{
    error::PactError,
    pda::derive_protocol,
    state::{CoveragePool, ProtocolConfig},
};

const ACCOUNT_COUNT: usize = 3;
const NEW_RATE_LEN: usize = 2;
const MAX_RATE_BPS: u16 = 10_000;

pub fn process(accounts: &[AccountView], data: &[u8]) -> ProgramResult {
    if accounts.len() < ACCOUNT_COUNT {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let config_acct = &accounts[0];
    let pool_acct = &accounts[1];
    let oracle_signer = &accounts[2];

    // ---- structural guards --------------------------------------------------
    if !pool_acct.is_writable() {
        return Err(ProgramError::InvalidAccountData);
    }
    if !oracle_signer.is_signer() {
        return Err(PactError::Unauthorized.into());
    }

    // Config PDA identity — the oracle-check relies on reading `config.oracle`,
    // so the account passed MUST be the canonical protocol config PDA.
    let (expected_config_pda, _bump) = derive_protocol();
    if config_acct.address() != &expected_config_pda {
        return Err(ProgramError::InvalidSeeds);
    }

    // Ownership: both config and pool are program-owned PDAs.
    if !config_acct.owned_by(&crate::ID) {
        return Err(PactError::Unauthorized.into());
    }
    if !pool_acct.owned_by(&crate::ID) {
        return Err(PactError::Unauthorized.into());
    }

    // ---- decode new_rate_bps (raw 2 LE bytes, no tag) ----------------------
    if data.len() != NEW_RATE_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }
    let new_rate_bps = u16::from_le_bytes([data[0], data[1]]);

    // Hard cap — stateless, runs before any borrow.
    if new_rate_bps > MAX_RATE_BPS {
        return Err(PactError::RateOutOfBounds.into());
    }

    // ---- oracle check (read-only borrow of config) -------------------------
    {
        let config_data = config_acct.try_borrow()?;
        let cfg = ProtocolConfig::try_from_bytes(&config_data)?;
        if oracle_signer.address() != &cfg.oracle {
            return Err(PactError::UnauthorizedOracle.into());
        }
    }

    // ---- clock snapshot (matches Anchor: updated_at is stamped) -----------
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    // ---- load pool: floor check + mutation ---------------------------------
    let mut pool_data = pool_acct.try_borrow_mut()?;
    let pool = CoveragePool::try_from_bytes_mut(&mut pool_data)?;

    if new_rate_bps < pool.min_premium_bps {
        return Err(PactError::RateBelowFloor.into());
    }

    pool.insurance_rate_bps = new_rate_bps;
    pool.updated_at = now;
    Ok(())
}

// ---------------------------------------------------------------------------
// Host-side unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn max_rate_bps_is_10_000() {
        assert_eq!(MAX_RATE_BPS, 10_000);
    }

    #[test]
    fn rate_out_of_bounds_error_is_6027() {
        let err: ProgramError = PactError::RateOutOfBounds.into();
        assert_eq!(err, ProgramError::Custom(6027));
    }

    #[test]
    fn rate_below_floor_error_is_6028() {
        let err: ProgramError = PactError::RateBelowFloor.into();
        assert_eq!(err, ProgramError::Custom(6028));
    }

    #[test]
    fn unauthorized_oracle_error_is_6025() {
        let err: ProgramError = PactError::UnauthorizedOracle.into();
        assert_eq!(err, ProgramError::Custom(6025));
    }

    #[test]
    fn decode_new_rate_bps_reads_u16_le() {
        let bytes = 1234_u16.to_le_bytes();
        assert_eq!(u16::from_le_bytes([bytes[0], bytes[1]]), 1234);
    }
}
