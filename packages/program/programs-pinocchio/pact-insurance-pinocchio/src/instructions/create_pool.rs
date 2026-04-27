//! `create_pool` (discriminator 3) — Pinocchio port.
//!
//! First instruction in the port that touches SPL-Token. Three CPIs:
//!   1. System `CreateAccount` for the pool PDA (owner = our program ID).
//!   2. System `CreateAccount` for the vault PDA with **owner = spl_token::ID**
//!      — spec §8.7 footgun (easy to forget; subsequent Transfer CPIs would
//!      fail with `IllegalOwner` if this is wrong).
//!   3. SPL-Token `InitializeAccount3` to bind `vault.mint = usdc_mint` and
//!      `vault.authority = pool_pda`. `InitializeAccount3` reads the owner
//!      from the instruction payload, so no signer seeds are needed here.
//!
//! Alan's locked mint-bug fix (spec §8.2, port-plan constraint #4):
//! The Anchor source does NOT assert `pool_usdc_mint == config.usdc_mint`,
//! so a compromised `authority` could create a pool for an arbitrary mint.
//! The port tightens this — rejecting with `PactError::Unauthorized` (6018)
//! when the mints disagree. We reuse `Unauthorized` rather than mint a new
//! error variant because Alan's decision #3 preserves the 6000..=6030 range.
//!
//! Wire format (after the 1-byte discriminator stripped by the entrypoint)
//! mirrors the Anchor `CreatePoolArgs` Borsh layout, so client builders can
//! use standard encoders:
//!   offset 0..4           provider_hostname length (`u32` LE, Borsh `String`)
//!   offset 4..4+len       provider_hostname bytes (UTF-8)
//!   then  +1              `insurance_rate_bps` Option tag (0 = None, 1 = Some)
//!       +2 if Some        `insurance_rate_bps` u16 LE
//!   then  +1              `max_coverage_per_call` Option tag
//!       +8 if Some        `max_coverage_per_call` u64 LE
//!
//! Accounts (order matches the Anchor builder):
//!   0. `config`             — readonly, PDA `[b"protocol"]`
//!   1. `pool`               — writable, PDA `[b"pool", hostname_bytes]`, created here
//!   2. `vault`              — writable, PDA `[b"vault", pool_pda]`, created here
//!   3. `pool_usdc_mint`     — readonly, must equal `config.usdc_mint` (the mint fix)
//!   4. `authority`          — writable signer (pays rent; must match `config.authority`)
//!   5. `system_program`     — `11111111111111111111111111111111`
//!   6. `token_program`      — SPL Token Program
//!   7. `rent`               — rent sysvar (unused by the handler — Clock replaces its role —
//!                             but kept in the account list for wire compatibility with
//!                             the existing Anchor test fixtures)

use pinocchio::{
    account::AccountView,
    cpi::Seed,
    error::ProgramError,
    sysvars::{clock::Clock, rent::Rent, Sysvar},
    ProgramResult,
};

use crate::{
    error::PactError,
    pda::{derive_pool, derive_protocol, derive_vault, POOL_SEED_PREFIX, VAULT_SEED_PREFIX},
    state::{CoveragePool, ProtocolConfig},
    system::{create_account, SYSTEM_PROGRAM_ID},
    token::{initialize_account3, SPL_TOKEN_ACCOUNT_LEN, SPL_TOKEN_PROGRAM_ID},
};

const ACCOUNT_COUNT: usize = 8;

/// Hostname on-disk buffer is `[u8; 64]` (WP-3 Alan-locked decision). Reject
/// anything that would overflow it. Keeping the check tied to the buffer
/// size (not the Anchor 128-byte ceiling) is the honest invariant — if the
/// buffer ever grows to 128 this constant follows.
const MAX_HOSTNAME_ON_DISK: usize = 64;

