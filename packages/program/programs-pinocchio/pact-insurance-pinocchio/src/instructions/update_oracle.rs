//! `update_oracle` (discriminator 2) — Pinocchio port.
//!
//! Rotates the `config.oracle` pubkey on the singleton `ProtocolConfig` PDA.
//! The oracle/authority split exists specifically to enforce C-02: only a
//! dedicated oracle signer may submit claims, and only the authority may
//! rotate that oracle. Conflating the two pubkeys — either by passing the
//! zero address or by pointing oracle back at authority — would collapse the
//! split, so both shapes are rejected with `PactError::InvalidOracleKey`
//! (matches Anchor source exactly).
//!
//! Accounts (order matches the Anchor builder):
//!   0. `config`    — writable, PDA `[b"protocol"]` (loaded, not created)
//!   1. `authority` — signer (must match `config.authority`)
//!
//! Instruction payload: raw 32-byte `Address` (no Option wrapper, no length
//! prefix). This matches the Anchor `UpdateOracle { new_oracle: Pubkey }`
//! Borsh layout bit-for-bit, so the TS client is a trivial `new_oracle.bytes`
//! concat after the 1-byte discriminator.
//!
//! Validation ordering: structural (account count / signer / writable / PDA)
//! → decode new_oracle → authority check → oracle invariants → mutation.

use pinocchio::{account::AccountView, error::ProgramError, ProgramResult};
use solana_address::Address;

use crate::{error::PactError, pda::derive_protocol, state::ProtocolConfig};

const ACCOUNT_COUNT: usize = 2;
const NEW_ORACLE_LEN: usize = 32;

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

    let (expected_pda, _bump) = derive_protocol();
    if config.address() != &expected_pda {
        return Err(ProgramError::InvalidSeeds);
    }

    // ---- decode new_oracle (raw 32 bytes, no tag) --------------------------
    if data.len() != NEW_ORACLE_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }
    let mut buf = [0u8; NEW_ORACLE_LEN];
    buf.copy_from_slice(data);
    let new_oracle = Address::new_from_array(buf);

    // Zero-pubkey collapses the split — reject before touching account data.
    // Anchor source uses PactError::InvalidOracleKey for both zero and
    // oracle==authority cases; WP-2 locks in zero new variants, so we reuse.
    if new_oracle == Address::default() {
        return Err(PactError::InvalidOracleKey.into());
    }

    // ---- load + authority check --------------------------------------------
    let mut data_ref = config.try_borrow_mut()?;
    let bytes: &mut [u8] = &mut data_ref;
    let cfg = ProtocolConfig::try_from_bytes_mut(bytes)?;

    if authority.address() != &cfg.authority {
        return Err(PactError::Unauthorized.into());
    }

    // oracle == authority also collapses the split.
    if new_oracle == cfg.authority {
        return Err(PactError::InvalidOracleKey.into());
    }

    cfg.oracle = new_oracle;
    Ok(())
}
