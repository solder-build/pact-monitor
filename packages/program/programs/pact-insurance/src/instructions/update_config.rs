use anchor_lang::prelude::*;
use crate::state::ProtocolConfig;
use crate::constants::*;
use crate::error::PactError;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct UpdateConfigArgs {
    pub protocol_fee_bps: Option<u16>,
    pub min_pool_deposit: Option<u64>,
    pub default_insurance_rate_bps: Option<u16>,
    pub default_max_coverage_per_call: Option<u64>,
    pub min_premium_bps: Option<u16>,
    pub withdrawal_cooldown_seconds: Option<i64>,
    pub aggregate_cap_bps: Option<u16>,
    pub aggregate_cap_window_seconds: Option<i64>,
    pub claim_window_seconds: Option<i64>,
    pub max_claims_per_batch: Option<u8>,
    pub paused: Option<bool>,
    pub treasury: Option<Pubkey>,
    pub usdc_mint: Option<Pubkey>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(
        mut,
        seeds = [ProtocolConfig::SEED],
        bump = config.bump,
        has_one = authority @ PactError::Unauthorized
    )]
    pub config: Account<'info, ProtocolConfig>,

    pub authority: Signer<'info>,
}

pub fn handler(ctx: Context<UpdateConfig>, args: UpdateConfigArgs) -> Result<()> {
    let config = &mut ctx.accounts.config;

    if let Some(v) = args.protocol_fee_bps {
        require!(v <= ABSOLUTE_MAX_PROTOCOL_FEE_BPS, PactError::ConfigSafetyFloorViolation);
        config.protocol_fee_bps = v;
    }

    if let Some(v) = args.min_pool_deposit {
        require!(v >= ABSOLUTE_MIN_POOL_DEPOSIT, PactError::ConfigSafetyFloorViolation);
        config.min_pool_deposit = v;
    }

    if let Some(v) = args.default_insurance_rate_bps {
        config.default_insurance_rate_bps = v;
    }

    if let Some(v) = args.default_max_coverage_per_call {
        config.default_max_coverage_per_call = v;
    }

    if let Some(v) = args.min_premium_bps {
        config.min_premium_bps = v;
    }

    if let Some(v) = args.withdrawal_cooldown_seconds {
        require!(v >= ABSOLUTE_MIN_WITHDRAWAL_COOLDOWN, PactError::ConfigSafetyFloorViolation);
        config.withdrawal_cooldown_seconds = v;
    }

    if let Some(v) = args.aggregate_cap_bps {
        require!(v <= ABSOLUTE_MAX_AGGREGATE_CAP_BPS, PactError::ConfigSafetyFloorViolation);
        config.aggregate_cap_bps = v;
    }

    if let Some(v) = args.aggregate_cap_window_seconds {
        config.aggregate_cap_window_seconds = v;
    }

    if let Some(v) = args.claim_window_seconds {
        require!(v >= ABSOLUTE_MIN_CLAIM_WINDOW, PactError::ConfigSafetyFloorViolation);
        config.claim_window_seconds = v;
    }

    if let Some(v) = args.max_claims_per_batch {
        config.max_claims_per_batch = v;
    }

    if let Some(v) = args.paused {
        config.paused = v;
    }

    require!(args.treasury.is_none(), PactError::FrozenConfigField);
    require!(args.usdc_mint.is_none(), PactError::FrozenConfigField);

    Ok(())
}
