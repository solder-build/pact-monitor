//! `enable_insurance` (discriminator 5) — Pinocchio port, Phase 5 F1 extended.
//!
//! Creates the per-agent `Policy` PDA and snapshots the referrer fields at
//! creation time. First handler in the port that exercises:
//!   1. `CreateAccount` signed by `policy_seeds` (the new PDA itself).
//!   2. Hand-coded SPL Token-account field reads (spec §8.9) via
//!      `crate::token_account` — mint / owner / delegate / delegated_amount.
//!   3. Phase 5 F1 referrer snapshot + validation (Rick Q3 2026-04-24).
//!
//! Anchor source of truth: `packages/program/programs/pact-insurance/src/instructions/enable_insurance.rs`.
//! Policy layout reference: `src/state.rs` — offset invariants pinned by
//! `const _` asserts on `referrer`, `referrer_share_bps`, `referrer_present`
//! (WP-11.1 commit 88413f7).
//!
//! ### Seed strategy (spec §3.6 note)
//! `[b"policy", pool.as_ref(), agent.key().as_ref()]` uses the agent **wallet**
//! pubkey — NOT the agent_token_account key. Anchor's `enable_insurance.rs`
//! encodes this via `agent.key().as_ref()` on the `Signer<'info>`; changing
//! the seed strategy would re-derive every existing policy address.
//!
//! ### Phase 5 F1 validation (WP-12 scope)
//! - `referrer_share_bps <= MAX_REFERRER_SHARE_BPS` (3000) else `RateOutOfBounds` (6027)
//! - `referrer_present == 0` iff `referrer_share_bps == 0`. Violations return
//!   `InvalidRate` (6014). Chosen over minting a new variant because Alan's
//!   locked decision #3 pins the 6000..=6030 range and the mutual-exclusion
//!   failure is *the* semantic "bad rate" at policy creation — ergonomic fit
//!   with the existing `InvalidRate` bucket (same variant reused by
//!   `update_rates` for non-oracle rate errors).
//!
//! ### Referrer snapshot (PRD Feature 1)
//! The three referrer fields are **snapshotted** into the Policy at creation.
//! Later handlers (WP-14 `settle_premium`) read `policy.referrer*` directly;
//! they do not look up a separate referrer account. This matches PRD line 46
//! ("referrer_share_bps SNAPSHOTTED at policy creation for predictability").
//!
//! Wire format (after the 1-byte discriminator stripped by the entrypoint) —
//! matches Anchor's Borsh layout byte-for-byte on the existing fields, plus
//! the Phase 5 F1 referrer tail:
//!   offset 0..4                agent_id length (`u32` LE, Borsh `String`)
//!   offset 4..4+len            agent_id bytes (UTF-8)
//!   offset +8                  expires_at (`i64` LE)
//!   -- Phase 5 F1 tail --
//!   offset +32                 referrer bytes (`[u8; 32]`)
//!   offset +1                  referrer_present (`u8`; 0 = None, 1 = Some)
//!   offset +2                  referrer_share_bps (`u16` LE)
//!
//! Accounts (order matches the Anchor builder):
//!   0. `config`                — readonly, PDA `[b"protocol"]`
//!   1. `pool`                  — writable, PDA `[b"pool", hostname]`
//!   2. `policy`                — writable, PDA `[b"policy", pool, agent]`,
//!                                 created here
//!   3. `agent_token_account`   — readonly SPL-Token account
//!   4. `agent`                 — writable signer (pays policy rent)
//!   5. `system_program`        — `11111111111111111111111111111111`

use pinocchio::{
    account::AccountView,
    cpi::Seed,
    error::ProgramError,
    sysvars::{clock::Clock, rent::Rent, Sysvar},
    ProgramResult,
};

