//! Hand-coded SPL-Token `Account` byte-slice readers.
//!
//! Spec §8.9 / risk-register #9: the SBF build can't afford the `spl-token`
//! crate (≈many KiB of Borsh + program-error graph) just to read four fields
//! from a 165-byte account. The on-disk layout of `spl_token::state::Account`
//! is stable and publicly documented — we hand-code the offsets here.
//!
//! Token Account layout (165 bytes total):
//! ```text
//!   0..32     mint:              Pubkey
//!  32..64     owner:             Pubkey
//!  64..72     amount:            u64 LE
//!  72..76     delegate disc:     u32 LE  (0 = None, 1 = Some)
//!  76..108    delegate:          Pubkey  (valid iff disc == 1)
//! 108..109    state:             u8      (0=Uninit, 1=Initialized, 2=Frozen)
//! 109..113    is_native disc:    u32 LE
//! 113..121    is_native.rent_exempt_reserve: u64 LE (valid iff is_native disc == 1)
//! 121..129    delegated_amount:  u64 LE  (valid iff delegate disc == 1)
//! 129..133    close_authority disc: u32 LE
//! 133..165    close_authority:   Pubkey
//! ```
//!
//! The `delegated_amount` slot is authoritative regardless of the delegate
//! discriminant — the Token Program zeroes it when `delegate == None`. We
//! still expose `read_delegate` that honours the discriminant so callers
//! distinguish "no delegate" from "delegate == all zeros".
//!
//! No `spl-token` dep. All functions verify `data.len() >= 165` and return
//! `ProgramError::InvalidAccountData` on short buffers.

use pinocchio::error::ProgramError;

/// Size of an SPL-Token `Account` state on-disk.
pub const SPL_TOKEN_ACCOUNT_SIZE: usize = 165;

// ---- field offsets ----------------------------------------------------------
const MINT_OFFSET: usize = 0;
const OWNER_OFFSET: usize = 32;
const AMOUNT_OFFSET: usize = 64;
const DELEGATE_DISC_OFFSET: usize = 72;
const DELEGATE_OFFSET: usize = 76;
const DELEGATED_AMOUNT_OFFSET: usize = 121;

