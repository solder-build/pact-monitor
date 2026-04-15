use anchor_lang::prelude::*;
use crate::state::ProtocolConfig;
use crate::constants::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeProtocolArgs {
    pub authority: Pubkey,
    pub oracle: Pubkey,
    pub treasury: Pubkey,
    pub usdc_mint: Pubkey,
}

#[derive(Accounts)]
pub struct InitializeProtocol<'info> {
    #[account(
        init,
        payer = deployer,
        space = 8 + ProtocolConfig::INIT_SPACE,
        seeds = [ProtocolConfig::SEED],
        bump
    )]
    pub config: Account<'info, ProtocolConfig>,

    #[account(mut)]
    pub deployer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<InitializeProtocol>,
    args: InitializeProtocolArgs,
) -> Result<()> {
    #[cfg(feature = "enforce-deployer")]
    {
        use crate::DEPLOYER_PUBKEY;
        require!(
            ctx.accounts.deployer.key() == DEPLOYER_PUBKEY,
            crate::error::PactError::UnauthorizedDeployer
        );
    }

    let config = &mut ctx.accounts.config;

    config.authority = args.authority;
    config.oracle = args.oracle;
    config.treasury = args.treasury;
    config.usdc_mint = args.usdc_mint;

    config.protocol_fee_bps = DEFAULT_PROTOCOL_FEE_BPS;
    config.min_pool_deposit = DEFAULT_MIN_POOL_DEPOSIT;
    config.default_insurance_rate_bps = DEFAULT_INSURANCE_RATE_BPS;
    config.default_max_coverage_per_call = DEFAULT_MAX_COVERAGE_PER_CALL;
    config.min_premium_bps = DEFAULT_MIN_PREMIUM_BPS;

    config.withdrawal_cooldown_seconds = DEFAULT_WITHDRAWAL_COOLDOWN;
    config.aggregate_cap_bps = DEFAULT_AGGREGATE_CAP_BPS;
    config.aggregate_cap_window_seconds = DEFAULT_AGGREGATE_CAP_WINDOW;

    config.claim_window_seconds = DEFAULT_CLAIM_WINDOW;
    config.max_claims_per_batch = DEFAULT_MAX_CLAIMS_PER_BATCH;

    config.paused = false;
    config.bump = ctx.bumps.config;

    Ok(())
}