pub fn process(accounts: &[AccountView], data: &[u8]) -> ProgramResult {
    if accounts.len() < ACCOUNT_COUNT {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let config_acct = &accounts[0];
    let pool_acct = &accounts[1];
    let vault_acct = &accounts[2];
    let pool_usdc_mint = &accounts[3];
    let authority_acct = &accounts[4];
    let system_program = &accounts[5];
    let token_program = &accounts[6];
    let _rent_sysvar = &accounts[7];

    // ---- program-id guards -------------------------------------------------
    if system_program.address() != &SYSTEM_PROGRAM_ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    if token_program.address() != &SPL_TOKEN_PROGRAM_ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    // ---- authority must sign + be writable (pays rent) --------------------
    if !authority_acct.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !authority_acct.is_writable() {
        return Err(ProgramError::InvalidAccountData);
    }

    // ---- pool / vault must be writable PDAs --------------------------------
    if !pool_acct.is_writable() || !vault_acct.is_writable() {
        return Err(ProgramError::InvalidAccountData);
    }

    // ---- parse args first so a malformed payload aborts before any rent is
    // ---- debited ----------------------------------------------------------
    let args = CreatePoolArgs::decode(data)?;

    if args.hostname_len == 0 || args.hostname_len > MAX_HOSTNAME_ON_DISK {
        return Err(PactError::HostnameTooLong.into());
    }
    let hostname_bytes = &args.hostname_buf[..args.hostname_len];

    // ---- config PDA identity ----------------------------------------------
    let (expected_config_pda, _config_bump) = derive_protocol();
    if config_acct.address() != &expected_config_pda {
        return Err(ProgramError::InvalidSeeds);
    }

    // ---- load config (discriminator + length check via try_from_bytes) ----
    let config_data = config_acct.try_borrow()?;
    let cfg = ProtocolConfig::try_from_bytes(&config_data)?;

    // `!config.paused`
    if cfg.paused != 0 {
        return Err(PactError::ProtocolPaused.into());
    }
    // `has_one = authority`
    if authority_acct.address() != &cfg.authority {
        return Err(PactError::Unauthorized.into());
    }

    // Alan's locked mint-bug fix — spec §8.2.
    // Anchor's `create_pool.rs` NEVER checked this, letting a compromised
    // authority bind a pool to an arbitrary mint. Adding it here is the whole
    // point of this WP being "high-attention".
    if pool_usdc_mint.address() != &cfg.usdc_mint {
        return Err(PactError::Unauthorized.into());
    }

    // Snapshot the defaults before we drop the borrow — they're needed below
    // and borrowing `config_data` for the whole handler blocks the CreateAccount
    // CPI which expects no outstanding data borrows on the config account.
    let config_authority = cfg.authority;
    let config_usdc_mint = cfg.usdc_mint;
    let default_rate_bps = cfg.default_insurance_rate_bps;
    let min_premium_bps = cfg.min_premium_bps;
    let default_max_coverage = cfg.default_max_coverage_per_call;
    drop(config_data);

    // ---- PDA derivations ---------------------------------------------------
    let (expected_pool_pda, pool_bump) = derive_pool(hostname_bytes);
    if pool_acct.address() != &expected_pool_pda {
        return Err(ProgramError::InvalidSeeds);
    }
    if !pool_acct.is_data_empty() {
        return Err(ProgramError::AccountAlreadyInitialized);
    }

    let (expected_vault_pda, vault_bump) = derive_vault(&expected_pool_pda);
    if vault_acct.address() != &expected_vault_pda {
        return Err(ProgramError::InvalidSeeds);
    }
    if !vault_acct.is_data_empty() {
        return Err(ProgramError::AccountAlreadyInitialized);
    }

    // ---- CPI 1: CreateAccount for pool PDA (owner = program) --------------
    let rent = Rent::get()?;
    let pool_lamports = rent.try_minimum_balance(CoveragePool::LEN)?;
    let pool_bump_arr = [pool_bump];
    let pool_signer_seeds: [Seed; 3] = [
        Seed::from(POOL_SEED_PREFIX),
        Seed::from(hostname_bytes),
        Seed::from(&pool_bump_arr[..]),
    ];
    create_account(
        authority_acct,
        pool_acct,
        pool_lamports,
        CoveragePool::LEN as u64,
        &crate::ID,
        &pool_signer_seeds,
    )?;

    // ---- CPI 2: CreateAccount for vault PDA (owner = spl_token::ID) -------
    // Spec §8.7: this is the easy-to-forget footgun. Owner MUST be the Token
    // Program so the subsequent InitializeAccount3 writes valid token-account
    // state and downstream Transfer CPIs authored by the pool PDA see an
    // account owned by spl_token::ID.
    let vault_lamports = rent.try_minimum_balance(SPL_TOKEN_ACCOUNT_LEN as usize)?;
    let vault_bump_arr = [vault_bump];
    let pool_pda_bytes = expected_pool_pda.as_ref();
    let vault_signer_seeds: [Seed; 3] = [
        Seed::from(VAULT_SEED_PREFIX),
        Seed::from(pool_pda_bytes),
        Seed::from(&vault_bump_arr[..]),
    ];
    create_account(
        authority_acct,
        vault_acct,
        vault_lamports,
        SPL_TOKEN_ACCOUNT_LEN,
        &SPL_TOKEN_PROGRAM_ID,
        &vault_signer_seeds,
    )?;

    // ---- CPI 3: SPL-Token InitializeAccount3 (vault.mint, vault.owner) ----
    // `owner` is the pool PDA — this is what makes the pool the authority
    // of all Transfer CPIs against the vault.
    initialize_account3(vault_acct, pool_usdc_mint, &expected_pool_pda)?;

    // ---- populate CoveragePool --------------------------------------------
    //
    // Newly-allocated; zero-filled by the runtime — only write domain fields
    // and the discriminator.
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    let mut pool_data = pool_acct.try_borrow_mut()?;
    let bytes: &mut [u8] = &mut pool_data;
    if bytes.len() != CoveragePool::LEN {
        return Err(ProgramError::InvalidAccountData);
    }
    // Set the discriminator byte up-front so `try_from_bytes_mut`'s
    // disc-guard succeeds on the freshly-allocated (zero-filled) buffer.
    bytes[0] = CoveragePool::DISCRIMINATOR;
    let pool = CoveragePool::try_from_bytes_mut(bytes)?;

    pool.discriminator = CoveragePool::DISCRIMINATOR;
    pool.authority = config_authority;
    pool.usdc_mint = config_usdc_mint;
    pool.vault = expected_vault_pda;

    pool.provider_hostname = args.hostname_buf;
    pool.provider_hostname_len = args.hostname_len as u8;

    pool.total_deposited = 0;
    pool.total_available = 0;
    pool.total_premiums_earned = 0;
    pool.total_claims_paid = 0;
    pool.payouts_this_window = 0;

    pool.insurance_rate_bps = args.insurance_rate_bps.unwrap_or(default_rate_bps);
    pool.min_premium_bps = min_premium_bps;
    pool.max_coverage_per_call = args.max_coverage_per_call.unwrap_or(default_max_coverage);

    pool.active_policies = 0;
    pool.window_start = now;
    pool.created_at = now;
    pool.updated_at = now;

    pool.bump = pool_bump;
    // Stash vault_bump in the trailing padding byte allocation — WP-8 scope
    // said "store so downstream handlers don't re-derive." The struct has a
    // 6-byte `_pad_tail` after `bump`; reuse the first byte of it. We can't
    // add a named field without breaking the WP-3 layout invariants pinned
    // by `coverage_pool_size_has_no_hidden_padding` and the offset_of assert.
    //
    // Concretely: `_pad_tail[0]` becomes the vault bump. All readers that
    // need it reach for `pool._pad_tail[0]`. When WP-9 (withdraw) adds the
    // real accessor, this stays byte-for-byte identical.
    pool._pad_tail[0] = vault_bump;

    Ok(())
}

// ---------------------------------------------------------------------------
// Borsh-compatible arg decoder
// ---------------------------------------------------------------------------

struct CreatePoolArgs {
    /// Fixed-size on-disk representation of `provider_hostname`. Only the
    /// first `hostname_len` bytes are valid; the remainder is zeroed.
    hostname_buf: [u8; 64],
    hostname_len: usize,
    insurance_rate_bps: Option<u16>,
    max_coverage_per_call: Option<u64>,
}

impl CreatePoolArgs {
    /// Decode the Anchor-Borsh wire format.
    ///
    /// Borsh `String` = 4-byte u32 LE length + UTF-8 bytes.
    /// Borsh `Option<T>` = 1-byte tag (0 = None, 1 = Some) + T if Some.
    fn decode(mut data: &[u8]) -> Result<Self, ProgramError> {
        let hostname_bytes = read_string(&mut data)?;
        // Reject the runtime length here rather than silently truncating —
        // HostnameTooLong (6015) is the existing variant for this shape.
        if hostname_bytes.len() > 64 {
            return Err(PactError::HostnameTooLong.into());
        }
        let mut hostname_buf = [0u8; 64];
        hostname_buf[..hostname_bytes.len()].copy_from_slice(hostname_bytes);

        let insurance_rate_bps = decode_opt_u16(&mut data)?;
        let max_coverage_per_call = decode_opt_u64(&mut data)?;

        if !data.is_empty() {
            return Err(ProgramError::InvalidInstructionData);
        }

        Ok(Self {
            hostname_buf,
            hostname_len: hostname_bytes.len(),
            insurance_rate_bps,
            max_coverage_per_call,
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

fn read_tag(data: &mut &[u8]) -> Result<u8, ProgramError> {
    let head = take(data, 1)?;
    match head[0] {
        0 | 1 => Ok(head[0]),
        _ => Err(ProgramError::InvalidInstructionData),
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

// ---------------------------------------------------------------------------
// Tests (host-only — no CPI exercise here; that lives in tests-pinocchio).
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn encode_borsh_string(bytes: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(4 + bytes.len());
        out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
        out.extend_from_slice(bytes);
        out
    }

    #[test]
    fn decode_all_options_none() {
        let mut data = encode_borsh_string(b"api.openai.com");
        data.push(0); // insurance_rate_bps = None
        data.push(0); // max_coverage_per_call = None

        let args = CreatePoolArgs::decode(&data).unwrap();
        assert_eq!(args.hostname_len, 14);
        assert_eq!(&args.hostname_buf[..14], b"api.openai.com");
        assert_eq!(args.insurance_rate_bps, None);
        assert_eq!(args.max_coverage_per_call, None);
    }

    #[test]
    fn decode_all_options_some() {
        let mut data = encode_borsh_string(b"api.helius.xyz");
        data.push(1); // Some
        data.extend_from_slice(&50u16.to_le_bytes());
        data.push(1); // Some
        data.extend_from_slice(&2_000_000u64.to_le_bytes());

        let args = CreatePoolArgs::decode(&data).unwrap();
        assert_eq!(args.hostname_len, 14);
        assert_eq!(args.insurance_rate_bps, Some(50));
        assert_eq!(args.max_coverage_per_call, Some(2_000_000));
    }

    #[test]
    fn decode_rejects_overlong_hostname() {
        let long = vec![b'a'; 65];
        let mut data = encode_borsh_string(&long);
        data.push(0);
        data.push(0);
        let err = CreatePoolArgs::decode(&data).err().expect("must reject");
        // PactError::HostnameTooLong → custom 6015.
        assert_eq!(err, ProgramError::Custom(6015));
    }

    #[test]
    fn decode_rejects_trailing_bytes() {
        let mut data = encode_borsh_string(b"ok");
        data.push(0);
        data.push(0);
        data.push(0xFF); // stray byte
        assert!(matches!(
            CreatePoolArgs::decode(&data),
            Err(ProgramError::InvalidInstructionData)
        ));
    }

    #[test]
    fn decode_rejects_bad_option_tag() {
        let mut data = encode_borsh_string(b"ok");
        data.push(2); // invalid
        let err = CreatePoolArgs::decode(&data).err().expect("must reject");
        assert!(matches!(err, ProgramError::InvalidInstructionData));
    }
}
