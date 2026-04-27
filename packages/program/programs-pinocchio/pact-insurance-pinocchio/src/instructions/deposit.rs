//! `deposit` (discriminator 4) — Pinocchio port.
//!
//! First user-signed SPL-Token Transfer in the port + first `init_if_needed`
//! branch.
//!
//! Two-branch handling (spec §8.6 footgun — Anchor's `init_if_needed` is one
//! attribute; Pinocchio requires us to distinguish init from re-open manually):
//!   * **Init path** (`position.is_data_empty()`): System `CreateAccount` for
//!     the position PDA owned by our program, then write discriminator +
//!     identity fields + zeroed counters.
//!   * **Re-open path**: verify `owner() == program_id` and discriminator via
//!     `try_from_bytes_mut`; **PRESERVE all existing counters** — only the
//!     accumulators below are updated.
//!
//! Both branches then:
//!   1. Checked-add `amount` onto `position.deposited`, `pool.total_deposited`,
//!      `pool.total_available`. Overflow returns `PactError::ArithmeticOverflow`.
//!   2. CPI `spl_token::Transfer` from `underwriter_token_account` → `vault`
//!      with the underwriter as authority (user-signed; NOT PDA-signed —
//!      no signer seeds).
//!   3. Reset `position.deposit_timestamp = clock.unix_timestamp`.
//!
//! ### Alan's locked decision #5 — cooldown-reset-on-every-deposit
//! The Anchor source (`packages/program/programs/pact-insurance/src/instructions/deposit.rs:92`)
//! resets `deposit_timestamp` on *every* deposit including re-opens. This is
//! intentional — it restarts the withdrawal cooldown even for previously
//! vested funds. **Preserve exactly.** Do not conditionally skip the reset
//! on the re-open branch. See spec §8.3.
//!
//! ### Vault bump note
//! `CoveragePool._pad_tail[0]` holds `vault_bump` (WP-8 addendum #16). This
//! handler does NOT need it — the token Transfer here is user-signed
//! (the underwriter), not PDA-signed, so no signer-seeds are synthesized.
//! WP-10 (withdraw), WP-14 (settle_premium), WP-15 (submit_claim) are the
//! handlers that will read `_pad_tail[0]`.
//!
//! Wire format (after the 1-byte discriminator is stripped by the entrypoint):
//!   offset 0..8   `amount: u64` LE
//!
//! Accounts (order matches the Anchor builder, extended with rent & clock
//! sysvar placeholders to match the `packages/insurance` Codama-TS layout):
//!   0. `config`                    — readonly, PDA `[b"protocol"]`
//!   1. `pool`                      — writable, PDA `[b"pool", hostname]`
//!   2. `vault`                     — writable, SPL-Token account owned by
//!                                     Token Program; authority = pool PDA
//!   3. `position`                  — writable, PDA
//!                                     `[b"position", pool, underwriter]`
//!   4. `underwriter_token_account` — writable, mint == config.usdc_mint,
//!                                     owner == underwriter
//!   5. `underwriter`               — writable signer (pays rent for init)
//!   6. `token_program`             — SPL Token Program
//!   7. `system_program`            — `11111111111111111111111111111111`

use pinocchio::{
    account::AccountView,
    cpi::Seed,
    error::ProgramError,
    sysvars::{clock::Clock, rent::Rent, Sysvar},
    ProgramResult,
};

use crate::{
    error::PactError,
    pda::{derive_position, POSITION_SEED_PREFIX},
    state::{CoveragePool, ProtocolConfig, UnderwriterPosition},
    system::{create_account, SYSTEM_PROGRAM_ID},
    token::{transfer_user_signed, SPL_TOKEN_PROGRAM_ID},
};

const ACCOUNT_COUNT: usize = 8;

