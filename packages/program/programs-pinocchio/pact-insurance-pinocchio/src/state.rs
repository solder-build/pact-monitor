//! Zero-copy account layouts for the Pinocchio port.
//!
//! Every struct begins with a 1-byte `discriminator` and 7 bytes of explicit
//! padding so the first domain field lands at byte offset **8**. This matches
//! the SDK's `memcmp(offset: 8)` invariant (see `docs/pinocchio-migration-spec.md`
//! §7.2) that is relied on by `listPolicies` / `listPools` queries.
//!
//! Layouts are `#[repr(C)]` with fields ordered so that `repr(C)` natural
//! alignment produces zero implicit padding holes — a requirement for
//! `bytemuck::Pod`. Trailing `_pad_tail` arrays round each struct to a
//! multiple of 8 bytes.
//!
//! String-typed Anchor fields (`provider_hostname`, `agent_id`) are serialized
//! as a fixed `[u8; 64]` buffer plus a `u8` length byte (Alan's locked
//! decision for WP-3). `call_id` in `Claim` is stored as a `[u8; 32]` — the
//! pre-hashed SHA-256 digest used for claim PDA derivation (WP-4 addendum #9).
//!
//! Helpers (`try_from_bytes`, `try_from_bytes_mut`) only validate length and
//! discriminator. Owner checks belong at the `AccountView` layer in
//! instruction handlers; this module is purely byte-level.
//!
//! Every struct ends with `reserved: [u8; 64]` — Rick-approved project-wide
//! convention (Q3 confirmed 2026-04-24) that absorbs one future layout
//! extension without forcing an account-migration instruction. PRD Feature 1
//! (on-chain referrer reimbursement) is the first consumer and extends
//! `Policy` with `referrer`/`referrer_present`/`referrer_share_bps` placed
//! BEFORE the trailing `reserved` pad.

use bytemuck::{Pod, Zeroable};
use pinocchio::error::ProgramError;
use solana_address::Address;

// ---------------------------------------------------------------------------
// ProtocolConfig — discriminator 0
// ---------------------------------------------------------------------------

#[repr(C)]
#[derive(Copy, Clone)]
pub struct ProtocolConfig {
    pub discriminator: u8,
    pub _pad: [u8; 7],

    pub authority: Address,
    pub oracle: Address,
    pub treasury: Address,
    pub usdc_mint: Address,

    pub min_pool_deposit: u64,
    pub default_max_coverage_per_call: u64,

    pub withdrawal_cooldown_seconds: i64,
    pub aggregate_cap_window_seconds: i64,
    pub claim_window_seconds: i64,

    pub protocol_fee_bps: u16,
    pub default_insurance_rate_bps: u16,
    pub min_premium_bps: u16,
    pub aggregate_cap_bps: u16,

    pub max_claims_per_batch: u8,
    pub paused: u8,
    pub bump: u8,
    pub _pad_tail: [u8; 5],

    /// Reserved for one future layout extension without a migration instruction.
    /// Project-wide convention (Rick Q3 2026-04-24).
    pub reserved: [u8; 64],
}

unsafe impl Zeroable for ProtocolConfig {}
unsafe impl Pod for ProtocolConfig {}

impl ProtocolConfig {
    pub const DISCRIMINATOR: u8 = 0;
    pub const LEN: usize = core::mem::size_of::<Self>();

    pub fn try_from_bytes(data: &[u8]) -> Result<&Self, ProgramError> {
        try_cast::<Self>(data, Self::DISCRIMINATOR)
    }

    pub fn try_from_bytes_mut(data: &mut [u8]) -> Result<&mut Self, ProgramError> {
        try_cast_mut::<Self>(data, Self::DISCRIMINATOR)
    }
}

// ---------------------------------------------------------------------------
// CoveragePool — discriminator 1
// ---------------------------------------------------------------------------

#[repr(C)]
#[derive(Copy, Clone)]
pub struct CoveragePool {
    pub discriminator: u8,
    pub _pad: [u8; 7],

    pub authority: Address,
    pub usdc_mint: Address,
    pub vault: Address,

    pub provider_hostname: [u8; 64],

    pub total_deposited: u64,
    pub total_available: u64,
    pub total_premiums_earned: u64,
    pub total_claims_paid: u64,
    pub max_coverage_per_call: u64,
    pub payouts_this_window: u64,

