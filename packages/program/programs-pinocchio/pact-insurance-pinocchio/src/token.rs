//! Hand-rolled SPL-Token CPI helpers.
//!
//! We avoid the `pinocchio-token` crate for the same reason `pinocchio-system`
//! is absent (WP-1 post-mortem #2, WP-5 addendum #10): `pinocchio-token`'s
//! published versions depend on pinocchio 0.9 / 0.11, never 0.10 which is our
//! pin. The SPL-Token instruction layout we need (`InitializeAccount3`) is
//! stable, so encoding it directly is smaller than chasing a compatible fork.
//!
//! WP-8 added `InitializeAccount3` for the vault binding; WP-9 extends with
//! `Transfer` (discriminant byte 3) to move USDC from a user-signed source
//! token account into the pool vault on `deposit`. Same encoding strategy —
//! a few bytes of instruction data and three account metas — so we stay
//! inside the zero-dep posture.

use pinocchio::{
    account::AccountView,
    cpi::{invoke, invoke_signed, Seed, Signer},
    instruction::{InstructionAccount, InstructionView},
    ProgramResult,
};
use solana_address::Address;

/// SPL Token Program ID (`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`).
pub const SPL_TOKEN_PROGRAM_ID: Address =
    Address::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

/// On-chain size of an SPL-Token `Account`. The Token Program's `Account`
/// state is a fixed 165 bytes (mint 32 + owner 32 + amount 8 + delegate 36 +
/// state 1 + is_native 12 + delegated_amount 8 + close_authority 36).
pub const SPL_TOKEN_ACCOUNT_LEN: u64 = 165;

/// SPL-Token `InitializeAccount3` instruction discriminant. Mirrors the
/// `TokenInstruction::InitializeAccount3 { owner }` variant in
/// `spl-token`'s `instruction.rs` — historically index 18 (0x12).
const INITIALIZE_ACCOUNT3_DISC: u8 = 18;

/// Encoded payload length: 1-byte disc + 32-byte owner pubkey.
const INITIALIZE_ACCOUNT3_DATA_LEN: usize = 1 + 32;

/// CPI into SPL-Token `InitializeAccount3`.
///
/// Binds `account.mint = mint` and `account.owner = owner` on an already-
/// allocated token-account buffer. The account must have been allocated
/// by the System Program with `owner = spl_token::ID` and `space = 165`
/// immediately prior — `create_pool` does this one step up the stack.
///
/// `InitializeAccount3` does not require the account-owner to sign (that's
/// the whole point of the `3` variant vs. the original `InitializeAccount`).
/// The owner is set purely from the instruction payload, so a plain `invoke`
/// without signer seeds is correct.
#[inline]
pub fn initialize_account3(
    account: &AccountView,
    mint: &AccountView,
    owner: &Address,
) -> ProgramResult {
    let mut data = [0u8; INITIALIZE_ACCOUNT3_DATA_LEN];
    data[0] = INITIALIZE_ACCOUNT3_DISC;
    data[1..33].copy_from_slice(owner.as_ref());

    let accounts = [
        InstructionAccount::new(account.address(), true, false),
        InstructionAccount::new(mint.address(), false, false),
    ];

    let instruction = InstructionView {
        program_id: &SPL_TOKEN_PROGRAM_ID,
        accounts: &accounts,
        data: &data,
    };

    invoke::<2>(&instruction, &[account, mint])
}

// ---------------------------------------------------------------------------
// SPL-Token `Transfer` (discriminant 3)
// ---------------------------------------------------------------------------

/// Discriminant of `TokenInstruction::Transfer { amount }`. Historically the
/// third variant of the `spl-token` enum — byte `0x03`.
const TRANSFER_DISC: u8 = 3;

/// Encoded payload length: 1-byte disc + u64 LE amount.
const TRANSFER_DATA_LEN: usize = 1 + 8;

/// CPI into SPL-Token `Transfer`, user-authority variant.
///
/// Moves `amount` base units from `source` to `destination`. `authority` must
/// be a `Signer` on the outer transaction (the user underwriter for WP-9's
/// `deposit` flow). No signer seeds — the authority signs the caller tx, not
/// a PDA.
#[inline]
pub fn transfer_user_signed(
    source: &AccountView,
    destination: &AccountView,
    authority: &AccountView,
    amount: u64,
) -> ProgramResult {
    let mut data = [0u8; TRANSFER_DATA_LEN];
    data[0] = TRANSFER_DISC;
    data[1..9].copy_from_slice(&amount.to_le_bytes());

    let accounts = [
        InstructionAccount::new(source.address(), true, false),
        InstructionAccount::new(destination.address(), true, false),
        InstructionAccount::new(authority.address(), false, true),
    ];

    let instruction = InstructionView {
        program_id: &SPL_TOKEN_PROGRAM_ID,
        accounts: &accounts,
        data: &data,
    };

    invoke::<3>(&instruction, &[source, destination, authority])
}

/// CPI into SPL-Token `Transfer`, PDA-authority variant.
///
/// Identical on-wire encoding as [`transfer_user_signed`] (disc byte 3 + u64
/// LE amount) — only the CPI-invocation flavour differs. Used by WP-10
/// `withdraw` (and WP-14 / WP-15 in the future) where the pool PDA is the
/// token-account authority. `signer_seeds` must be the stack-local seed slice
/// that derives `authority.address()` from `crate::ID`; spec §8.8 footgun
/// about borrow lifetimes applies — build the `[Seed; N]` in the caller's
/// handler scope, not from `.to_vec()`.
#[inline]
pub fn transfer_pool_signed(
    source: &AccountView,
    destination: &AccountView,
    authority: &AccountView,
    amount: u64,
    signer_seeds: &[Seed],
) -> ProgramResult {
    let mut data = [0u8; TRANSFER_DATA_LEN];
    data[0] = TRANSFER_DISC;
    data[1..9].copy_from_slice(&amount.to_le_bytes());

    let accounts = [
        InstructionAccount::new(source.address(), true, false),
        InstructionAccount::new(destination.address(), true, false),
        InstructionAccount::new(authority.address(), false, true),
    ];

    let instruction = InstructionView {
        program_id: &SPL_TOKEN_PROGRAM_ID,
        accounts: &accounts,
        data: &data,
    };

    let signer = Signer::from(signer_seeds);
    invoke_signed::<3>(&instruction, &[source, destination, authority], &[signer])
}
