//! `withdraw` (discriminator 8) — Pinocchio port.
//!
//! First **pool-PDA-signed** SPL-Token Transfer in the port. WP-9's `deposit`
//! CPI was user-signed; here the pool PDA is the token-account authority
//! (set at `create_pool` via `InitializeAccount3`), so the runtime must
//! synthesize the signature from `[b"pool", hostname, &[pool_bump]]`.
//!
//! Anchor source of truth: `packages/program/programs/pact-insurance/src/instructions/withdraw.rs`.
//!
//! Handler order (mirrors Anchor, with Pinocchio-specific guards up front):
//!   1. Validate account program IDs, writability, and signer flag.
//!   2. Decode `u64` amount; reject zero.
//!   3. Load config (read-only) and compute `effective_cooldown = max(cfg, 3600)`.
//!   4. Load position snapshot; verify `position.underwriter == signer`,
//!      `elapsed >= effective_cooldown`, `position.deposited >= amount`.
//!   5. Load pool snapshot; verify `pool.total_available >= amount`; capture
//!      `hostname_bytes` + `pool_bump` for signer-seed construction.
//!   6. Verify vault identity (`pool.vault == vault.address()`) and
//!      underwriter-token-account mint/owner.
//!   7. **Drop all data borrows** before the Transfer CPI (runtime forbids
//!      holding writable borrows across a CPI that touches the same
//!      accounts).
//!   8. Build pool signer seeds on the **stack** (spec §8.8 footgun): the
//!      `[&[&[u8]]]` slice passed to `invoke_signed` must reference data that
//!      outlives the syscall. A `.to_vec()` pattern (Anchor) would drop the
//!      heap buffer as soon as the slice was formed — use stack-local arrays.
//!   9. CPI `spl_token::Transfer` vault → underwriter_token_account signed by
//!      the pool PDA.
//!  10. Checked-sub the three counters (`position.deposited`,
//!      `pool.total_deposited`, `pool.total_available`). All three share the
//!      same failure mode (`ArithmeticOverflow`, 6023) mirroring Anchor's
//!      `ok_or(PactError::ArithmeticOverflow)` — even though we already
//!      gate on `>=`, the `checked_sub` is still the honest encoding.
//!  11. Set `pool.updated_at = now`.
//!
//! ### Alan's locked decisions (recap)
//! - **#3**: preserve error code numbering 6000..=6030 — this handler adds
//!   ZERO new variants. `WithdrawalUnderCooldown` (6009),
//!   `InsufficientPoolBalance` (6007), `WithdrawalWouldUnderfund` (6010),
//!   `Unauthorized` (6018), `ZeroAmount` (6020), `ArithmeticOverflow` (6023).
//! - **#5**: cooldown reset on every deposit — this handler READS
//!   `position.deposit_timestamp` but does NOT reset it; the freshness
//!   check against `effective_cooldown` is the only use.
//!
//! Wire format (after the 1-byte discriminator stripped by the entrypoint):
//!   offset 0..8   `amount: u64` LE
//!
//! Accounts (order matches the Anchor builder — `token_program` + `clock`
//! sysvar tail match the Codama-TS layout extended from WP-9):
//!   0. `config`                    — readonly, PDA `[b"protocol"]`
//!   1. `pool`                      — writable, PDA `[b"pool", hostname]`
//!   2. `vault`                     — writable, SPL-Token account owned by
//!                                     Token Program; authority = pool PDA
//!   3. `position`                  — writable, PDA
//!                                     `[b"position", pool, underwriter]`
//!   4. `underwriter_token_account` — writable, mint == config.usdc_mint,
//!                                     owner == underwriter
//!   5. `underwriter`               — signer (tx fee-payer; does NOT sign the
//!                                     Transfer CPI — the pool PDA does)
//!   6. `token_program`             — SPL Token Program
//!   7. `clock`                     — Clock sysvar placeholder (kept in the
//!                                     account list for wire compatibility;
//!                                     handler reads clock via `Clock::get()`)

