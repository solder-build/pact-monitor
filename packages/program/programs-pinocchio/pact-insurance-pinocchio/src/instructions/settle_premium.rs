//! `settle_premium` (discriminator 7) — Pinocchio port, Phase 5 F1 three-way split.
//!
//! Crank-driven handler that sweeps an agent's per-call premium from the
//! agent's delegated SPL-Token account and splits it into up to three transfers:
//!   1. pool vault         — `pool_cut`
//!   2. treasury_ata       — `treasury_cut = gross * config.protocol_fee_bps / 10_000`
//!   3. referrer_token_ata — `referrer_cut = gross * policy.referrer_share_bps / 10_000`
//!                           (only if `policy.referrer_present == 1`).
//!
//! Anchor source of truth:
//!   `packages/program/programs/pact-insurance/src/instructions/settle_premium.rs`
//!
//! ### H-05 premium-evasion guard (spec §5.8)
//! This handler INTENTIONALLY does NOT gate on `policy.active`. If an agent
//! racks up billable calls during a settlement window and then calls
//! `disable_policy` before the crank lands, the premium for those calls is
//! still owed — they were made under coverage. Revocation blocks new
//! `submit_claim`, not collection of already-accrued premium. `expires_at` is
//! still enforced so stale policies stop accruing.
//!
//! ### Phase 5 F1 — three-way split (Rick Q4 2026-04-24, Option A)
//! Legacy policies with `referrer_present == 0` settle two-way (pool +
//! treasury). When present, the referrer's USDC ATA is passed at
//! `remaining_accounts[0]` (position 8 in the account list). A missing or
//! mismatched referrer ATA fails LOUD with `TokenAccountMismatch` (6005) —
//! silently dropping the referrer cut into the pool would be a quiet-theft
//! footgun (PRD line 136).
//!
//! Alan's locked decisions:
//!   - #3: preserve 6000..=6030. Zero new PactError variants.
//!   - #7: `MAX_REFERRER_SHARE_BPS = 3000` enforced at `enable_insurance`;
//!     this handler trusts the snapshotted value but still math-guards the
//!     `treasury_cut + referrer_cut <= gross` invariant.
//!
//! Wire format (after the 1-byte discriminator stripped by the entrypoint):
//!   offset 0..8   `call_value: u64` LE
//!
//! Accounts (order matches the Anchor builder, extended with `token_program`
//! tail for wire parity with WP-10 `withdraw` and optional
//! `referrer_token_account` as the first entry in `remaining_accounts`):
//!   0. `config`              — readonly, PDA `[b"protocol"]`
//!   1. `pool`                — writable, PDA `[b"pool", hostname]`
//!   2. `vault`               — writable SPL-Token account (pool USDC vault)
//!   3. `policy`              — writable, PDA `[b"policy", pool, agent]`
//!                               (H-05: active not required)
//!   4. `treasury_ata`        — writable SPL-Token account owned by
//!                               `config.treasury`
//!   5. `agent_ata`           — writable SPL-Token account; delegate must be
//!                               `pool`
//!   6. `oracle_signer`       — signer; `key == config.oracle`
//!   7. `token_program`       — SPL Token Program
//!   8. `referrer_token_ata`  — OPTIONAL, only when `policy.referrer_present == 1`;
//!                               must be an SPL-Token account with
//!                               `mint == config.usdc_mint` and
//!                               `owner == policy.referrer`.

use pinocchio::{
    account::AccountView,
    cpi::Seed,
    error::ProgramError,
    sysvars::{clock::Clock, Sysvar},
    ProgramResult,
};

use crate::{
    error::PactError,
    pda::POOL_SEED_PREFIX,
    state::{CoveragePool, Policy, ProtocolConfig},
    token::{transfer_pool_signed, SPL_TOKEN_PROGRAM_ID},
    token_account,
};

/// Minimum required account count (without the optional referrer_token_account).
const BASE_ACCOUNT_COUNT: usize = 8;