    pub window_start: i64,
    pub created_at: i64,
    pub updated_at: i64,

    pub active_policies: u32,

    pub insurance_rate_bps: u16,
    pub min_premium_bps: u16,

    pub provider_hostname_len: u8,
    pub bump: u8,
    /// WP-8/WP-10 repurposes `_pad_tail[0]` to store `vault_bump` (for the
    /// `[b"vault", pool]` PDA) so hot-path handlers skip `find_program_address`.
    /// That byte is load-bearing — do NOT move or repurpose `_pad_tail`.
    pub _pad_tail: [u8; 6],

    /// Reserved for one future layout extension without a migration instruction.
    /// Project-wide convention (Rick Q3 2026-04-24). Separate from `_pad_tail`
    /// which already carries `vault_bump` in byte 0.
    pub reserved: [u8; 64],
}

unsafe impl Zeroable for CoveragePool {}
unsafe impl Pod for CoveragePool {}

impl CoveragePool {
    pub const DISCRIMINATOR: u8 = 1;
    pub const LEN: usize = core::mem::size_of::<Self>();

    pub fn try_from_bytes(data: &[u8]) -> Result<&Self, ProgramError> {
        try_cast::<Self>(data, Self::DISCRIMINATOR)
    }

    pub fn try_from_bytes_mut(data: &mut [u8]) -> Result<&mut Self, ProgramError> {
        try_cast_mut::<Self>(data, Self::DISCRIMINATOR)
    }

    /// Variable-length view of `provider_hostname` truncated to `provider_hostname_len`.
    /// Returns the used prefix for PDA seed derivation.
    pub fn hostname_bytes(&self) -> &[u8] {
        let len = core::cmp::min(self.provider_hostname_len as usize, self.provider_hostname.len());
        &self.provider_hostname[..len]
    }
}

// ---------------------------------------------------------------------------
// UnderwriterPosition — discriminator 2
// ---------------------------------------------------------------------------

#[repr(C)]
#[derive(Copy, Clone)]
pub struct UnderwriterPosition {
    pub discriminator: u8,
    pub _pad: [u8; 7],

    pub pool: Address,
    pub underwriter: Address,

    pub deposited: u64,
    pub earned_premiums: u64,
    pub losses_absorbed: u64,
    pub deposit_timestamp: i64,
    pub last_claim_timestamp: i64,

    pub bump: u8,
    pub _pad_tail: [u8; 7],

    /// Reserved for one future layout extension without a migration instruction.
    /// Project-wide convention (Rick Q3 2026-04-24).
    pub reserved: [u8; 64],
}

unsafe impl Zeroable for UnderwriterPosition {}
unsafe impl Pod for UnderwriterPosition {}

impl UnderwriterPosition {
    pub const DISCRIMINATOR: u8 = 2;
    pub const LEN: usize = core::mem::size_of::<Self>();

    pub fn try_from_bytes(data: &[u8]) -> Result<&Self, ProgramError> {
        try_cast::<Self>(data, Self::DISCRIMINATOR)
    }

    pub fn try_from_bytes_mut(data: &mut [u8]) -> Result<&mut Self, ProgramError> {
        try_cast_mut::<Self>(data, Self::DISCRIMINATOR)
    }
}

// ---------------------------------------------------------------------------
// Policy — discriminator 3
// ---------------------------------------------------------------------------

#[repr(C)]
#[derive(Copy, Clone)]
pub struct Policy {
    pub discriminator: u8,
    pub _pad: [u8; 7],

    pub agent: Address,
    pub pool: Address,
    pub agent_token_account: Address,

    pub agent_id: [u8; 64],

    pub total_premiums_paid: u64,
    pub total_claims_received: u64,
    pub calls_covered: u64,
    pub created_at: i64,
    pub expires_at: i64,

    pub agent_id_len: u8,
    pub active: u8,
    pub bump: u8,
    pub _pad_tail: [u8; 5],

