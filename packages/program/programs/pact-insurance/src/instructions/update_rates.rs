use anchor_lang::prelude::*;
use crate::state::{ProtocolConfig, CoveragePool};
use crate::error::PactError;

#[derive(Accounts)]
pub struct UpdateRates<'info> {
    #[account(
        seeds = [ProtocolConfig::SEED],
        bump = config.bump,
        has_one = authority @ PactError::Unauthorized,
    )]
    pub config: Account<'info, ProtocolConfig>,

    #[account(
        mut,
        seeds = [CoveragePool::SEED_PREFIX, pool.provider_hostname.as_bytes()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, CoveragePool>,

    pub authority: Signer<'info>,
}

pub fn handler(ctx: Context<UpdateRates>, new_rate_bps: u16) -> Result<()> {
    require!(new_rate_bps <= 10_000, PactError::RateOutOfBounds);
    require!(
        new_rate_bps >= ctx.accounts.pool.min_premium_bps,
        PactError::RateBelowFloor
    );
    let pool = &mut ctx.accounts.pool;
    let clock = Clock::get()?;
    pool.insurance_rate_bps = new_rate_bps;
    pool.updated_at = clock.unix_timestamp;
    Ok(())
}
