use anchor_lang::prelude::*;
use crate::constants::{MAX_AGENT_ID_LEN, MAX_CALL_ID_LEN, MAX_HOSTNAME_LEN};

#[account]
#[derive(InitSpace)]
pub struct ProtocolConfig {
    pub authority: Pubkey,
    pub treasury: Pubkey,
    pub usdc_mint: Pubkey,

    pub protocol_fee_bps: u16,
    pub min_pool_deposit: u64,
    pub default_insurance_rate_bps: u16,
    pub default_max_coverage_per_call: u64,
    pub min_premium_bps: u16,

    pub withdrawal_cooldown_seconds: i64,
    pub aggregate_cap_bps: u16,
    pub aggregate_cap_window_seconds: i64,

    pub claim_window_seconds: i64,
    pub max_claims_per_batch: u8,

    pub paused: bool,

    pub bump: u8,
}

impl ProtocolConfig {
    pub const SEED: &'static [u8] = b"protocol";
}

#[account]
#[derive(InitSpace)]
pub struct CoveragePool {
    pub authority: Pubkey,
    #[max_len(MAX_HOSTNAME_LEN)]
    pub provider_hostname: String,
    pub usdc_mint: Pubkey,
    pub vault: Pubkey,

    pub total_deposited: u64,
    pub total_available: u64,
    pub total_premiums_earned: u64,
    pub total_claims_paid: u64,

    pub insurance_rate_bps: u16,
    pub min_premium_bps: u16,
    pub max_coverage_per_call: u64,

    pub active_policies: u32,

    pub payouts_this_window: u64,
    pub window_start: i64,

    pub created_at: i64,
    pub updated_at: i64,
    pub bump: u8,
}

impl CoveragePool {
    pub const SEED_PREFIX: &'static [u8] = b"pool";
    pub const VAULT_SEED_PREFIX: &'static [u8] = b"vault";
}

#[account]
#[derive(InitSpace)]
pub struct UnderwriterPosition {
    pub pool: Pubkey,
    pub underwriter: Pubkey,
    pub deposited: u64,
    pub earned_premiums: u64,
    pub losses_absorbed: u64,
    pub deposit_timestamp: i64,
    pub last_claim_timestamp: i64,
    pub bump: u8,
}

impl UnderwriterPosition {
    pub const SEED_PREFIX: &'static [u8] = b"position";
}

#[account]
#[derive(InitSpace)]
pub struct Policy {
    pub agent: Pubkey,
    pub pool: Pubkey,
    #[max_len(MAX_AGENT_ID_LEN)]
    pub agent_id: String,
    pub agent_token_account: Pubkey,
    pub total_premiums_paid: u64,
    pub total_claims_received: u64,
    pub calls_covered: u64,
    pub active: bool,
    pub created_at: i64,
    pub expires_at: i64,
    pub bump: u8,
}

impl Policy {
    pub const SEED_PREFIX: &'static [u8] = b"policy";
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum TriggerType {
    Timeout,
    Error,
    SchemaMismatch,
    LatencySla,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum ClaimStatus {
    Pending,
    Approved,
    Rejected,
}

#[account]
#[derive(InitSpace)]
pub struct Claim {
    pub policy: Pubkey,
    pub pool: Pubkey,
    pub agent: Pubkey,
    #[max_len(MAX_CALL_ID_LEN)]
    pub call_id: String,
    pub trigger_type: TriggerType,
    pub evidence_hash: [u8; 32],
    pub call_timestamp: i64,
    pub latency_ms: u32,
    pub status_code: u16,
    pub payment_amount: u64,
    pub refund_amount: u64,
    pub status: ClaimStatus,
    pub created_at: i64,
    pub resolved_at: i64,
    pub bump: u8,
}

impl Claim {
    pub const SEED_PREFIX: &'static [u8] = b"claim";
}