    // ---- Phase 5 Feature 1 (on-chain referrer reimbursement) ----
    //
    // `referrer` is `[u8; 32]` (align 1) — all-zero bytes is the "None"
    // sentinel; `referrer_present` is the explicit discriminant so code never
    // has to compare 32 zero bytes to answer "Some vs None". `bytemuck::Pod`
    // rejects `bool` and `Option<Pubkey>`, hence the wire-level layout here.
    //
    // Validation (WP-12): `referrer_present == 0` iff `referrer_share_bps == 0`,
    // and `referrer_share_bps <= MAX_REFERRER_SHARE_BPS`.
    /// Referrer USDC ATA owner pubkey; all-zero bytes = None.
    pub referrer: [u8; 32],
    /// Premium share in bps (u16; align 2). Placed before `referrer_present`
    /// so its 2-byte alignment falls on an even offset with zero implicit
    /// padding.
    pub referrer_share_bps: u16,
    /// 1 = `referrer` slot populated; 0 = None. Paired bool + share flag.
    pub referrer_present: u8,
    /// Explicit alignment pad so `reserved: [u8; 64]` starts on an 8-byte
    /// boundary and the struct total size stays a multiple of 8.
    pub _pad_referrer: [u8; 5],

    /// Reserved for one future layout extension without a migration instruction.
    /// Project-wide convention (Rick Q3 2026-04-24). PRD Feature 1 call-out:
    /// "DO NOT use this pad for unrelated fields — it exists specifically to
    /// absorb the next referrer-model extension without a migration."
    pub reserved: [u8; 64],
}

unsafe impl Zeroable for Policy {}
unsafe impl Pod for Policy {}

impl Policy {
    pub const DISCRIMINATOR: u8 = 3;
    pub const LEN: usize = core::mem::size_of::<Self>();

    pub fn try_from_bytes(data: &[u8]) -> Result<&Self, ProgramError> {
        try_cast::<Self>(data, Self::DISCRIMINATOR)
    }

    pub fn try_from_bytes_mut(data: &mut [u8]) -> Result<&mut Self, ProgramError> {
        try_cast_mut::<Self>(data, Self::DISCRIMINATOR)
    }

    pub fn agent_id_bytes(&self) -> &[u8] {
        let len = core::cmp::min(self.agent_id_len as usize, self.agent_id.len());
        &self.agent_id[..len]
    }
}

// ---------------------------------------------------------------------------
// Claim — discriminator 4
// ---------------------------------------------------------------------------

/// `TriggerType` mirrored as `u8`. Valid values: 0..=3.
/// Matches Anchor's `enum TriggerType { Timeout, Error, SchemaMismatch, LatencySla }`.
#[repr(u8)]
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum TriggerType {
    Timeout = 0,
    Error = 1,
    SchemaMismatch = 2,
    LatencySla = 3,
}

/// `ClaimStatus` mirrored as `u8`. Valid values: 0..=2.
/// Matches Anchor's `enum ClaimStatus { Pending, Approved, Rejected }`.
#[repr(u8)]
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum ClaimStatus {
    Pending = 0,
    Approved = 1,
    Rejected = 2,
}

#[repr(C)]
#[derive(Copy, Clone)]
pub struct Claim {
    pub discriminator: u8,
    pub _pad: [u8; 7],

    pub policy: Address,
    pub pool: Address,
    pub agent: Address,

    /// SHA-256 digest of the agent-provided `call_id` (see pda.rs — claim
    /// seeds use this hash as the third seed, so it must match).
    pub call_id: [u8; 32],
    pub evidence_hash: [u8; 32],

    pub payment_amount: u64,
    pub refund_amount: u64,
    pub call_timestamp: i64,
    pub created_at: i64,
    pub resolved_at: i64,

    pub latency_ms: u32,

    pub status_code: u16,

    /// Raw byte of `TriggerType`. Use `Claim::trigger_type()` for typed access.
    pub trigger_type: u8,
    /// Raw byte of `ClaimStatus`. Use `Claim::status()` for typed access.
    pub status: u8,
    pub bump: u8,
    pub _pad_tail: [u8; 7],

    /// Reserved for one future layout extension without a migration instruction.
    /// Project-wide convention (Rick Q3 2026-04-24).
    pub reserved: [u8; 64],
}

unsafe impl Zeroable for Claim {}
unsafe impl Pod for Claim {}

impl Claim {
    pub const DISCRIMINATOR: u8 = 4;
    pub const LEN: usize = core::mem::size_of::<Self>();

    pub fn try_from_bytes(data: &[u8]) -> Result<&Self, ProgramError> {
        try_cast::<Self>(data, Self::DISCRIMINATOR)
    }

