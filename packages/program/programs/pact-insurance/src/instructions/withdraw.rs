use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::state::{ProtocolConfig, CoveragePool, UnderwriterPosition};
use crate::constants::ABSOLUTE_MIN_WITHDRAWAL_COOLDOWN;
use crate::error::PactError;

#[derive(Accounts)]
pub struct Withdraw<'info> {
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
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [
            UnderwriterPosition::SEED_PREFIX,
            pool.key().as_ref(),
            underwriter.key().as_ref()
        ],
        bump = position.bump,
        constraint = position.underwriter == underwriter.key() @ PactError::Unauthorized,
    )]
    pub position: Box<Account<'info, UnderwriterPosition>>,

    #[account(
        mut,
        constraint = underwriter_token_account.owner == underwriter.key(),
        constraint = underwriter_token_account.mint == pool.usdc_mint,
    )]
    pub underwriter_token_account: Box<Account<'info, TokenAccount>>,

    pub underwriter: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
    require!(amount > 0, PactError::ZeroAmount);

    let clock = Clock::get()?;

    let effective_cooldown = ctx
        .accounts
        .config
        .withdrawal_cooldown_seconds
        .max(ABSOLUTE_MIN_WITHDRAWAL_COOLDOWN);
    let elapsed = clock
        .unix_timestamp
        .checked_sub(ctx.accounts.position.deposit_timestamp)
        .ok_or(PactError::ArithmeticOverflow)?;
    require!(
        elapsed >= effective_cooldown,
        PactError::WithdrawalUnderCooldown
    );

    require!(
        ctx.accounts.position.deposited >= amount,
        PactError::InsufficientPoolBalance
    );
    require!(
        ctx.accounts.pool.total_available >= amount,
        PactError::WithdrawalWouldUnderfund
    );

    let hostname_bytes = ctx.accounts.pool.provider_hostname.as_bytes().to_vec();
    let pool_bump = ctx.accounts.pool.bump;
    let seeds: &[&[u8]] = &[
        CoveragePool::SEED_PREFIX,
        &hostname_bytes,
        &[pool_bump],
    ];
    let signer_seeds = &[seeds];

    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.key(),
        Transfer {
            from: ctx.accounts.vault.to_account_info(),
            to: ctx.accounts.underwriter_token_account.to_account_info(),
            authority: ctx.accounts.pool.to_account_info(),
        },
        signer_seeds,
    );
    token::transfer(cpi_ctx, amount)?;

    let pool = &mut ctx.accounts.pool;
    let position = &mut ctx.accounts.position;

    position.deposited = position.deposited.checked_sub(amount).ok_or(PactError::ArithmeticOverflow)?;
    pool.total_deposited = pool.total_deposited.checked_sub(amount).ok_or(PactError::ArithmeticOverflow)?;
    pool.total_available = pool.total_available.checked_sub(amount).ok_or(PactError::ArithmeticOverflow)?;
    pool.updated_at = clock.unix_timestamp;

    Ok(())
}