use pinocchio::{
    account::AccountView,
    cpi::Seed,
    error::ProgramError,
    sysvars::{clock::Clock, Sysvar},
    ProgramResult,
};

use crate::{
    constants::ABSOLUTE_MIN_WITHDRAWAL_COOLDOWN,
    error::PactError,
    pda::{derive_position, POOL_SEED_PREFIX},
    state::{CoveragePool, ProtocolConfig, UnderwriterPosition},
    token::{transfer_pool_signed, SPL_TOKEN_PROGRAM_ID},
};

const ACCOUNT_COUNT: usize = 8;

/// Offsets into the 165-byte SPL `Account` state (same constants as WP-9
/// deposit). Mint bytes 0..32, owner bytes 32..64.
const TA_MINT_OFFSET: usize = 0;
const TA_OWNER_OFFSET: usize = 32;
const TA_ADDRESS_LEN: usize = 32;

pub fn process(accounts: &[AccountView], data: &[u8]) -> ProgramResult {
    if accounts.len() < ACCOUNT_COUNT {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let config_acct = &accounts[0];
    let pool_acct = &accounts[1];
    let vault_acct = &accounts[2];
    let position_acct = &accounts[3];
    let underwriter_ta_acct = &accounts[4];
    let underwriter_acct = &accounts[5];
    let token_program = &accounts[6];
    let _clock_sysvar = &accounts[7];

    // ---- program-id guard --------------------------------------------------
    if token_program.address() != &SPL_TOKEN_PROGRAM_ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    // ---- underwriter must sign --------------------------------------------
    if !underwriter_acct.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // ---- writability of mutated accounts ----------------------------------
    if !pool_acct.is_writable()
        || !vault_acct.is_writable()
        || !position_acct.is_writable()
        || !underwriter_ta_acct.is_writable()
    {
        return Err(ProgramError::InvalidAccountData);
    }

    // ---- ownership of data PDAs -------------------------------------------
    if !pool_acct.owned_by(&crate::ID) {
        return Err(PactError::Unauthorized.into());
    }
    if !position_acct.owned_by(&crate::ID) {
        return Err(PactError::Unauthorized.into());
    }
    if !underwriter_ta_acct.owned_by(&SPL_TOKEN_PROGRAM_ID) {
        return Err(PactError::TokenAccountMismatch.into());
    }

    // ---- parse args --------------------------------------------------------
    let amount = decode_amount(data)?;
    if amount == 0 {
        return Err(PactError::ZeroAmount.into());
    }

    // ---- load config: withdrawal_cooldown_seconds -------------------------
    let effective_cooldown = {
        let config_data = config_acct.try_borrow()?;
        let cfg = ProtocolConfig::try_from_bytes(&config_data)?;
        cfg.withdrawal_cooldown_seconds.max(ABSOLUTE_MIN_WITHDRAWAL_COOLDOWN)
    };

    // ---- clock snapshot (used for cooldown check + updated_at write) ------
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    // ---- load position: identity + cooldown + balance ---------------------
    let (expected_position_pda, _position_bump) =
        derive_position(pool_acct.address(), underwriter_acct.address());
    if position_acct.address() != &expected_position_pda {
        return Err(ProgramError::InvalidSeeds);
    }

    let (position_underwriter, position_deposited, position_deposit_ts) = {
        let position_data = position_acct.try_borrow()?;
        let position = UnderwriterPosition::try_from_bytes(&position_data)?;
        (position.underwriter, position.deposited, position.deposit_timestamp)
    };

    if position_underwriter != *underwriter_acct.address() {
        return Err(PactError::Unauthorized.into());
    }

    let elapsed = now
        .checked_sub(position_deposit_ts)
        .ok_or(PactError::ArithmeticOverflow)?;
    if elapsed < effective_cooldown {
        return Err(PactError::WithdrawalUnderCooldown.into());
    }
    if position_deposited < amount {
        return Err(PactError::InsufficientPoolBalance.into());
    }

    // ---- load pool: vault identity + underfund check + signer-seed source
    //
    // We need the hostname bytes and pool_bump as stack-owned storage for the
    // signer-seed slice (spec §8.8 footgun). Copy the fixed [u8; 64] buffer +
    // length byte + bump into this stack frame, then build the seed slice
    // against those locals. The `pool_data` borrow is dropped immediately
    // after snapshotting so the Transfer CPI can reborrow the vault account
    // (same Token-Program-owned account → borrow-tracking applies at the
    // account level).
    let pool_vault;
    let pool_usdc_mint;
    let pool_total_available;
    let pool_bump;
    let hostname_len;
    let mut hostname_buf = [0u8; 64];
    {
        let pool_data = pool_acct.try_borrow()?;
        let pool = CoveragePool::try_from_bytes(&pool_data)?;
        pool_vault = pool.vault;
        pool_usdc_mint = pool.usdc_mint;
        pool_total_available = pool.total_available;
        pool_bump = pool.bump;
        hostname_len = core::cmp::min(
            pool.provider_hostname_len as usize,
            pool.provider_hostname.len(),
        );
        hostname_buf[..hostname_len].copy_from_slice(&pool.provider_hostname[..hostname_len]);
    }

    if pool_total_available < amount {
        return Err(PactError::WithdrawalWouldUnderfund.into());
    }

    // Vault identity — `pool.vault` was pinned to the derived PDA at
    // `create_pool` time; equality check here is equivalent to re-deriving
    // `[b"vault", pool]` but costs nothing at runtime.
    if vault_acct.address() != &pool_vault {
        return Err(PactError::TokenAccountMismatch.into());
    }

    // Underwriter TA: mint + owner.
    {
        let ta_data = underwriter_ta_acct.try_borrow()?;
        if ta_data.len() < TA_OWNER_OFFSET + TA_ADDRESS_LEN {
            return Err(PactError::TokenAccountMismatch.into());
        }
        let mint_bytes = &ta_data[TA_MINT_OFFSET..TA_MINT_OFFSET + TA_ADDRESS_LEN];
        let owner_bytes = &ta_data[TA_OWNER_OFFSET..TA_OWNER_OFFSET + TA_ADDRESS_LEN];
        if mint_bytes != pool_usdc_mint.as_ref() {
            return Err(PactError::TokenAccountMismatch.into());
        }
        if owner_bytes != underwriter_acct.address().as_ref() {
            return Err(PactError::TokenAccountMismatch.into());
        }
    }

    // ---- pool-PDA-signed Transfer CPI --------------------------------------
    //
    // All three seed components are stack-local: the bump byte array, the
    // hostname prefix slice into `hostname_buf`, and the literal
    // `POOL_SEED_PREFIX`. The `Seed`/`Signer` shapes are Pinocchio 0.10's
    // `From<&[Seed]>`-friendly builders — same shape used by
    // `src/system.rs::create_account` for PDA-signed CreateAccount.
    let pool_bump_arr = [pool_bump];
    let hostname_bytes = &hostname_buf[..hostname_len];
    let signer_seeds: [Seed; 3] = [
        Seed::from(POOL_SEED_PREFIX),
        Seed::from(hostname_bytes),
        Seed::from(&pool_bump_arr[..]),
    ];

    transfer_pool_signed(
        vault_acct,
        underwriter_ta_acct,
        pool_acct,
        amount,
        &signer_seeds,
    )?;

    // ---- checked-sub on accumulators + updated_at -------------------------
    //
    // We already gated `position.deposited >= amount` and
    // `pool.total_available >= amount`, so the subtractions cannot underflow
    // under honest inputs. The `checked_sub`s are kept to mirror Anchor
    // (defensive belt-and-suspenders: protects against a future reordering
    // where the ge-checks drift).
    {
        let mut position_data = position_acct.try_borrow_mut()?;
        let position = UnderwriterPosition::try_from_bytes_mut(&mut position_data)?;
        position.deposited = position
            .deposited
            .checked_sub(amount)
            .ok_or(PactError::ArithmeticOverflow)?;
    }
    {
        let mut pool_data = pool_acct.try_borrow_mut()?;
        let pool = CoveragePool::try_from_bytes_mut(&mut pool_data)?;
        pool.total_deposited = pool
            .total_deposited
            .checked_sub(amount)
            .ok_or(PactError::ArithmeticOverflow)?;
        pool.total_available = pool
            .total_available
            .checked_sub(amount)
            .ok_or(PactError::ArithmeticOverflow)?;
        pool.updated_at = now;
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Arg decoder
// ---------------------------------------------------------------------------

#[inline]
fn decode_amount(data: &[u8]) -> Result<u64, ProgramError> {
    if data.len() != 8 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let mut buf = [0u8; 8];
    buf.copy_from_slice(&data[..8]);
    Ok(u64::from_le_bytes(buf))
}

// ---------------------------------------------------------------------------
// Host-side unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_amount_reads_u64_le() {
        let bytes = 42_u64.to_le_bytes();
        assert_eq!(decode_amount(&bytes).unwrap(), 42);
    }

    #[test]
    fn decode_amount_rejects_wrong_length() {
        assert!(matches!(
            decode_amount(&[0u8; 7]),
            Err(ProgramError::InvalidInstructionData)
        ));
        assert!(matches!(
            decode_amount(&[0u8; 9]),
            Err(ProgramError::InvalidInstructionData)
        ));
    }

    /// Cooldown-gate semantics: Anchor clamps the configured cooldown to the
    /// absolute floor of 3600s. This test simulates the floor-clamp that the
    /// handler runs before comparing `elapsed`.
    #[test]
    fn cooldown_floor_clamps_to_absolute_min() {
        let cfg_cooldown = 100_i64; // below the 3600 floor
        let effective = cfg_cooldown.max(ABSOLUTE_MIN_WITHDRAWAL_COOLDOWN);
        assert_eq!(effective, ABSOLUTE_MIN_WITHDRAWAL_COOLDOWN);
    }

    /// Cooldown check itself: elapsed < effective rejects.
    #[test]
    fn cooldown_rejects_when_not_elapsed() {
        let now = 10_000_i64;
        let deposit_ts = 10_000_i64 - (ABSOLUTE_MIN_WITHDRAWAL_COOLDOWN - 1);
        let elapsed = now.checked_sub(deposit_ts).unwrap();
        assert!(elapsed < ABSOLUTE_MIN_WITHDRAWAL_COOLDOWN);
    }

    #[test]
    fn cooldown_passes_at_exact_boundary() {
        let now = 10_000_i64;
        let deposit_ts = 10_000_i64 - ABSOLUTE_MIN_WITHDRAWAL_COOLDOWN;
        let elapsed = now.checked_sub(deposit_ts).unwrap();
        assert!(elapsed >= ABSOLUTE_MIN_WITHDRAWAL_COOLDOWN);
    }

    /// Balance check semantics: `position.deposited >= amount` must reject
    /// with InsufficientPoolBalance (6007) when the position has less.
    #[test]
    fn insufficient_position_balance_error_is_6007() {
        let err: ProgramError = PactError::InsufficientPoolBalance.into();
        assert_eq!(err, ProgramError::Custom(6007));
    }

    #[test]
    fn withdrawal_would_underfund_error_is_6010() {
        let err: ProgramError = PactError::WithdrawalWouldUnderfund.into();
        assert_eq!(err, ProgramError::Custom(6010));
    }

    #[test]
    fn withdrawal_under_cooldown_error_is_6009() {
        let err: ProgramError = PactError::WithdrawalUnderCooldown.into();
        assert_eq!(err, ProgramError::Custom(6009));
    }
}
