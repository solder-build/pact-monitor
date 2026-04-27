//! `update_config` (discriminator 1) — Pinocchio port.
//!
//! Mutates the singleton `ProtocolConfig` PDA in place. Each of the 13 fields
//! is individually optional; the instruction payload is the Borsh wire format
//! of `UpdateConfigArgs` (one `Option<T>` per field, encoded as a 1-byte tag
//! followed by the payload when Some).
//!
//! Encoding chosen: **manual slicing, Borsh-compatible**. Each `Option<T>` is
//! a 1-byte tag (`0 = None`, `1 = Some`) followed by the payload for `Some`.
//! Matching Borsh avoids pulling the `borsh` crate into the SBF build (≈5 KiB
//! of code-size tax), while still letting the TS client encode args with a
//! stock Codama/Kit option encoder. The layout exactly matches the Anchor
//! `UpdateConfigArgs` Borsh format (same field order, same underlying ints),
//! so the WP-17 cut-over keeps the IDL stable.
//!
//! Accounts (order matches the Anchor builder):
//!   0. `config`    — writable, PDA `[b"protocol"]` (loaded, not created)
//!   1. `authority` — signer (must match `config.authority`)
//!
//! Validation ordering is: structural (account count / signer / writable /
//! PDA-ness) → state (discriminator via `try_from_bytes_mut`) → authority →
//! per-field decode + safety-floor / freeze checks → mutation.
//!
//! Frozen fields (`treasury`, `usdc_mint`) always reject `Some(_)` even when
//! the new value equals the stored one — matches Anchor source H-03.

use pinocchio::{account::AccountView, error::ProgramError, ProgramResult};
use solana_address::Address;

use crate::{
    constants::{
        ABSOLUTE_MAX_AGGREGATE_CAP_BPS, ABSOLUTE_MAX_PROTOCOL_FEE_BPS, ABSOLUTE_MIN_CLAIM_WINDOW,
        ABSOLUTE_MIN_POOL_DEPOSIT, ABSOLUTE_MIN_WITHDRAWAL_COOLDOWN,
    },
    error::PactError,
    pda::derive_protocol,
    state::ProtocolConfig,
};

const ACCOUNT_COUNT: usize = 2;

pub fn process(accounts: &[AccountView], data: &[u8]) -> ProgramResult {
    if accounts.len() < ACCOUNT_COUNT {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let config = &accounts[0];
    let authority = &accounts[1];

    // ---- structural guards --------------------------------------------------
    if !config.is_writable() {
        return Err(ProgramError::InvalidAccountData);
    }
    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Ownership/identity: the PDA MUST be the canonical one.
    let (expected_pda, _bump) = derive_protocol();
    if config.address() != &expected_pda {
        return Err(ProgramError::InvalidSeeds);
    }

    // ---- decode payload into typed patch -----------------------------------
    //
    // Done *before* touching account data so malformed instructions fail fast
    // without leaving the PDA half-written.
    let patch = UpdateConfigPatch::decode(data)?;

    // Freeze checks — these apply regardless of authority (cheap guard, matches
    // Anchor which `require!`s after the per-field mutations but before Ok).
    // Checking them up-front also ensures a non-authority cannot trigger an
    // accidental treasury/usdc_mint write via a partially-decoded payload.
    if patch.treasury.is_some() || patch.usdc_mint.is_some() {
        return Err(PactError::FrozenConfigField.into());
    }

    // ---- load + authority check --------------------------------------------
    let mut data_ref = config.try_borrow_mut()?;
    let bytes: &mut [u8] = &mut data_ref;
    let cfg = ProtocolConfig::try_from_bytes_mut(bytes)?;

    if authority.address() != &cfg.authority {
        return Err(PactError::Unauthorized.into());
    }

    // ---- per-field safety-floor checks + mutation --------------------------
    //
    // Anchor source ordering preserved. Only fields with a safety floor/cap
    // get a `require!`; the rest are free-form writes. `paused` is `bool` on
    // the Anchor side, `u8` here — we accept only 0 or 1 on decode.

    if let Some(v) = patch.protocol_fee_bps {
        if v > ABSOLUTE_MAX_PROTOCOL_FEE_BPS {
            return Err(PactError::ConfigSafetyFloorViolation.into());
        }
        cfg.protocol_fee_bps = v;
    }

    if let Some(v) = patch.min_pool_deposit {
        if v < ABSOLUTE_MIN_POOL_DEPOSIT {
            return Err(PactError::ConfigSafetyFloorViolation.into());
        }
        cfg.min_pool_deposit = v;
    }

    if let Some(v) = patch.default_insurance_rate_bps {
        cfg.default_insurance_rate_bps = v;
    }

    if let Some(v) = patch.default_max_coverage_per_call {
        cfg.default_max_coverage_per_call = v;
    }

    if let Some(v) = patch.min_premium_bps {
        cfg.min_premium_bps = v;
    }

    if let Some(v) = patch.withdrawal_cooldown_seconds {
        if v < ABSOLUTE_MIN_WITHDRAWAL_COOLDOWN {
            return Err(PactError::ConfigSafetyFloorViolation.into());
        }
        cfg.withdrawal_cooldown_seconds = v;
    }

    if let Some(v) = patch.aggregate_cap_bps {
        if v > ABSOLUTE_MAX_AGGREGATE_CAP_BPS {
            return Err(PactError::ConfigSafetyFloorViolation.into());
        }
        cfg.aggregate_cap_bps = v;
    }

    if let Some(v) = patch.aggregate_cap_window_seconds {
        cfg.aggregate_cap_window_seconds = v;
    }

    if let Some(v) = patch.claim_window_seconds {
        if v < ABSOLUTE_MIN_CLAIM_WINDOW {
            return Err(PactError::ConfigSafetyFloorViolation.into());
        }
        cfg.claim_window_seconds = v;
    }

    if let Some(v) = patch.max_claims_per_batch {
        cfg.max_claims_per_batch = v;
    }

    if let Some(v) = patch.paused {
        cfg.paused = v;
    }

    Ok(())
}

/// Decoded `UpdateConfigArgs`. Field order matches the Anchor Borsh layout.
struct UpdateConfigPatch {
    protocol_fee_bps: Option<u16>,
    min_pool_deposit: Option<u64>,
    default_insurance_rate_bps: Option<u16>,
    default_max_coverage_per_call: Option<u64>,
    min_premium_bps: Option<u16>,
    withdrawal_cooldown_seconds: Option<i64>,
    aggregate_cap_bps: Option<u16>,
    aggregate_cap_window_seconds: Option<i64>,
    claim_window_seconds: Option<i64>,
    max_claims_per_batch: Option<u8>,
    /// Stored as `u8` on-chain; accepted values are 0 or 1.
    paused: Option<u8>,
    treasury: Option<Address>,
    usdc_mint: Option<Address>,
}

impl UpdateConfigPatch {
    /// Decode the Borsh wire format. Every `Option<T>` is 1 byte of tag then
    /// the payload for `Some`.
    fn decode(mut data: &[u8]) -> Result<Self, ProgramError> {
        let protocol_fee_bps = decode_opt_u16(&mut data)?;
        let min_pool_deposit = decode_opt_u64(&mut data)?;
        let default_insurance_rate_bps = decode_opt_u16(&mut data)?;
        let default_max_coverage_per_call = decode_opt_u64(&mut data)?;
        let min_premium_bps = decode_opt_u16(&mut data)?;
        let withdrawal_cooldown_seconds = decode_opt_i64(&mut data)?;
        let aggregate_cap_bps = decode_opt_u16(&mut data)?;
        let aggregate_cap_window_seconds = decode_opt_i64(&mut data)?;
        let claim_window_seconds = decode_opt_i64(&mut data)?;
        let max_claims_per_batch = decode_opt_u8(&mut data)?;
        let paused = decode_opt_bool(&mut data)?;
        let treasury = decode_opt_address(&mut data)?;
        let usdc_mint = decode_opt_address(&mut data)?;

        if !data.is_empty() {
            return Err(ProgramError::InvalidInstructionData);
        }

        Ok(Self {
            protocol_fee_bps,
            min_pool_deposit,
            default_insurance_rate_bps,
            default_max_coverage_per_call,
            min_premium_bps,
            withdrawal_cooldown_seconds,
            aggregate_cap_bps,
            aggregate_cap_window_seconds,
            claim_window_seconds,
            max_claims_per_batch,
            paused,
            treasury,
            usdc_mint,
        })
    }
}

// ---------------------------------------------------------------------------
// Borsh-style option decoders (zero-dep, little-endian ints)
// ---------------------------------------------------------------------------

#[inline]
fn take<'a>(data: &mut &'a [u8], n: usize) -> Result<&'a [u8], ProgramError> {
    if data.len() < n {
        return Err(ProgramError::InvalidInstructionData);
    }
    let (head, tail) = data.split_at(n);
    *data = tail;
    Ok(head)
}