    pub fn try_from_bytes_mut(data: &mut [u8]) -> Result<&mut Self, ProgramError> {
        try_cast_mut::<Self>(data, Self::DISCRIMINATOR)
    }

    pub fn trigger_type(&self) -> Result<TriggerType, ProgramError> {
        match self.trigger_type {
            0 => Ok(TriggerType::Timeout),
            1 => Ok(TriggerType::Error),
            2 => Ok(TriggerType::SchemaMismatch),
            3 => Ok(TriggerType::LatencySla),
            _ => Err(ProgramError::InvalidAccountData),
        }
    }

    pub fn status(&self) -> Result<ClaimStatus, ProgramError> {
        match self.status {
            0 => Ok(ClaimStatus::Pending),
            1 => Ok(ClaimStatus::Approved),
            2 => Ok(ClaimStatus::Rejected),
            _ => Err(ProgramError::InvalidAccountData),
        }
    }
}

// ---------------------------------------------------------------------------
// Byte-level helpers
// ---------------------------------------------------------------------------

#[inline]
fn try_cast<T: Pod>(data: &[u8], expected_disc: u8) -> Result<&T, ProgramError> {
    if data.len() != core::mem::size_of::<T>() {
        return Err(ProgramError::InvalidAccountData);
    }
    if data[0] != expected_disc {
        return Err(ProgramError::InvalidAccountData);
    }
    bytemuck::try_from_bytes::<T>(data).map_err(|_| ProgramError::InvalidAccountData)
}

#[inline]
fn try_cast_mut<T: Pod>(data: &mut [u8], expected_disc: u8) -> Result<&mut T, ProgramError> {
    if data.len() != core::mem::size_of::<T>() {
        return Err(ProgramError::InvalidAccountData);
    }
    if data[0] != expected_disc {
        return Err(ProgramError::InvalidAccountData);
    }
    bytemuck::try_from_bytes_mut::<T>(data).map_err(|_| ProgramError::InvalidAccountData)
}

// ---------------------------------------------------------------------------
// Compile-time offset asserts — first domain field MUST be at offset 8.
// Breaks the build (not just tests) if padding drifts.
// ---------------------------------------------------------------------------

const _: () = assert!(core::mem::offset_of!(ProtocolConfig, authority) == 8);
const _: () = assert!(core::mem::offset_of!(CoveragePool, authority) == 8);
const _: () = assert!(core::mem::offset_of!(UnderwriterPosition, pool) == 8);
const _: () = assert!(core::mem::offset_of!(Policy, agent) == 8);
const _: () = assert!(core::mem::offset_of!(Claim, policy) == 8);

// Reserved-pad location is load-bearing: every struct places `reserved`
// exactly 64 bytes from the end, so a future field can migrate into it by
// shrinking the pad — no offset shift for earlier fields.
const _: () = assert!(
    core::mem::offset_of!(ProtocolConfig, reserved) == ProtocolConfig::LEN - 64,
);
const _: () = assert!(
    core::mem::offset_of!(CoveragePool, reserved) == CoveragePool::LEN - 64,
);
const _: () = assert!(
    core::mem::offset_of!(UnderwriterPosition, reserved) == UnderwriterPosition::LEN - 64,
);
const _: () = assert!(
    core::mem::offset_of!(Policy, reserved) == Policy::LEN - 64,
);
const _: () = assert!(core::mem::offset_of!(Claim, reserved) == Claim::LEN - 64);