/// Offsets into the 165-byte SPL `Account` state. Matches the layout
/// documented in `src/token.rs` (mint 0..32, owner 32..64).
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
    let system_program = &accounts[7];

    // ---- program-id guards -------------------------------------------------
    if token_program.address() != &SPL_TOKEN_PROGRAM_ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    if system_program.address() != &SYSTEM_PROGRAM_ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    // ---- underwriter must sign + be writable (fee payer + init payer) -----
    if !underwriter_acct.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !underwriter_acct.is_writable() {
        return Err(ProgramError::InvalidAccountData);
    }

    // ---- writability of mutated accounts ----------------------------------
    if !pool_acct.is_writable()
        || !vault_acct.is_writable()
        || !position_acct.is_writable()
        || !underwriter_ta_acct.is_writable()
    {
        return Err(ProgramError::InvalidAccountData);
    }

    // ---- parse args --------------------------------------------------------
    let amount = decode_amount(data)?;

    // ---- config: paused flag + min_pool_deposit ---------------------------
    let config_data = config_acct.try_borrow()?;
    let cfg = ProtocolConfig::try_from_bytes(&config_data)?;
    if cfg.paused != 0 {
        return Err(PactError::ProtocolPaused.into());
    }
    if amount == 0 {
        return Err(PactError::ZeroAmount.into());
    }
    if amount < cfg.min_pool_deposit {
        return Err(PactError::BelowMinimumDeposit.into());
    }
    drop(config_data);

    // ---- load pool: verify usdc_mint + capture hostname ------------------
    // Snapshot identity fields we need after we drop the borrow so the
    // subsequent writable borrow (for counter updates) can succeed.
    let pool_data = pool_acct.try_borrow()?;
    let pool_snap = CoveragePool::try_from_bytes(&pool_data)?;
    let pool_usdc_mint = pool_snap.usdc_mint;
    let pool_vault = pool_snap.vault;
    drop(pool_data);

    // Vault identity — the Anchor source uses a `seeds=[b"vault", pool]`
    // PDA constraint. We verify via `pool.vault == vault.address()` which is
    // equivalent (pool.vault was pinned to the derived PDA at create_pool).
    if vault_acct.address() != &pool_vault {
        return Err(PactError::TokenAccountMismatch.into());
    }

    // ---- underwriter_token_account: mint + owner equality -----------------
    // Layout: mint bytes 0..32, owner bytes 32..64. We avoid the full
    // token-account helper (lands in WP-12) — just read the two address
    // fields this handler needs. Any account that isn't a valid SPL
    // `Account` (wrong length, wrong program owner) is rejected.
    if !underwriter_ta_acct.owned_by(&SPL_TOKEN_PROGRAM_ID) {
        return Err(PactError::TokenAccountMismatch.into());
    }
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

    // ---- position PDA identity -------------------------------------------
    let (expected_position_pda, position_bump) =
        derive_position(pool_acct.address(), underwriter_acct.address());
    if position_acct.address() != &expected_position_pda {
        return Err(ProgramError::InvalidSeeds);
    }

    // ---- branch: init vs re-open ------------------------------------------
    let is_init = position_acct.is_data_empty();
    if is_init {
        let rent = Rent::get()?;
        let lamports = rent.try_minimum_balance(UnderwriterPosition::LEN)?;
        let bump_arr = [position_bump];
        let pool_addr_bytes = pool_acct.address().as_ref();
        let uw_addr_bytes = underwriter_acct.address().as_ref();
        let seeds: [Seed; 4] = [
            Seed::from(POSITION_SEED_PREFIX),
            Seed::from(pool_addr_bytes),
            Seed::from(uw_addr_bytes),
            Seed::from(&bump_arr[..]),
        ];
        create_account(
            underwriter_acct,
            position_acct,
            lamports,
            UnderwriterPosition::LEN as u64,
            &crate::ID,
            &seeds,
        )?;

        // Zero-fill + initial identity. CreateAccount returns zero-filled
        // data, so we only set the discriminator byte + identity + bump.
        let mut position_data = position_acct.try_borrow_mut()?;
        let bytes: &mut [u8] = &mut position_data;
        if bytes.len() != UnderwriterPosition::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        bytes[0] = UnderwriterPosition::DISCRIMINATOR;
        let position = UnderwriterPosition::try_from_bytes_mut(bytes)?;
        position.discriminator = UnderwriterPosition::DISCRIMINATOR;
        position.pool = *pool_acct.address();
        position.underwriter = *underwriter_acct.address();
        position.deposited = 0;
        position.earned_premiums = 0;
        position.losses_absorbed = 0;
        position.deposit_timestamp = 0;
        position.last_claim_timestamp = 0;
        position.bump = position_bump;
    } else {
        // Re-open path — verify the existing account belongs to us. A
        // malicious caller could not forge this anyway (the PDA check above
        // already pins identity) but the explicit owner gate follows the
        // WP-9 port-plan guidance and costs nothing.
        if !position_acct.owned_by(&crate::ID) {
            return Err(PactError::Unauthorized.into());
        }
        // Discriminator is validated inside `try_from_bytes_mut` when we
        // load the position below for counter updates. Nothing further to
        // do here — counters must be PRESERVED.
    }

    // ---- checked-add on accumulators --------------------------------------
    //
    // Load mutable views for pool + position. Order: release `position_data`
    // before `pool_data`'s borrow overlaps, and release both before the
    // Transfer CPI (the runtime disallows holding writable borrows across
    // a CPI that touches the same accounts).
    {
        let mut position_data = position_acct.try_borrow_mut()?;
        let position = UnderwriterPosition::try_from_bytes_mut(&mut position_data)?;
        position.deposited = position
            .deposited
            .checked_add(amount)
            .ok_or(PactError::ArithmeticOverflow)?;
    }
    {
        let mut pool_data = pool_acct.try_borrow_mut()?;
        let pool = CoveragePool::try_from_bytes_mut(&mut pool_data)?;
        pool.total_deposited = pool
            .total_deposited
            .checked_add(amount)
            .ok_or(PactError::ArithmeticOverflow)?;
        pool.total_available = pool
            .total_available
            .checked_add(amount)
            .ok_or(PactError::ArithmeticOverflow)?;
    }

    // ---- SPL-Token Transfer: underwriter_ta → vault (user-signed) --------
    transfer_user_signed(
        underwriter_ta_acct,
        vault_acct,
        underwriter_acct,
        amount,
    )?;

    // ---- cooldown reset + updated_at (Alan locked decision #5) -----------
    //
    // Preserve EXACTLY the Anchor behavior: reset `deposit_timestamp` on
    // every deposit including re-opens. This intentionally restarts the
    // withdrawal cooldown on top-ups (Anchor source
    // `packages/program/programs/pact-insurance/src/instructions/deposit.rs:92`).
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    {
        let mut position_data = position_acct.try_borrow_mut()?;
        let position = UnderwriterPosition::try_from_bytes_mut(&mut position_data)?;
        position.deposit_timestamp = now;
    }
    {
        let mut pool_data = pool_acct.try_borrow_mut()?;
        let pool = CoveragePool::try_from_bytes_mut(&mut pool_data)?;
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
// Host-side unit tests (no SVM — on-chain flows live in tests-pinocchio).
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::UnderwriterPosition;
    use bytemuck::Zeroable;

    #[test]
    fn decode_amount_reads_u64_le() {
        let bytes = 12_345_678_u64.to_le_bytes();
        assert_eq!(decode_amount(&bytes).unwrap(), 12_345_678);
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

    /// Simulates the in-handler re-open branch's counter preservation.
    /// Mirrors the sequence the handler runs when `position` is NOT empty:
    /// we do NOT re-zero fields — only accumulate.
    #[test]
    fn reopen_branch_preserves_counters_across_two_deposits() {
        let mut position = UnderwriterPosition::zeroed();
        position.discriminator = UnderwriterPosition::DISCRIMINATOR;
        position.deposited = 100;
        position.earned_premiums = 7;
        position.losses_absorbed = 3;
        position.last_claim_timestamp = 99;
        position.deposit_timestamp = 42;

        // Two additional deposits.
        let delta_a: u64 = 50;
        let delta_b: u64 = 25;

        // Handler does: position.deposited = position.deposited.checked_add(delta)?;
        position.deposited = position.deposited.checked_add(delta_a).unwrap();
        position.deposit_timestamp = 100; // handler resets every deposit

        position.deposited = position.deposited.checked_add(delta_b).unwrap();
        position.deposit_timestamp = 200;

        // Sums, not overwrites.
        assert_eq!(position.deposited, 100 + delta_a + delta_b);
        // Unrelated counters must be untouched.
        assert_eq!(position.earned_premiums, 7);
        assert_eq!(position.losses_absorbed, 3);
        assert_eq!(position.last_claim_timestamp, 99);
        // Cooldown resets on every deposit (Alan's locked decision #5).
        assert_eq!(position.deposit_timestamp, 200);
    }

    #[test]
    fn checked_add_overflow_returns_arithmetic_overflow_variant() {
        // Drive the same branch the handler uses.
        let current = u64::MAX - 5;
        let attempt = 10u64;
        let err: Result<u64, ProgramError> = current
            .checked_add(attempt)
            .ok_or(PactError::ArithmeticOverflow.into());
        match err {
            Err(ProgramError::Custom(c)) => assert_eq!(c, 6023, "ArithmeticOverflow = 6023"),
            other => panic!("expected Custom(6023), got {:?}", other),
        }
    }
}