use crate::{
    constants::{MAX_AGENT_ID_LEN, MAX_REFERRER_SHARE_BPS},
    error::PactError,
    pda::{derive_policy, derive_protocol, POLICY_SEED_PREFIX},
    state::{CoveragePool, Policy, ProtocolConfig},
    system::{create_account, SYSTEM_PROGRAM_ID},
    token::SPL_TOKEN_PROGRAM_ID,
    token_account,
};

const ACCOUNT_COUNT: usize = 6;

pub fn process(accounts: &[AccountView], data: &[u8]) -> ProgramResult {
    if accounts.len() < ACCOUNT_COUNT {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let config_acct = &accounts[0];
    let pool_acct = &accounts[1];
    let policy_acct = &accounts[2];
    let agent_ta_acct = &accounts[3];
    let agent_acct = &accounts[4];
    let system_program = &accounts[5];

    // ---- program-id guard --------------------------------------------------
    if system_program.address() != &SYSTEM_PROGRAM_ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    // ---- signer + writability ---------------------------------------------
    if !agent_acct.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !agent_acct.is_writable() {
        return Err(ProgramError::InvalidAccountData);
    }
    if !pool_acct.is_writable() || !policy_acct.is_writable() {
        return Err(ProgramError::InvalidAccountData);
    }

    // ---- ownership guards --------------------------------------------------
    if !pool_acct.owned_by(&crate::ID) {
        return Err(PactError::Unauthorized.into());
    }
    if !agent_ta_acct.owned_by(&SPL_TOKEN_PROGRAM_ID) {
        return Err(PactError::TokenAccountMismatch.into());
    }

    // ---- parse args (fail fast before touching account state) -------------
    let args = EnableInsuranceArgs::decode(data)?;

    // Phase 5 F1 validation — order: cap first, then mutual-exclusion.
    if args.referrer_share_bps > MAX_REFERRER_SHARE_BPS {
        return Err(PactError::RateOutOfBounds.into());
    }
    let present_flag = args.referrer_present != 0;
    let share_nonzero = args.referrer_share_bps != 0;
    if present_flag != share_nonzero {
        // Mutual-exclusion violation — either (1,0) or (0,>0).
        return Err(PactError::InvalidRate.into());
    }

    // ---- config PDA identity + paused guard + mint snapshot ---------------
    let (expected_config_pda, _config_bump) = derive_protocol();
    if config_acct.address() != &expected_config_pda {
        return Err(ProgramError::InvalidSeeds);
    }
    let config_usdc_mint = {
        let config_data = config_acct.try_borrow()?;
        let cfg = ProtocolConfig::try_from_bytes(&config_data)?;
        if cfg.paused != 0 {
            return Err(PactError::ProtocolPaused.into());
        }
        cfg.usdc_mint
    };

    // ---- clock + expiry check ---------------------------------------------
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    if args.expires_at <= now {
        return Err(PactError::PolicyExpired.into());
    }

    // ---- pool: confirm usdc_mint (snapshot; drop borrow before CPI) -------
    let pool_usdc_mint = {
        let pool_data = pool_acct.try_borrow()?;
        let pool = CoveragePool::try_from_bytes(&pool_data)?;
        pool.usdc_mint
    };

    // ---- policy PDA derivation + empty guard ------------------------------
    //
    // Seed uses agent WALLET key, not agent_token_account.
    let (expected_policy_pda, policy_bump) =
        derive_policy(pool_acct.address(), agent_acct.address());
    if policy_acct.address() != &expected_policy_pda {
        return Err(ProgramError::InvalidSeeds);
    }
    if !policy_acct.is_data_empty() {
        return Err(ProgramError::AccountAlreadyInitialized);
    }

    // ---- SPL Token-account checks (spec §8.9 — hand-coded byte reads) -----
    {
        let ta_data = agent_ta_acct.try_borrow()?;
        let mint = token_account::read_mint(&ta_data)?;
        let owner = token_account::read_owner(&ta_data)?;
        let delegate = token_account::read_delegate(&ta_data)?;
        let delegated_amount = token_account::read_delegated_amount(&ta_data)?;

        // mint == pool.usdc_mint (equivalent to config.usdc_mint by
        // construction — the pool was bound to the config mint at create_pool).
        if mint != pool_usdc_mint.as_ref() {
            return Err(PactError::TokenAccountMismatch.into());
        }
        // Belt-and-suspenders: also assert pool.usdc_mint == config.usdc_mint.
        // `create_pool` enforces this, but if that invariant ever drifts,
        // surfacing it here prevents a compromised pool from accepting a
        // policy bound to a different mint.
        if pool_usdc_mint != config_usdc_mint {
            return Err(PactError::TokenAccountMismatch.into());
        }
        // owner == agent
        if owner != agent_acct.address().as_ref() {
            return Err(PactError::Unauthorized.into());
        }
        // delegate.is_some() && delegate == pool
        let delegate_bytes = delegate.ok_or(PactError::DelegationMissing)?;
        if delegate_bytes != pool_acct.address().as_ref() {
            return Err(PactError::DelegationMissing.into());
        }
        // delegated_amount > 0
        if delegated_amount == 0 {
            return Err(PactError::DelegationInsufficient.into());
        }
    }

    // ---- CPI: CreateAccount for the Policy PDA (owner = program) ----------
    let rent = Rent::get()?;
    let policy_lamports = rent.try_minimum_balance(Policy::LEN)?;
    let policy_bump_arr = [policy_bump];
    let pool_pda_bytes = pool_acct.address().as_ref();
    let agent_pda_bytes = agent_acct.address().as_ref();
    let policy_signer_seeds: [Seed; 4] = [
        Seed::from(POLICY_SEED_PREFIX),
        Seed::from(pool_pda_bytes),
        Seed::from(agent_pda_bytes),
        Seed::from(&policy_bump_arr[..]),
    ];
    create_account(
        agent_acct,
        policy_acct,
        policy_lamports,
        Policy::LEN as u64,
        &crate::ID,
        &policy_signer_seeds,
    )?;

    // ---- populate Policy ---------------------------------------------------
    let agent_ta_key = *agent_ta_acct.address();
    let agent_key = *agent_acct.address();
    let pool_key = *pool_acct.address();
    {
        let mut policy_data = policy_acct.try_borrow_mut()?;
        let bytes: &mut [u8] = &mut policy_data;
        if bytes.len() != Policy::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        // Set discriminator up-front so `try_from_bytes_mut` passes on the
        // zero-filled freshly-allocated buffer (same pattern as create_pool).
        bytes[0] = Policy::DISCRIMINATOR;
        let policy = Policy::try_from_bytes_mut(bytes)?;

        policy.discriminator = Policy::DISCRIMINATOR;
        policy.agent = agent_key;
        policy.pool = pool_key;
        policy.agent_token_account = agent_ta_key;

        // agent_id fixed buffer + length byte
        policy.agent_id = [0u8; 64];
        policy.agent_id[..args.agent_id_len].copy_from_slice(&args.agent_id_buf[..args.agent_id_len]);
        policy.agent_id_len = args.agent_id_len as u8;

        policy.total_premiums_paid = 0;
        policy.total_claims_received = 0;
        policy.calls_covered = 0;
        policy.created_at = now;
        policy.expires_at = args.expires_at;
        policy.active = 1;
        policy.bump = policy_bump;

        // Phase 5 F1 — snapshot referrer fields from args.
        policy.referrer = args.referrer;
        policy.referrer_share_bps = args.referrer_share_bps;
        policy.referrer_present = args.referrer_present;
        // `_pad_referrer` + `reserved` left zero (freshly-allocated buffer).
    }

    // ---- pool accumulators -------------------------------------------------
    {
        let mut pool_data = pool_acct.try_borrow_mut()?;
        let pool = CoveragePool::try_from_bytes_mut(&mut pool_data)?;
        pool.active_policies = pool
            .active_policies
            .checked_add(1)
            .ok_or(PactError::ArithmeticOverflow)?;
        pool.updated_at = now;
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Borsh-compatible arg decoder — `EnableInsuranceArgs` + Phase 5 F1 tail.
// ---------------------------------------------------------------------------

struct EnableInsuranceArgs {
    agent_id_buf: [u8; 64],
    agent_id_len: usize,
    expires_at: i64,
    // Phase 5 F1 referrer fields.
    referrer: [u8; 32],
    referrer_present: u8,
    referrer_share_bps: u16,
}

impl EnableInsuranceArgs {
    fn decode(mut data: &[u8]) -> Result<Self, ProgramError> {
        let id_bytes = read_string(&mut data)?;
        if id_bytes.len() > MAX_AGENT_ID_LEN {
            return Err(PactError::AgentIdTooLong.into());
        }
        let mut agent_id_buf = [0u8; 64];
        agent_id_buf[..id_bytes.len()].copy_from_slice(id_bytes);
        let agent_id_len = id_bytes.len();

        let expires_at = read_i64(&mut data)?;

        // ---- Phase 5 F1 tail ------------------------------------------------
        // 32 bytes referrer, 1 byte referrer_present, 2 bytes referrer_share_bps LE.
        let referrer_bytes = take(&mut data, 32)?;
        let mut referrer = [0u8; 32];
        referrer.copy_from_slice(referrer_bytes);

        let present_byte = take(&mut data, 1)?;
        let referrer_present = match present_byte[0] {
            0 | 1 => present_byte[0],
            _ => return Err(ProgramError::InvalidInstructionData),
        };

        let share_bytes = take(&mut data, 2)?;
        let referrer_share_bps = u16::from_le_bytes([share_bytes[0], share_bytes[1]]);

        if !data.is_empty() {
            return Err(ProgramError::InvalidInstructionData);
        }

        Ok(Self {
            agent_id_buf,
            agent_id_len,
            expires_at,
            referrer,
            referrer_present,
            referrer_share_bps,
        })
    }
}

#[inline]
fn take<'a>(data: &mut &'a [u8], n: usize) -> Result<&'a [u8], ProgramError> {
    if data.len() < n {
        return Err(ProgramError::InvalidInstructionData);
    }
    let (head, tail) = data.split_at(n);
    *data = tail;
    Ok(head)
}

fn read_string<'a>(data: &mut &'a [u8]) -> Result<&'a [u8], ProgramError> {
    let len_bytes = take(data, 4)?;
    let len = u32::from_le_bytes([len_bytes[0], len_bytes[1], len_bytes[2], len_bytes[3]]) as usize;
    take(data, len)
}

