use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::state::{ProtocolConfig, CoveragePool, Policy};
use crate::error::PactError;

#[derive(Accounts)]
pub struct SettlePremium<'info> {
    #[account(
        seeds = [ProtocolConfig::SEED],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, ProtocolConfig>>,

    #[account(
        mut,
        seeds = [CoveragePool::SEED_PREFIX, pool.provider_hostname.as_bytes()],
        bump = pool.bump,
    )]
    pub pool: Box<Account<'info, CoveragePool>>,

    #[account(
        mut,
        seeds = [CoveragePool::VAULT_SEED_PREFIX, pool.key().as_ref()],
        bump,
        constraint = vault.mint == pool.usdc_mint,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    // Intentionally does NOT check policy.active. See handler comment below.
    #[account(
        mut,
        seeds = [
            Policy::SEED_PREFIX,
            pool.key().as_ref(),
            policy.agent.as_ref()
        ],
        bump = policy.bump,
        constraint = policy.pool == pool.key(),
    )]
    pub policy: Box<Account<'info, Policy>>,

    #[account(
        mut,
        constraint = agent_token_account.key() == policy.agent_token_account @ PactError::TokenAccountMismatch,
        constraint = agent_token_account.mint == pool.usdc_mint @ PactError::TokenAccountMismatch,
    )]
    pub agent_token_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = treasury_token_account.mint == pool.usdc_mint,
        constraint = treasury_token_account.owner == config.treasury,
    )]
    pub treasury_token_account: Box<Account<'info, TokenAccount>>,

    // C-02 (continuation): settle_premium is a high-frequency crank-driven
    // operation and must NOT require the admin authority key to be hot.
    // Oracle signs, same keypair as submit_claim.
    #[account(
        constraint = oracle.key() == config.oracle @ PactError::UnauthorizedOracle,
    )]
    pub oracle: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<SettlePremium>, call_value: u64) -> Result<()> {
    require!(call_value > 0, PactError::ZeroAmount);

    // Intentionally does NOT gate on `policy.active`. If an agent racks up
    // billable calls during a settlement window and then calls
    // `disable_policy` before the crank lands, the premium for those calls
    // is still owed — they were made under coverage. Revocation applies to
    // `submit_claim` (no new claims on an inactive policy), not to
    // collection of premiums that have already accrued. `expires_at` is
    // still enforced so a long-stale policy stops accruing.
    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp < ctx.accounts.policy.expires_at,
        PactError::PolicyExpired
    );

    let agent_ata = &ctx.accounts.agent_token_account;
    require!(agent_ata.delegate.is_some(), PactError::DelegationMissing);
    require!(
        agent_ata.delegate.unwrap() == ctx.accounts.pool.key(),
        PactError::DelegationMissing
    );

    let pool = &ctx.accounts.pool;
    let config = &ctx.accounts.config;

    let mut gross_premium = (call_value as u128)
        .checked_mul(pool.insurance_rate_bps as u128)
        .ok_or(PactError::ArithmeticOverflow)?
        .checked_div(10_000)
        .ok_or(PactError::ArithmeticOverflow)? as u64;

    if gross_premium > agent_ata.delegated_amount {
        gross_premium = agent_ata.delegated_amount;
    }
    if gross_premium > agent_ata.amount {
        gross_premium = agent_ata.amount;
    }

    if gross_premium == 0 {
        return Ok(());
    }

    let protocol_fee = (gross_premium as u128)
        .checked_mul(config.protocol_fee_bps as u128)
        .ok_or(PactError::ArithmeticOverflow)?
        .checked_div(10_000)
        .ok_or(PactError::ArithmeticOverflow)? as u64;
    let pool_premium = gross_premium
        .checked_sub(protocol_fee)
        .ok_or(PactError::ArithmeticOverflow)?;

    let hostname_bytes = pool.provider_hostname.as_bytes().to_vec();
    let pool_bump = pool.bump;
    let seeds: &[&[u8]] = &[
        CoveragePool::SEED_PREFIX,
        &hostname_bytes,
        &[pool_bump],
    ];
    let signer_seeds = &[seeds];

    if pool_premium > 0 {
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.agent_token_account.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.pool.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(cpi_ctx, pool_premium)?;
    }

    if protocol_fee > 0 {
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.agent_token_account.to_account_info(),
                to: ctx.accounts.treasury_token_account.to_account_info(),
                authority: ctx.accounts.pool.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(cpi_ctx, protocol_fee)?;
    }

    let pool = &mut ctx.accounts.pool;
    let policy = &mut ctx.accounts.policy;

    policy.total_premiums_paid = policy
        .total_premiums_paid
        .checked_add(gross_premium)
        .ok_or(PactError::ArithmeticOverflow)?;

    pool.total_premiums_earned = pool
        .total_premiums_earned
        .checked_add(pool_premium)
        .ok_or(PactError::ArithmeticOverflow)?;
    pool.total_available = pool
        .total_available
        .checked_add(pool_premium)
        .ok_or(PactError::ArithmeticOverflow)?;
    pool.updated_at = clock.unix_timestamp;

    Ok(())
}
