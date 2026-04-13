use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::state::{ProtocolConfig, CoveragePool, UnderwriterPosition};
use crate::error::PactError;

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(
        seeds = [ProtocolConfig::SEED],
        bump = config.bump,
        constraint = !config.paused @ PactError::ProtocolPaused
    )]
    pub config: Account<'info, ProtocolConfig>,

    #[account(
        mut,
        seeds = [CoveragePool::SEED_PREFIX, pool.provider_hostname.as_bytes()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, CoveragePool>,

    #[account(
        mut,
        seeds = [CoveragePool::VAULT_SEED_PREFIX, pool.key().as_ref()],
        bump,
        constraint = vault.mint == pool.usdc_mint,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = underwriter,
        space = 8 + UnderwriterPosition::INIT_SPACE,
        seeds = [
            UnderwriterPosition::SEED_PREFIX,
            pool.key().as_ref(),
            underwriter.key().as_ref()
        ],
        bump
    )]
    pub position: Account<'info, UnderwriterPosition>,

    #[account(
        mut,
        constraint = underwriter_token_account.owner == underwriter.key(),
        constraint = underwriter_token_account.mint == pool.usdc_mint,
    )]
    pub underwriter_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub underwriter: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    require!(amount > 0, PactError::ZeroAmount);
    require!(
        amount >= ctx.accounts.config.min_pool_deposit,
        PactError::BelowMinimumDeposit
    );

    let cpi_ctx = CpiContext::new(
        ctx.accounts.token_program.key(),
        Transfer {
            from: ctx.accounts.underwriter_token_account.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.underwriter.to_account_info(),
        },
    );
    token::transfer(cpi_ctx, amount)?;

    let pool = &mut ctx.accounts.pool;
    let position = &mut ctx.accounts.position;
    let clock = Clock::get()?;

    if position.pool == Pubkey::default() {
        position.pool = pool.key();
        position.underwriter = ctx.accounts.underwriter.key();
        position.deposited = 0;
        position.earned_premiums = 0;
        position.losses_absorbed = 0;
        position.last_claim_timestamp = 0;
        position.bump = ctx.bumps.position;
    }

    position.deposited = position
        .deposited
        .checked_add(amount)
        .ok_or(PactError::ArithmeticOverflow)?;
    position.deposit_timestamp = clock.unix_timestamp;

    pool.total_deposited = pool
        .total_deposited
        .checked_add(amount)
        .ok_or(PactError::ArithmeticOverflow)?;
    pool.total_available = pool
        .total_available
        .checked_add(amount)
        .ok_or(PactError::ArithmeticOverflow)?;
    pool.updated_at = clock.unix_timestamp;

    Ok(())
}
