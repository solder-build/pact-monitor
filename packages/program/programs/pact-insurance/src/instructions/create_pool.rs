use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};
use crate::state::{ProtocolConfig, CoveragePool};
use crate::constants::MAX_HOSTNAME_LEN;
use crate::error::PactError;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CreatePoolArgs {
    pub provider_hostname: String,
    pub insurance_rate_bps: Option<u16>,
    pub max_coverage_per_call: Option<u64>,
}

#[derive(Accounts)]
#[instruction(args: CreatePoolArgs)]
pub struct CreatePool<'info> {
    #[account(
        seeds = [ProtocolConfig::SEED],
        bump = config.bump,
        has_one = authority @ PactError::Unauthorized,
        constraint = !config.paused @ PactError::ProtocolPaused
    )]
    pub config: Account<'info, ProtocolConfig>,

    #[account(
        init,
        payer = authority,
        space = 8 + CoveragePool::INIT_SPACE,
        seeds = [CoveragePool::SEED_PREFIX, args.provider_hostname.as_bytes()],
        bump
    )]
    pub pool: Account<'info, CoveragePool>,

    #[account(
        init,
        payer = authority,
        seeds = [CoveragePool::VAULT_SEED_PREFIX, pool.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = pool,
    )]
    pub vault: Account<'info, TokenAccount>,

    pub usdc_mint: Account<'info, Mint>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(ctx: Context<CreatePool>, args: CreatePoolArgs) -> Result<()> {
    require!(
        args.provider_hostname.len() <= MAX_HOSTNAME_LEN,
        PactError::HostnameTooLong
    );

    let pool = &mut ctx.accounts.pool;
    let config = &ctx.accounts.config;
    let clock = Clock::get()?;

    pool.authority = config.authority;
    pool.provider_hostname = args.provider_hostname;
    pool.usdc_mint = ctx.accounts.usdc_mint.key();
    pool.vault = ctx.accounts.vault.key();

    pool.total_deposited = 0;
    pool.total_available = 0;
    pool.total_premiums_earned = 0;
    pool.total_claims_paid = 0;

    pool.insurance_rate_bps = args
        .insurance_rate_bps
        .unwrap_or(config.default_insurance_rate_bps);
    pool.min_premium_bps = config.min_premium_bps;
    pool.max_coverage_per_call = args
        .max_coverage_per_call
        .unwrap_or(config.default_max_coverage_per_call);

    pool.active_policies = 0;
    pool.payouts_this_window = 0;
    pool.window_start = clock.unix_timestamp;

    pool.created_at = clock.unix_timestamp;
    pool.updated_at = clock.unix_timestamp;
    pool.bump = ctx.bumps.pool;

    Ok(())
}
