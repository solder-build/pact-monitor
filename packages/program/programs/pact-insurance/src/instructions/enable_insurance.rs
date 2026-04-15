use anchor_lang::prelude::*;
use anchor_spl::token::TokenAccount;
use crate::state::{ProtocolConfig, CoveragePool, Policy};
use crate::constants::MAX_AGENT_ID_LEN;
use crate::error::PactError;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct EnableInsuranceArgs {
    pub agent_id: String,
    pub expires_at: i64,
}

#[derive(Accounts)]
#[instruction(args: EnableInsuranceArgs)]
pub struct EnableInsurance<'info> {
    #[account(
        seeds = [ProtocolConfig::SEED],
        bump = config.bump,
        constraint = !config.paused @ PactError::ProtocolPaused,
    )]
    pub config: Account<'info, ProtocolConfig>,

    #[account(
        mut,
        seeds = [CoveragePool::SEED_PREFIX, pool.provider_hostname.as_bytes()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, CoveragePool>,

    #[account(
        init,
        payer = agent,
        space = 8 + Policy::INIT_SPACE,
        seeds = [
            Policy::SEED_PREFIX,
            pool.key().as_ref(),
            agent.key().as_ref()
        ],
        bump
    )]
    pub policy: Account<'info, Policy>,

    #[account(
        constraint = agent_token_account.owner == agent.key() @ PactError::Unauthorized,
        constraint = agent_token_account.mint == pool.usdc_mint @ PactError::TokenAccountMismatch,
        constraint = agent_token_account.delegate.is_some() @ PactError::DelegationMissing,
        constraint = agent_token_account.delegate.unwrap() == pool.key() @ PactError::DelegationMissing,
        constraint = agent_token_account.delegated_amount > 0 @ PactError::DelegationInsufficient,
    )]
    pub agent_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub agent: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<EnableInsurance>, args: EnableInsuranceArgs) -> Result<()> {
    require!(
        args.agent_id.len() <= MAX_AGENT_ID_LEN,
        PactError::AgentIdTooLong
    );

    let clock = Clock::get()?;
    require!(args.expires_at > clock.unix_timestamp, PactError::PolicyExpired);

    let policy = &mut ctx.accounts.policy;
    let pool = &mut ctx.accounts.pool;

    policy.agent = ctx.accounts.agent.key();
    policy.pool = pool.key();
    policy.agent_id = args.agent_id;
    policy.agent_token_account = ctx.accounts.agent_token_account.key();
    policy.total_premiums_paid = 0;
    policy.total_claims_received = 0;
    policy.calls_covered = 0;
    policy.active = true;
    policy.created_at = clock.unix_timestamp;
    policy.expires_at = args.expires_at;
    policy.bump = ctx.bumps.policy;

    pool.active_policies = pool.active_policies.checked_add(1).ok_or(PactError::ArithmeticOverflow)?;
    pool.updated_at = clock.unix_timestamp;

    Ok(())
}