// ---- common-case length guard ----------------------------------------------
#[inline]
fn guard_len(data: &[u8]) -> Result<(), ProgramError> {
    if data.len() < SPL_TOKEN_ACCOUNT_SIZE {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(())
}

/// Read `mint` (bytes 0..32). Returns a fixed-size reference — callers compare
/// against `config.usdc_mint.as_ref()` or `pool.usdc_mint.as_ref()`.
#[inline]
pub fn read_mint(data: &[u8]) -> Result<&[u8; 32], ProgramError> {
    guard_len(data)?;
    let slice = &data[MINT_OFFSET..MINT_OFFSET + 32];
    <&[u8; 32]>::try_from(slice).map_err(|_| ProgramError::InvalidAccountData)
}

/// Read `owner` (bytes 32..64).
#[inline]
pub fn read_owner(data: &[u8]) -> Result<&[u8; 32], ProgramError> {
    guard_len(data)?;
    let slice = &data[OWNER_OFFSET..OWNER_OFFSET + 32];
    <&[u8; 32]>::try_from(slice).map_err(|_| ProgramError::InvalidAccountData)
}

/// Read `amount` (bytes 64..72 LE).
#[inline]
pub fn read_amount(data: &[u8]) -> Result<u64, ProgramError> {
    guard_len(data)?;
    let mut buf = [0u8; 8];
    buf.copy_from_slice(&data[AMOUNT_OFFSET..AMOUNT_OFFSET + 8]);
    Ok(u64::from_le_bytes(buf))
}

/// Read the `delegate` field honouring the 4-byte Option discriminator at
/// bytes 72..76. Returns `Ok(None)` for disc 0, `Ok(Some(pubkey))` for disc 1,
/// and `Err(InvalidAccountData)` for any other disc value.
#[inline]
pub fn read_delegate(data: &[u8]) -> Result<Option<&[u8; 32]>, ProgramError> {
    guard_len(data)?;
    let disc_bytes = &data[DELEGATE_DISC_OFFSET..DELEGATE_DISC_OFFSET + 4];
    let disc = u32::from_le_bytes([disc_bytes[0], disc_bytes[1], disc_bytes[2], disc_bytes[3]]);
    match disc {
        0 => Ok(None),
        1 => {
            let slice = &data[DELEGATE_OFFSET..DELEGATE_OFFSET + 32];
            let arr = <&[u8; 32]>::try_from(slice)
                .map_err(|_| ProgramError::InvalidAccountData)?;
            Ok(Some(arr))
        }
        _ => Err(ProgramError::InvalidAccountData),
    }
}

/// Read `delegated_amount` (bytes 121..129 LE). The Token Program zeroes this
/// slot when the delegate is cleared, so callers can treat `0` as "no
/// effective delegation" without consulting the delegate discriminant.
#[inline]
pub fn read_delegated_amount(data: &[u8]) -> Result<u64, ProgramError> {
    guard_len(data)?;
    let mut buf = [0u8; 8];
    buf.copy_from_slice(&data[DELEGATED_AMOUNT_OFFSET..DELEGATED_AMOUNT_OFFSET + 8]);
    Ok(u64::from_le_bytes(buf))
}

// ---------------------------------------------------------------------------
// Tests — hand-construct 165-byte buffers matching the spl-token on-disk shape.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a 165-byte buffer shaped like a real SPL Token account.
    fn make_account(
        mint: [u8; 32],
        owner: [u8; 32],
        amount: u64,
        delegate: Option<[u8; 32]>,
        delegated_amount: u64,
    ) -> [u8; SPL_TOKEN_ACCOUNT_SIZE] {
        let mut buf = [0u8; SPL_TOKEN_ACCOUNT_SIZE];
        buf[MINT_OFFSET..MINT_OFFSET + 32].copy_from_slice(&mint);
        buf[OWNER_OFFSET..OWNER_OFFSET + 32].copy_from_slice(&owner);
        buf[AMOUNT_OFFSET..AMOUNT_OFFSET + 8].copy_from_slice(&amount.to_le_bytes());
        match delegate {
            None => {
                buf[DELEGATE_DISC_OFFSET..DELEGATE_DISC_OFFSET + 4].copy_from_slice(&0u32.to_le_bytes());
            }
            Some(d) => {
                buf[DELEGATE_DISC_OFFSET..DELEGATE_DISC_OFFSET + 4].copy_from_slice(&1u32.to_le_bytes());
                buf[DELEGATE_OFFSET..DELEGATE_OFFSET + 32].copy_from_slice(&d);
            }
        }
        buf[DELEGATED_AMOUNT_OFFSET..DELEGATED_AMOUNT_OFFSET + 8]
            .copy_from_slice(&delegated_amount.to_le_bytes());
        buf
    }

    #[test]
    fn reads_mint_and_owner() {
        let mint = [0x11; 32];
        let owner = [0x22; 32];
        let data = make_account(mint, owner, 0, None, 0);
        assert_eq!(read_mint(&data).unwrap(), &mint);
        assert_eq!(read_owner(&data).unwrap(), &owner);
    }

    #[test]
    fn reads_amount_and_delegated_amount_le() {
        let data = make_account([0; 32], [0; 32], 0xDEAD_BEEF, None, 0xCAFEBABE);
        assert_eq!(read_amount(&data).unwrap(), 0xDEAD_BEEF);
        assert_eq!(read_delegated_amount(&data).unwrap(), 0xCAFEBABE);
    }

    #[test]
    fn read_delegate_some() {
        let delegate = [0x33; 32];
        let data = make_account([0; 32], [0; 32], 0, Some(delegate), 500);
        let got = read_delegate(&data).unwrap();
        assert_eq!(got, Some(&delegate));
    }

    #[test]
    fn read_delegate_none() {
        let data = make_account([0; 32], [0; 32], 0, None, 0);
        assert_eq!(read_delegate(&data).unwrap(), None);
    }

    #[test]
    fn read_delegate_rejects_bad_disc() {
        let mut data = make_account([0; 32], [0; 32], 0, None, 0);
        // Overwrite disc with an invalid value.
        data[DELEGATE_DISC_OFFSET..DELEGATE_DISC_OFFSET + 4].copy_from_slice(&2u32.to_le_bytes());
        assert!(matches!(
            read_delegate(&data),
            Err(ProgramError::InvalidAccountData)
        ));
    }

    #[test]
    fn rejects_short_buffer() {
        let short = [0u8; 164];
        assert!(matches!(read_mint(&short), Err(ProgramError::InvalidAccountData)));
        assert!(matches!(read_owner(&short), Err(ProgramError::InvalidAccountData)));
        assert!(matches!(read_amount(&short), Err(ProgramError::InvalidAccountData)));
        assert!(matches!(read_delegate(&short), Err(ProgramError::InvalidAccountData)));
        assert!(matches!(
            read_delegated_amount(&short),
            Err(ProgramError::InvalidAccountData)
        ));
    }

    #[test]
    fn accepts_buffer_at_exact_size() {
        let data = [0u8; SPL_TOKEN_ACCOUNT_SIZE];
        // All-zero buffer: mint/owner zero, disc 0 (None), amounts zero.
        assert_eq!(read_mint(&data).unwrap(), &[0u8; 32]);
        assert_eq!(read_owner(&data).unwrap(), &[0u8; 32]);
        assert_eq!(read_amount(&data).unwrap(), 0);
        assert_eq!(read_delegate(&data).unwrap(), None);
        assert_eq!(read_delegated_amount(&data).unwrap(), 0);
    }

    #[test]
    fn accepts_buffer_longer_than_min() {
        // Real token accounts are exactly 165 bytes, but defensive readers
        // should still work on larger buffers (future-proof). Use 200 bytes.
        let mut big = vec![0u8; 200];
        big[AMOUNT_OFFSET..AMOUNT_OFFSET + 8].copy_from_slice(&42u64.to_le_bytes());
        assert_eq!(read_amount(&big).unwrap(), 42);
    }
}