pub fn process(accounts: &[AccountView], data: &[u8]) -> ProgramResult {
    if accounts.len() < BASE_ACCOUNT_COUNT {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let config_acct = &accounts[0];
    let pool_acct = &accounts[1];
    let vault_acct = &accounts[2];
    let policy_acct = &accounts[3];
    let treasury_ata_acct = &accounts[4];
    let agent_ata_acct = &accounts[5];
    let oracle_signer = &accounts[6];
    let token_program = &accounts[7];
    let remaining = if accounts.len() > BASE_ACCOUNT_COUNT {
        &accounts[BASE_ACCOUNT_COUNT..]
    } else {
        &[][..]
    };

    // ---- program-id + signer + writability + ownership (cheap first) ------
    if token_program.address() != &SPL_TOKEN_PROGRAM_ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    if !oracle_signer.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !pool_acct.is_writable()
        || !policy_acct.is_writable()
        || !vault_acct.is_writable()
        || !treasury_ata_acct.is_writable()
        || !agent_ata_acct.is_writable()
    {
        return Err(ProgramError::InvalidAccountData);
    }
    if !pool_acct.owned_by(&crate::ID) || !policy_acct.owned_by(&crate::ID) {
        return Err(PactError::Unauthorized.into());
    }
    if !agent_ata_acct.owned_by(&SPL_TOKEN_PROGRAM_ID)
        || !treasury_ata_acct.owned_by(&SPL_TOKEN_PROGRAM_ID)
        || !vault_acct.owned_by(&SPL_TOKEN_PROGRAM_ID)
    {
        return Err(PactError::TokenAccountMismatch.into());
    }

    // ---- parse args --------------------------------------------------------
    let call_value = decode_call_value(data)?;

    // ---- oracle identity (snapshot config) --------------------------------
    let config_oracle;
    let config_treasury;
    let config_protocol_fee_bps;
    let config_usdc_mint;
    {
        let config_data = config_acct.try_borrow()?;
        let cfg = ProtocolConfig::try_from_bytes(&config_data)?;
        config_oracle = cfg.oracle;
        config_treasury = cfg.treasury;
        config_protocol_fee_bps = cfg.protocol_fee_bps;
        config_usdc_mint = cfg.usdc_mint;
    }
    if oracle_signer.address() != &config_oracle {
        return Err(PactError::UnauthorizedOracle.into());
    }

    // ---- expiry gate (H-05: no `active` gate) -----------------------------
    let (policy_expires_at, policy_pool, policy_referrer, policy_referrer_present) = {
        let policy_data = policy_acct.try_borrow()?;
        let policy = Policy::try_from_bytes(&policy_data)?;
        (
            policy.expires_at,
            policy.pool,
            policy.referrer,
            policy.referrer_present,
        )
    };
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    if now >= policy_expires_at {
        return Err(PactError::PolicyExpired.into());
    }
    // Policy must belong to this pool.
    if policy_pool != *pool_acct.address() {
        return Err(PactError::Unauthorized.into());
    }

    // ---- pool snapshot: rate, usdc_mint, vault, hostname, bump -----------
    let pool_rate_bps;
    let pool_usdc_mint;
    let pool_vault;
    let pool_bump;
    let hostname_len;
    let mut hostname_buf = [0u8; 64];
    let policy_referrer_share_bps;
    {
        let pool_data = pool_acct.try_borrow()?;
        let pool = CoveragePool::try_from_bytes(&pool_data)?;
        pool_rate_bps = pool.insurance_rate_bps;
        pool_usdc_mint = pool.usdc_mint;
        pool_vault = pool.vault;
        pool_bump = pool.bump;
        hostname_len = core::cmp::min(
            pool.provider_hostname_len as usize,
            pool.provider_hostname.len(),
        );
        hostname_buf[..hostname_len].copy_from_slice(&pool.provider_hostname[..hostname_len]);
    }
    // Re-open policy to read `referrer_share_bps` alongside the other fields.
    {
        let policy_data = policy_acct.try_borrow()?;
        let policy = Policy::try_from_bytes(&policy_data)?;
        policy_referrer_share_bps = policy.referrer_share_bps;
    }

    // Vault identity + mint (pool.vault pinned at create_pool).
    if vault_acct.address() != &pool_vault {
        return Err(PactError::TokenAccountMismatch.into());
    }
    {
        let vault_data = vault_acct.try_borrow()?;
        let vault_mint = token_account::read_mint(&vault_data)?;
        if vault_mint != pool_usdc_mint.as_ref() {
            return Err(PactError::TokenAccountMismatch.into());
        }
    }

    // Treasury ATA: mint + owner.
    {
        let t_data = treasury_ata_acct.try_borrow()?;
        let t_mint = token_account::read_mint(&t_data)?;
        let t_owner = token_account::read_owner(&t_data)?;
        if t_mint != pool_usdc_mint.as_ref() {
            return Err(PactError::TokenAccountMismatch.into());
        }
        if t_owner != config_treasury.as_ref() {
            return Err(PactError::TokenAccountMismatch.into());
        }
    }

    // Agent ATA: mint, delegation, premium math.
    let agent_amount;
    let agent_delegated_amount;
    {
        let a_data = agent_ata_acct.try_borrow()?;
        let a_mint = token_account::read_mint(&a_data)?;
        if a_mint != pool_usdc_mint.as_ref() {
            return Err(PactError::TokenAccountMismatch.into());
        }
        let delegate = token_account::read_delegate(&a_data)?;
        let delegate_bytes = delegate.ok_or(PactError::DelegationMissing)?;
        if delegate_bytes != pool_acct.address().as_ref() {
            return Err(PactError::DelegationMissing.into());
        }
        agent_amount = token_account::read_amount(&a_data)?;
        agent_delegated_amount = token_account::read_delegated_amount(&a_data)?;
    }

    // ---- premium math (u128 intermediate, clamp by delegated + balance) ---
    let gross = compute_gross(call_value, pool_rate_bps, agent_delegated_amount, agent_amount)?;
    if gross == 0 {
        return Ok(());
    }

    // Split (u128-intermediate, bounded-sum sanity guard).
    let (pool_cut, treasury_cut, referrer_cut) = split_premium(
        gross,
        config_protocol_fee_bps,
        if policy_referrer_present == 1 {
            policy_referrer_share_bps
        } else {
            0
        },
    )?;

    // ---- Phase 5 F1 referrer ATA validation (fail loud) -------------------
    let has_referrer = policy_referrer_present == 1;
    let referrer_ta_acct = if has_referrer {
        if remaining.is_empty() {
            return Err(PactError::TokenAccountMismatch.into());
        }
        let r = &remaining[0];
        if !r.is_writable() {
            return Err(ProgramError::InvalidAccountData);
        }
        if !r.owned_by(&SPL_TOKEN_PROGRAM_ID) {
            return Err(PactError::TokenAccountMismatch.into());
        }
        let r_data = r.try_borrow()?;
        let r_mint = token_account::read_mint(&r_data)?;
        let r_owner = token_account::read_owner(&r_data)?;
        if r_mint != config_usdc_mint.as_ref() {
            return Err(PactError::TokenAccountMismatch.into());
        }
        if r_owner != &policy_referrer {
            return Err(PactError::TokenAccountMismatch.into());
        }
        drop(r_data);
        Some(r)
    } else {
        None
    };

    // ---- pool-PDA-signed Transfer CPIs -----------------------------------
    let pool_bump_arr = [pool_bump];
    let hostname_bytes = &hostname_buf[..hostname_len];
    let signer_seeds: [Seed; 3] = [
        Seed::from(POOL_SEED_PREFIX),
        Seed::from(hostname_bytes),
        Seed::from(&pool_bump_arr[..]),
    ];

    if pool_cut > 0 {
        transfer_pool_signed(agent_ata_acct, vault_acct, pool_acct, pool_cut, &signer_seeds)?;
    }
    if treasury_cut > 0 {
        transfer_pool_signed(
            agent_ata_acct,
            treasury_ata_acct,
            pool_acct,
            treasury_cut,
            &signer_seeds,
        )?;
    }
    if let Some(ref r) = referrer_ta_acct {
        if referrer_cut > 0 {
            transfer_pool_signed(agent_ata_acct, r, pool_acct, referrer_cut, &signer_seeds)?;
        }
    }

    // ---- state updates ----------------------------------------------------
    {
        let mut policy_data = policy_acct.try_borrow_mut()?;
        let policy = Policy::try_from_bytes_mut(&mut policy_data)?;
        policy.total_premiums_paid = policy
            .total_premiums_paid
            .checked_add(gross)
            .ok_or(PactError::ArithmeticOverflow)?;
    }
    {
        let mut pool_data = pool_acct.try_borrow_mut()?;
        let pool = CoveragePool::try_from_bytes_mut(&mut pool_data)?;
        pool.total_premiums_earned = pool
            .total_premiums_earned
            .checked_add(pool_cut)
            .ok_or(PactError::ArithmeticOverflow)?;
        pool.total_available = pool
            .total_available
            .checked_add(pool_cut)
            .ok_or(PactError::ArithmeticOverflow)?;
        pool.updated_at = now;
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

#[inline]
fn decode_call_value(data: &[u8]) -> Result<u64, ProgramError> {
    if data.len() != 8 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let mut buf = [0u8; 8];
    buf.copy_from_slice(&data[..8]);
    Ok(u64::from_le_bytes(buf))
}

/// u128-intermediate gross premium, clamped by both `delegated_amount` and
/// `balance`. Mirrors Anchor's handler: `min(call_value * rate_bps / 10_000,
/// delegated, balance)`.
#[inline]
fn compute_gross(
    call_value: u64,
    rate_bps: u16,
    delegated: u64,
    balance: u64,
) -> Result<u64, ProgramError> {
    let product = (call_value as u128)
        .checked_mul(rate_bps as u128)
        .ok_or(PactError::ArithmeticOverflow)?;
    let ideal = product / 10_000;
    let delegated_u128 = delegated as u128;
    let balance_u128 = balance as u128;
    let clamped = core::cmp::min(core::cmp::min(ideal, delegated_u128), balance_u128);
    // clamped <= min(delegated, balance) <= u64::MAX, so the cast is safe.
    Ok(clamped as u64)
}

/// Three-way split from `gross` into `(pool_cut, treasury_cut, referrer_cut)`.
/// `pool_cut = gross - treasury_cut - referrer_cut`. Sanity guard:
/// `treasury_cut + referrer_cut <= gross` before computing pool_cut, to catch
/// bps values that would push the sum past gross (only reachable if
/// `MAX_REFERRER_SHARE_BPS + protocol_fee_bps > 10_000`, which the config
/// floors prevent — but encoded honestly anyway).
///
/// PRD line 51 slot: future tiered logic can replace this body without
/// changing the signature.
pub fn split_premium(
    gross: u64,
    treasury_bps: u16,
    referrer_share_bps: u16,
) -> Result<(u64, u64, u64), ProgramError> {
    let gross_u128 = gross as u128;
    let treasury_cut = gross_u128
        .checked_mul(treasury_bps as u128)
        .ok_or(PactError::ArithmeticOverflow)?
        / 10_000;
    let referrer_cut = gross_u128
        .checked_mul(referrer_share_bps as u128)
        .ok_or(PactError::ArithmeticOverflow)?
        / 10_000;
    let sum = treasury_cut
        .checked_add(referrer_cut)
        .ok_or(PactError::ArithmeticOverflow)?;
    if sum > gross_u128 {
        return Err(PactError::ArithmeticOverflow.into());
    }
    let pool_cut = gross_u128 - sum;
    // All three are <= gross <= u64::MAX by the sum guard above.
    Ok((pool_cut as u64, treasury_cut as u64, referrer_cut as u64))
}

// ---------------------------------------------------------------------------
// Host-side unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_call_value_reads_u64_le() {
        let bytes = 7_u64.to_le_bytes();
        assert_eq!(decode_call_value(&bytes).unwrap(), 7);
    }

    #[test]
    fn decode_call_value_rejects_wrong_length() {
        assert!(matches!(
            decode_call_value(&[0u8; 7]),
            Err(ProgramError::InvalidInstructionData)
        ));
        assert!(matches!(
            decode_call_value(&[0u8; 9]),
            Err(ProgramError::InvalidInstructionData)
        ));
    }

    #[test]
    fn compute_gross_applies_rate_and_clamps_to_delegated() {
        // call_value 1_000_000 (1 USDC), rate 25 bps => ideal 2_500.
        // delegated 1_000, balance 1_000_000 → clamp to delegated.
        let gross = compute_gross(1_000_000, 25, 1_000, 1_000_000).unwrap();
        assert_eq!(gross, 1_000);
    }

    #[test]
    fn compute_gross_clamps_to_balance() {
        let gross = compute_gross(1_000_000, 25, 10_000_000, 500).unwrap();
        assert_eq!(gross, 500);
    }

    #[test]
    fn compute_gross_no_clamp_when_ideal_fits() {
        let gross = compute_gross(4_000_000, 25, 10_000_000, 10_000_000).unwrap();
        assert_eq!(gross, 10_000);
    }

    #[test]
    fn split_premium_math_no_overflow() {
        // gross = u64::MAX, treasury_bps = 1000 (10%), referrer 3000 (30%).
        // u128 intermediate keeps us from overflowing.
        let (pool_cut, t, r) = split_premium(u64::MAX, 1000, 3000).unwrap();
        // Expected: t = u64::MAX * 1000 / 10_000 = u64::MAX / 10 (floor).
        // r = u64::MAX * 3000 / 10_000 = 3 * u64::MAX / 10 (floor).
        // pool = gross - t - r.
        let gross128 = u64::MAX as u128;
        let t128 = gross128 * 1000 / 10_000;
        let r128 = gross128 * 3000 / 10_000;
        let p128 = gross128 - t128 - r128;
        assert_eq!(t as u128, t128);
        assert_eq!(r as u128, r128);
        assert_eq!(pool_cut as u128, p128);
    }

    #[test]
    fn split_premium_sums_back_to_gross() {
        // Deterministic "pseudo-random" combinations — ensure no lossy
        // rounding beyond the floor-division at the treasury_cut /
        // referrer_cut boundaries (pool_cut absorbs the remainder).
        let cases: &[(u64, u16, u16)] = &[
            (10_000, 1_500, 0),
            (10_000, 1_500, 1_000),
            (1, 1_500, 1_000),
            (123_456_789, 700, 2_500),
            (u64::MAX / 2, 2_999, 3_000),
            (7, 9_999, 0),
        ];
        for &(gross, t_bps, r_bps) in cases {
            let (p, t, r) = split_premium(gross, t_bps, r_bps).unwrap();
            assert_eq!(p + t + r, gross, "case gross={gross} t_bps={t_bps} r_bps={r_bps}");
        }
    }

    #[test]
    fn split_premium_rejects_overflow_combination() {
        // treasury_bps + referrer_share_bps > 10_000 => sum > gross.
        // e.g. 6000 + 5000 = 11000 bps on gross=10_000 => t=6_000 r=5_000
        // sum=11_000 > gross=10_000 → ArithmeticOverflow.
        let err = split_premium(10_000, 6_000, 5_000).unwrap_err();
        assert_eq!(err, ProgramError::Custom(6023));
    }

    #[test]
    fn split_premium_handles_zero_shares() {
        let (p, t, r) = split_premium(10_000, 0, 0).unwrap();
        assert_eq!((p, t, r), (10_000, 0, 0));
    }

    #[test]
    fn split_premium_handles_exact_sum_at_10000_bps() {
        // Edge: treasury + referrer = 10_000 bps → pool_cut == 0.
        let (p, t, r) = split_premium(10_000, 7_000, 3_000).unwrap();
        assert_eq!(p, 0);
        assert_eq!(t, 7_000);
        assert_eq!(r, 3_000);
    }

    #[test]
    fn unauthorized_oracle_is_6025() {
        let err: ProgramError = PactError::UnauthorizedOracle.into();
        assert_eq!(err, ProgramError::Custom(6025));
    }

    #[test]
    fn policy_expired_is_6029() {
        let err: ProgramError = PactError::PolicyExpired.into();
        assert_eq!(err, ProgramError::Custom(6029));
    }

    #[test]
    fn token_account_mismatch_is_6005() {
        let err: ProgramError = PactError::TokenAccountMismatch.into();
        assert_eq!(err, ProgramError::Custom(6005));
    }
}