#[inline]
fn read_tag(data: &mut &[u8]) -> Result<u8, ProgramError> {
    let head = take(data, 1)?;
    match head[0] {
        0 | 1 => Ok(head[0]),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

fn decode_opt_u8(data: &mut &[u8]) -> Result<Option<u8>, ProgramError> {
    match read_tag(data)? {
        0 => Ok(None),
        _ => {
            let b = take(data, 1)?;
            Ok(Some(b[0]))
        }
    }
}

fn decode_opt_u16(data: &mut &[u8]) -> Result<Option<u16>, ProgramError> {
    match read_tag(data)? {
        0 => Ok(None),
        _ => {
            let b = take(data, 2)?;
            Ok(Some(u16::from_le_bytes([b[0], b[1]])))
        }
    }
}

fn decode_opt_u64(data: &mut &[u8]) -> Result<Option<u64>, ProgramError> {
    match read_tag(data)? {
        0 => Ok(None),
        _ => {
            let b = take(data, 8)?;
            let mut buf = [0u8; 8];
            buf.copy_from_slice(b);
            Ok(Some(u64::from_le_bytes(buf)))
        }
    }
}

fn decode_opt_i64(data: &mut &[u8]) -> Result<Option<i64>, ProgramError> {
    match read_tag(data)? {
        0 => Ok(None),
        _ => {
            let b = take(data, 8)?;
            let mut buf = [0u8; 8];
            buf.copy_from_slice(b);
            Ok(Some(i64::from_le_bytes(buf)))
        }
    }
}

fn decode_opt_bool(data: &mut &[u8]) -> Result<Option<u8>, ProgramError> {
    match read_tag(data)? {
        0 => Ok(None),
        _ => {
            let b = take(data, 1)?;
            match b[0] {
                0 | 1 => Ok(Some(b[0])),
                _ => Err(ProgramError::InvalidInstructionData),
            }
        }
    }
}

fn decode_opt_address(data: &mut &[u8]) -> Result<Option<Address>, ProgramError> {
    match read_tag(data)? {
        0 => Ok(None),
        _ => {
            let b = take(data, 32)?;
            let mut buf = [0u8; 32];
            buf.copy_from_slice(b);
            Ok(Some(Address::new_from_array(buf)))
        }
    }
}
