use anchor_lang::prelude::*;
use crate::constants::MAX_HOSTNAME_LEN;

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
