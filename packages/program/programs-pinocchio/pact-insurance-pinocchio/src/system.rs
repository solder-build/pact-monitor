//! Hand-rolled System Program CPI helpers.
//!
//! We avoid the `pinocchio-system` crate: version 0.4 depends on pinocchio 0.9
//! and version 0.6 depends on pinocchio 0.11 — neither lines up with our
//! pinned `pinocchio = "0.10"` (WP-1 post-mortem #2). The CreateAccount
//! instruction layout is stable across every System Program version, so a
//! direct encoding is both smaller and safer than chasing version drift.

use pinocchio::{
    account::AccountView,
    cpi::{invoke_signed, Seed, Signer},
    instruction::{InstructionAccount, InstructionView},
    ProgramResult,
};
use solana_address::Address;

/// System Program ID (`11111111111111111111111111111111`). All 32 bytes zero.
pub const SYSTEM_PROGRAM_ID: Address = Address::new_from_array([0u8; 32]);

/// Encoded length of a System Program `CreateAccount` instruction payload:
/// 4-byte discriminant (`0u32` LE) + u64 lamports + u64 space + 32-byte owner.
const CREATE_ACCOUNT_DATA_LEN: usize = 4 + 8 + 8 + 32;

/// CPI into the System Program's `CreateAccount` instruction.
///
/// The `from` account pays `lamports` and the `to` account is resized to
/// `space` bytes and assigned to `owner`. Both accounts must be writable; `to`
/// must be a signer — for PDA creations, the caller passes the PDA's
/// `[seed..., bump]` signer-seeds here so the runtime synthesizes the
/// signature.
#[inline]
pub fn create_account(
    from: &AccountView,
    to: &AccountView,
    lamports: u64,
    space: u64,
    owner: &Address,
    signer_seeds: &[Seed],
) -> ProgramResult {
    let mut data = [0u8; CREATE_ACCOUNT_DATA_LEN];
    // SystemInstruction::CreateAccount = 0
    data[0..4].copy_from_slice(&0u32.to_le_bytes());
    data[4..12].copy_from_slice(&lamports.to_le_bytes());
    data[12..20].copy_from_slice(&space.to_le_bytes());
    data[20..52].copy_from_slice(owner.as_ref());

    let accounts = [
        InstructionAccount::new(from.address(), true, true),
        InstructionAccount::new(to.address(), true, true),
    ];

    let instruction = InstructionView {
        program_id: &SYSTEM_PROGRAM_ID,
        accounts: &accounts,
        data: &data,
    };

    let signer = Signer::from(signer_seeds);
    invoke_signed::<2>(&instruction, &[from, to], &[signer])
}
