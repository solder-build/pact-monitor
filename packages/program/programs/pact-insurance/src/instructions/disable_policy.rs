use anchor_lang::prelude::*;
use crate::state::{CoveragePool, Policy};
use crate::error::PactError;

#[derive(Accounts)]
pub struct DisablePolicy<'info> {
    #[account(
        mut,
        seeds = [CoveragePool::SEED_PREFIX, pool.provider_hostname.as_bytes()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, CoveragePool>,

    #[account(
        mut,
        seeds = [
            Policy::SEED_PREFIX,
            pool.key().as_ref(),
            policy.agent.as_ref()
        ],
        bump = policy.bump,
        has_one = agent @ PactError::Unauthorized,
        constraint = policy.pool == pool.key(),
        constraint = policy.active @ PactError::PolicyInactive,
    )]
    pub policy: Account<'info, Policy>,

    pub agent: Signer<'info>,
}

pub fn handler(ctx: Context<DisablePolicy>) -> Result<()> {
    let policy = &mut ctx.accounts.policy;
    let pool = &mut ctx.accounts.pool;
    policy.active = false;
    pool.active_policies = pool.active_policies.saturating_sub(1);
    Ok(())
}