fn read_i64(data: &mut &[u8]) -> Result<i64, ProgramError> {
    let b = take(data, 8)?;
    let mut buf = [0u8; 8];
    buf.copy_from_slice(b);
    Ok(i64::from_le_bytes(buf))
}

// ---------------------------------------------------------------------------
// Host-side unit tests (decoder + F1 validation logic; CPI lives in TS tests).
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn encode_args(
        agent_id: &[u8],
        expires_at: i64,
        referrer: [u8; 32],
        referrer_present: u8,
        referrer_share_bps: u16,
    ) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&(agent_id.len() as u32).to_le_bytes());
        out.extend_from_slice(agent_id);
        out.extend_from_slice(&expires_at.to_le_bytes());
        out.extend_from_slice(&referrer);
        out.push(referrer_present);
        out.extend_from_slice(&referrer_share_bps.to_le_bytes());
        out
    }

    #[test]
    fn decode_happy_path_with_referrer() {
        let referrer = [0xAB; 32];
        let data = encode_args(b"agent-1", 1_700_000_000, referrer, 1, 1000);
        let args = EnableInsuranceArgs::decode(&data).unwrap();
        assert_eq!(args.agent_id_len, 7);
        assert_eq!(&args.agent_id_buf[..7], b"agent-1");
        assert_eq!(args.expires_at, 1_700_000_000);
        assert_eq!(args.referrer, referrer);
        assert_eq!(args.referrer_present, 1);
        assert_eq!(args.referrer_share_bps, 1000);
    }

    #[test]
    fn decode_happy_path_without_referrer() {
        let data = encode_args(b"agent-1", 1_700_000_000, [0u8; 32], 0, 0);
        let args = EnableInsuranceArgs::decode(&data).unwrap();
        assert_eq!(args.referrer_present, 0);
        assert_eq!(args.referrer_share_bps, 0);
        assert_eq!(args.referrer, [0u8; 32]);
    }

    #[test]
    fn decode_rejects_overlong_agent_id() {
        let long = vec![b'a'; MAX_AGENT_ID_LEN + 1];
        let data = encode_args(&long, 1, [0; 32], 0, 0);
        let err = match EnableInsuranceArgs::decode(&data) {
            Err(e) => e,
            Ok(_) => panic!("expected decode to fail"),
        };
        // AgentIdTooLong = 6016
        assert_eq!(err, ProgramError::Custom(6016));
    }

    #[test]
    fn decode_rejects_bad_present_byte() {
        let data = encode_args(b"id", 1, [0; 32], 2, 0);
        assert!(matches!(
            EnableInsuranceArgs::decode(&data),
            Err(ProgramError::InvalidInstructionData)
        ));
    }

    #[test]
    fn decode_rejects_trailing_bytes() {
        let mut data = encode_args(b"id", 1, [0; 32], 0, 0);
        data.push(0xFF);
        assert!(matches!(
            EnableInsuranceArgs::decode(&data),
            Err(ProgramError::InvalidInstructionData)
        ));
    }

    #[test]
    fn decode_rejects_truncated_tail() {
        // Valid agent_id + expires_at but missing the 32-byte referrer.
        let mut data = Vec::new();
        data.extend_from_slice(&2u32.to_le_bytes());
        data.extend_from_slice(b"id");
        data.extend_from_slice(&0i64.to_le_bytes());
        assert!(matches!(
            EnableInsuranceArgs::decode(&data),
            Err(ProgramError::InvalidInstructionData)
        ));
    }

    // ---- F1 validation logic (extracted so unit tests can exercise it) ----

    fn check_f1(present: u8, share_bps: u16) -> Result<(), ProgramError> {
        if share_bps > MAX_REFERRER_SHARE_BPS {
            return Err(PactError::RateOutOfBounds.into());
        }
        let present_flag = present != 0;
        let share_nonzero = share_bps != 0;
        if present_flag != share_nonzero {
            return Err(PactError::InvalidRate.into());
        }
        Ok(())
    }

    #[test]
    fn f1_accepts_none_zero() {
        check_f1(0, 0).unwrap();
    }

    #[test]
    fn f1_accepts_some_nonzero_within_cap() {
        check_f1(1, 1).unwrap();
        check_f1(1, MAX_REFERRER_SHARE_BPS).unwrap();
    }

    #[test]
    fn f1_rejects_share_above_cap_with_rate_out_of_bounds() {
        let err = check_f1(1, MAX_REFERRER_SHARE_BPS + 1).unwrap_err();
        assert_eq!(err, ProgramError::Custom(6027));
    }

    #[test]
    fn f1_rejects_present_with_zero_share_invalid_rate() {
        let err = check_f1(1, 0).unwrap_err();
        assert_eq!(err, ProgramError::Custom(6014));
    }

    #[test]
    fn f1_rejects_absent_with_nonzero_share_invalid_rate() {
        let err = check_f1(0, 100).unwrap_err();
        assert_eq!(err, ProgramError::Custom(6014));
    }
}