// Phase 5 F1 — pin the referrer fields' offsets so WP-12's handler can't
// drift against the decoders downstream.
const _: () = assert!(core::mem::offset_of!(Policy, referrer) == 216);
const _: () = assert!(core::mem::offset_of!(Policy, referrer_share_bps) == 248);
const _: () = assert!(core::mem::offset_of!(Policy, referrer_present) == 250);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn addr(b: u8) -> Address {
        Address::new_from_array([b; 32])
    }

    // ---- Offset invariant -------------------------------------------------

    #[test]
    fn first_domain_field_offset_is_8_protocol_config() {
        assert_eq!(core::mem::offset_of!(ProtocolConfig, authority), 8);
    }

    #[test]
    fn first_domain_field_offset_is_8_coverage_pool() {
        assert_eq!(core::mem::offset_of!(CoveragePool, authority), 8);
    }

    #[test]
    fn first_domain_field_offset_is_8_underwriter_position() {
        assert_eq!(core::mem::offset_of!(UnderwriterPosition, pool), 8);
    }

    #[test]
    fn first_domain_field_offset_is_8_policy() {
        assert_eq!(core::mem::offset_of!(Policy, agent), 8);
    }

    #[test]
    fn first_domain_field_offset_is_8_claim() {
        assert_eq!(core::mem::offset_of!(Claim, policy), 8);
    }

    // ---- Size is a multiple of 8 (alignment rounding) --------------------

    #[test]
    fn sizes_are_multiples_of_8() {
        assert_eq!(ProtocolConfig::LEN % 8, 0);
        assert_eq!(CoveragePool::LEN % 8, 0);
        assert_eq!(UnderwriterPosition::LEN % 8, 0);
        assert_eq!(Policy::LEN % 8, 0);
        assert_eq!(Claim::LEN % 8, 0);
    }

    // ---- Size equals sum of declared fields (no hidden padding) ----------
    //
    // bytemuck::Pod requires zero internal padding holes. If repr(C) inserts
    // any implicit padding beyond our explicit `_pad` / `_pad_tail` arrays,
    // these assertions fail.

    #[test]
    fn protocol_config_size_has_no_hidden_padding() {
        // 1 + 7 + 32*4 + 8*5 + 2*4 + 1*3 + 5 + 64 = 192 + 64 = 256
        let declared =
            1 + 7 + 32 * 4 + 8 * 5 + 2 * 4 + 1 * 3 + 5 + 64;
        assert_eq!(ProtocolConfig::LEN, declared);
    }

    #[test]
    fn coverage_pool_size_has_no_hidden_padding() {
        // 1 + 7 + 32*3 + 64 + 8*6 + 8*3 + 4 + 2*2 + 1*2 + 6 + 64 = 256 + 64 = 320
        let declared =
            1 + 7 + 32 * 3 + 64 + 8 * 6 + 8 * 3 + 4 + 2 * 2 + 1 * 2 + 6 + 64;
        assert_eq!(CoveragePool::LEN, declared);
    }

    #[test]
    fn underwriter_position_size_has_no_hidden_padding() {
        // 1 + 7 + 32*2 + 8*5 + 1 + 7 + 64 = 120 + 64 = 184
        let declared = 1 + 7 + 32 * 2 + 8 * 5 + 1 + 7 + 64;
        assert_eq!(UnderwriterPosition::LEN, declared);
    }

    #[test]
    fn policy_size_has_no_hidden_padding() {
        // Base: 1 + 7 + 32*3 + 64 + 8*5 + 1*3 + 5 = 216
        // F1:   referrer[32] + u16 + u8 + pad[5] = 40
        // Pad:  reserved[64]
        // Total 216 + 40 + 64 = 320
        let declared =
            1 + 7 + 32 * 3 + 64 + 8 * 5 + 1 * 3 + 5 + 32 + 2 + 1 + 5 + 64;
        assert_eq!(Policy::LEN, declared);
    }

    #[test]
    fn claim_size_has_no_hidden_padding() {
        // 1 + 7 + 32*3 + 32*2 + 8*5 + 4 + 2 + 1*3 + 7 + 64 = 224 + 64 = 288
        let declared =
            1 + 7 + 32 * 3 + 32 * 2 + 8 * 5 + 4 + 2 + 1 * 3 + 7 + 64;
        assert_eq!(Claim::LEN, declared);
    }

    // ---- Reserved pad is present and writable --------------------------

    #[test]
    fn reserved_pad_length_is_64_on_every_struct() {
        assert_eq!(ProtocolConfig::zeroed().reserved.len(), 64);
        assert_eq!(CoveragePool::zeroed().reserved.len(), 64);
        assert_eq!(UnderwriterPosition::zeroed().reserved.len(), 64);
        assert_eq!(Policy::zeroed().reserved.len(), 64);
        assert_eq!(Claim::zeroed().reserved.len(), 64);
    }

    #[test]
    fn expected_struct_sizes() {
        assert_eq!(ProtocolConfig::LEN, 256);
        assert_eq!(CoveragePool::LEN, 320);
        assert_eq!(UnderwriterPosition::LEN, 184);
        assert_eq!(Policy::LEN, 320);
        assert_eq!(Claim::LEN, 288);
    }

    // ---- Round-trip tests (zero → populate → bytes_of → try_from_bytes) ---

    #[test]
    fn protocol_config_round_trip() {
        let mut cfg = ProtocolConfig::zeroed();
        cfg.discriminator = ProtocolConfig::DISCRIMINATOR;
        cfg.authority = addr(0x11);
        cfg.oracle = addr(0x22);
        cfg.treasury = addr(0x33);
        cfg.usdc_mint = addr(0x44);
        cfg.min_pool_deposit = 1_000_000;
        cfg.default_max_coverage_per_call = 2_000_000;
        cfg.withdrawal_cooldown_seconds = 604_800;
        cfg.aggregate_cap_window_seconds = 86_400;
        cfg.claim_window_seconds = 3600;
        cfg.protocol_fee_bps = 1500;
        cfg.default_insurance_rate_bps = 25;
        cfg.min_premium_bps = 5;
        cfg.aggregate_cap_bps = 3000;
        cfg.max_claims_per_batch = 10;
        cfg.paused = 0;
        cfg.bump = 254;
        cfg.reserved = [0xAB; 64];

        let bytes = bytemuck::bytes_of(&cfg);
        assert_eq!(bytes.len(), ProtocolConfig::LEN);

        let decoded = ProtocolConfig::try_from_bytes(bytes).unwrap();
        assert_eq!(decoded.discriminator, ProtocolConfig::DISCRIMINATOR);
        assert_eq!(decoded.authority, cfg.authority);
        assert_eq!(decoded.oracle, cfg.oracle);
        assert_eq!(decoded.treasury, cfg.treasury);
        assert_eq!(decoded.usdc_mint, cfg.usdc_mint);
        assert_eq!(decoded.min_pool_deposit, cfg.min_pool_deposit);
        assert_eq!(decoded.default_max_coverage_per_call, cfg.default_max_coverage_per_call);
        assert_eq!(decoded.withdrawal_cooldown_seconds, cfg.withdrawal_cooldown_seconds);
        assert_eq!(decoded.aggregate_cap_window_seconds, cfg.aggregate_cap_window_seconds);
        assert_eq!(decoded.claim_window_seconds, cfg.claim_window_seconds);
        assert_eq!(decoded.protocol_fee_bps, cfg.protocol_fee_bps);
        assert_eq!(decoded.default_insurance_rate_bps, cfg.default_insurance_rate_bps);
        assert_eq!(decoded.min_premium_bps, cfg.min_premium_bps);
        assert_eq!(decoded.aggregate_cap_bps, cfg.aggregate_cap_bps);
        assert_eq!(decoded.max_claims_per_batch, cfg.max_claims_per_batch);
        assert_eq!(decoded.paused, cfg.paused);
        assert_eq!(decoded.bump, cfg.bump);
        assert_eq!(decoded.reserved, [0xAB; 64]);
    }

    #[test]
    fn coverage_pool_round_trip() {
        let mut pool = CoveragePool::zeroed();
        pool.discriminator = CoveragePool::DISCRIMINATOR;
        pool.authority = addr(0x55);
        pool.usdc_mint = addr(0x66);
        pool.vault = addr(0x77);
        let hostname = b"api.openai.com";
        pool.provider_hostname[..hostname.len()].copy_from_slice(hostname);
        pool.provider_hostname_len = hostname.len() as u8;
        pool.total_deposited = 10;
        pool.total_available = 20;
        pool.total_premiums_earned = 30;
        pool.total_claims_paid = 40;
        pool.max_coverage_per_call = 50;
        pool.payouts_this_window = 60;
        pool.window_start = 70;
        pool.created_at = 80;
        pool.updated_at = 90;
        pool.active_policies = 7;
        pool.insurance_rate_bps = 25;
        pool.min_premium_bps = 5;
        pool.bump = 253;
        pool.reserved = [0xCD; 64];

        let bytes = bytemuck::bytes_of(&pool);
        let decoded = CoveragePool::try_from_bytes(bytes).unwrap();

        assert_eq!(decoded.authority, pool.authority);
        assert_eq!(decoded.usdc_mint, pool.usdc_mint);
        assert_eq!(decoded.vault, pool.vault);
        assert_eq!(decoded.hostname_bytes(), hostname);
        assert_eq!(decoded.total_deposited, 10);
        assert_eq!(decoded.total_available, 20);
        assert_eq!(decoded.total_premiums_earned, 30);
        assert_eq!(decoded.total_claims_paid, 40);
        assert_eq!(decoded.max_coverage_per_call, 50);
        assert_eq!(decoded.payouts_this_window, 60);
        assert_eq!(decoded.window_start, 70);
        assert_eq!(decoded.created_at, 80);
        assert_eq!(decoded.updated_at, 90);
        assert_eq!(decoded.active_policies, 7);
        assert_eq!(decoded.insurance_rate_bps, 25);
        assert_eq!(decoded.min_premium_bps, 5);
        assert_eq!(decoded.bump, 253);
        assert_eq!(decoded.reserved, [0xCD; 64]);
    }

    #[test]
    fn underwriter_position_round_trip() {
        let mut pos = UnderwriterPosition::zeroed();
        pos.discriminator = UnderwriterPosition::DISCRIMINATOR;
        pos.pool = addr(0xAA);
        pos.underwriter = addr(0xBB);
        pos.deposited = 100;
        pos.earned_premiums = 200;
        pos.losses_absorbed = 300;
        pos.deposit_timestamp = 400;
        pos.last_claim_timestamp = 500;
        pos.bump = 250;
        pos.reserved = [0xEF; 64];

        let bytes = bytemuck::bytes_of(&pos);
        let decoded = UnderwriterPosition::try_from_bytes(bytes).unwrap();

        assert_eq!(decoded.pool, pos.pool);
        assert_eq!(decoded.underwriter, pos.underwriter);
        assert_eq!(decoded.deposited, 100);
        assert_eq!(decoded.earned_premiums, 200);
        assert_eq!(decoded.losses_absorbed, 300);
        assert_eq!(decoded.deposit_timestamp, 400);
        assert_eq!(decoded.last_claim_timestamp, 500);
        assert_eq!(decoded.bump, 250);
        assert_eq!(decoded.reserved, [0xEF; 64]);
    }

    #[test]
    fn policy_round_trip() {
        let mut policy = Policy::zeroed();
        policy.discriminator = Policy::DISCRIMINATOR;
        policy.agent = addr(0xCC);
        policy.pool = addr(0xDD);
        policy.agent_token_account = addr(0xEE);
        let id = b"agent-abc-123";
        policy.agent_id[..id.len()].copy_from_slice(id);
        policy.agent_id_len = id.len() as u8;
        policy.total_premiums_paid = 1;
        policy.total_claims_received = 2;
        policy.calls_covered = 3;
        policy.created_at = 4;
        policy.expires_at = 5;
        policy.active = 1;
        policy.bump = 249;
        policy.reserved = [0x12; 64];

        let bytes = bytemuck::bytes_of(&policy);
        let decoded = Policy::try_from_bytes(bytes).unwrap();

        assert_eq!(decoded.agent, policy.agent);
        assert_eq!(decoded.pool, policy.pool);
        assert_eq!(decoded.agent_token_account, policy.agent_token_account);
        assert_eq!(decoded.agent_id_bytes(), id);
        assert_eq!(decoded.total_premiums_paid, 1);
        assert_eq!(decoded.total_claims_received, 2);
        assert_eq!(decoded.calls_covered, 3);
        assert_eq!(decoded.created_at, 4);
        assert_eq!(decoded.expires_at, 5);
        assert_eq!(decoded.active, 1);
        assert_eq!(decoded.bump, 249);
        assert_eq!(decoded.reserved, [0x12; 64]);

        // Zero-initialized Phase 5 F1 fields default to `None` referrer.
        assert_eq!(decoded.referrer, [0u8; 32]);
        assert_eq!(decoded.referrer_present, 0);
        assert_eq!(decoded.referrer_share_bps, 0);
    }

    #[test]
    fn policy_round_trip_with_referrer_populated() {
        // Phase 5 F1 — policy with a referrer snapshot captured at creation.
        let mut policy = Policy::zeroed();
        policy.discriminator = Policy::DISCRIMINATOR;
        policy.agent = addr(0x71);
        policy.pool = addr(0x72);
        policy.agent_token_account = addr(0x73);
        let id = b"agent-with-ref";
        policy.agent_id[..id.len()].copy_from_slice(id);
        policy.agent_id_len = id.len() as u8;
        policy.active = 1;
        policy.bump = 240;

        policy.referrer = [0xAB; 32];
        policy.referrer_present = 1;
        policy.referrer_share_bps = 1_000; // 10% of premium.
        policy.reserved = [0x55; 64];

        let bytes = bytemuck::bytes_of(&policy);
        assert_eq!(bytes.len(), Policy::LEN);

        let decoded = Policy::try_from_bytes(bytes).unwrap();
        assert_eq!(decoded.referrer, [0xAB; 32]);
        assert_eq!(decoded.referrer_present, 1);
        assert_eq!(decoded.referrer_share_bps, 1_000);
        assert_eq!(decoded.reserved, [0x55; 64]);
    }

    #[test]
    fn claim_round_trip() {
        let mut claim = Claim::zeroed();
        claim.discriminator = Claim::DISCRIMINATOR;
        claim.policy = addr(0x01);
        claim.pool = addr(0x02);
        claim.agent = addr(0x03);
        claim.call_id = [0x42; 32];
        claim.evidence_hash = [0x99; 32];
        claim.payment_amount = 1_000;
        claim.refund_amount = 250;
        claim.call_timestamp = 10;
        claim.created_at = 20;
        claim.resolved_at = 30;
        claim.latency_ms = 1234;
        claim.status_code = 504;
        claim.trigger_type = TriggerType::Timeout as u8;
        claim.status = ClaimStatus::Pending as u8;
        claim.bump = 248;
        claim.reserved = [0x7F; 64];

        let bytes = bytemuck::bytes_of(&claim);
        let decoded = Claim::try_from_bytes(bytes).unwrap();

        assert_eq!(decoded.policy, claim.policy);
        assert_eq!(decoded.pool, claim.pool);
        assert_eq!(decoded.agent, claim.agent);
        assert_eq!(decoded.call_id, claim.call_id);
        assert_eq!(decoded.evidence_hash, claim.evidence_hash);
        assert_eq!(decoded.payment_amount, 1_000);
        assert_eq!(decoded.refund_amount, 250);
        assert_eq!(decoded.call_timestamp, 10);
        assert_eq!(decoded.created_at, 20);
        assert_eq!(decoded.resolved_at, 30);
        assert_eq!(decoded.latency_ms, 1234);
        assert_eq!(decoded.status_code, 504);
        assert_eq!(decoded.trigger_type().unwrap(), TriggerType::Timeout);
        assert_eq!(decoded.status().unwrap(), ClaimStatus::Pending);
        assert_eq!(decoded.bump, 248);
        assert_eq!(decoded.reserved, [0x7F; 64]);
    }

    // ---- Mut round-trip (verify try_from_bytes_mut lets callers write) ---

    #[test]
    fn protocol_config_mut_write_back() {
        let mut buf = vec![0u8; ProtocolConfig::LEN];
        buf[0] = ProtocolConfig::DISCRIMINATOR;
        {
            let cfg = ProtocolConfig::try_from_bytes_mut(&mut buf).unwrap();
            cfg.authority = addr(0x77);
            cfg.bump = 200;
        }
        let cfg = ProtocolConfig::try_from_bytes(&buf).unwrap();
        assert_eq!(cfg.authority, addr(0x77));
        assert_eq!(cfg.bump, 200);
    }

    // ---- Negative: wrong discriminator / wrong length --------------------

    #[test]
    fn try_from_bytes_rejects_wrong_discriminator() {
        let mut buf = vec![0u8; CoveragePool::LEN];
        buf[0] = 0xFF; // not CoveragePool::DISCRIMINATOR
        assert!(matches!(
            CoveragePool::try_from_bytes(&buf),
            Err(ProgramError::InvalidAccountData)
        ));
    }

    #[test]
    fn try_from_bytes_rejects_wrong_length() {
        let buf = vec![Policy::DISCRIMINATOR; Policy::LEN - 1];
        assert!(matches!(
            Policy::try_from_bytes(&buf),
            Err(ProgramError::InvalidAccountData)
        ));
    }

    // ---- Discriminator uniqueness ----------------------------------------

    #[test]
    fn discriminators_are_unique_and_contiguous() {
        let discs = [
            ProtocolConfig::DISCRIMINATOR,
            CoveragePool::DISCRIMINATOR,
            UnderwriterPosition::DISCRIMINATOR,
            Policy::DISCRIMINATOR,
            Claim::DISCRIMINATOR,
        ];
        assert_eq!(discs, [0, 1, 2, 3, 4]);
    }
}
