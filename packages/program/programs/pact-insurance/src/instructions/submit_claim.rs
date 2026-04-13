use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::state::{ProtocolConfig, CoveragePool, Policy, Claim, TriggerType, ClaimStatus};
use crate::constants::{ABSOLUTE_MAX_AGGREGATE_CAP_BPS, MAX_CALL_ID_LEN};
use crate::error::PactError;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SubmitClaimArgs {
    pub call_id: String,
    pub trigger_type: TriggerType,
    pub evidence_hash: [u8; 32],
    pub call_timestamp: i64,
    pub latency_ms: u32,
    pub status_code: u16,
    pub payment_amount: u64,
}

#[derive(Accounts)]
#[instruction(args: SubmitClaimArgs)]
pub struct SubmitClaim<'info> {
    #[account(
        seeds = [ProtocolConfig::SEED],
        bump = config.bump,
        has_one = authority @ PactError::Unauthorized,
        constraint = !config.paused @ PactError::ProtocolPaused,
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
            Policy::SEED_PREFIX,
            pool.key().as_ref(),
            policy.agent.as_ref()
        ],
        bump = policy.bump,
        constraint = policy.active @ PactError::PolicyInactive,
        constraint = policy.pool == pool.key(),
    )]
    pub policy: Box<Account<'info, Policy>>,

    #[account(
        init,
        payer = authority,
        space = 8 + Claim::INIT_SPACE,
        seeds = [
            Claim::SEED_PREFIX,
            policy.key().as_ref(),
            args.call_id.as_bytes()
        ],
        bump
    )]
    pub claim: Box<Account<'info, Claim>>,

    #[account(
        mut,
        constraint = agent_token_account.mint == pool.usdc_mint,
        constraint = agent_token_account.owner == policy.agent,
    )]
    pub agent_token_account: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<SubmitClaim>, args: SubmitClaimArgs) -> Result<()> {
    require!(args.call_id.len() <= MAX_CALL_ID_LEN, PactError::CallIdTooLong);
    require!(args.payment_amount > 0, PactError::ZeroAmount);

    let config = &ctx.accounts.config;
    let clock = Clock::get()?;

    let age = clock
        .unix_timestamp
        .checked_sub(args.call_timestamp)
        .ok_or(PactError::ArithmeticOverflow)?;
    require!(age <= config.claim_window_seconds, PactError::ClaimWindowExpired);

    let pool = &mut ctx.accounts.pool;
    if clock.unix_timestamp - pool.window_start > config.aggregate_cap_window_seconds {
        pool.payouts_this_window = 0;
        pool.window_start = clock.unix_timestamp;
    }

    let mut refund = args.payment_amount;
    if refund > pool.max_coverage_per_call {
        refund = pool.max_coverage_per_call;
    }
    if refund > pool.total_available {
        refund = pool.total_available;
    }

    let effective_cap_bps = config.aggregate_cap_bps.min(ABSOLUTE_MAX_AGGREGATE_CAP_BPS);
    let cap_limit = (pool.total_deposited as u128)
        .checked_mul(effective_cap_bps as u128)
        .ok_or(PactError::ArithmeticOverflow)?
        .checked_div(10_000)
        .ok_or(PactError::ArithmeticOverflow)? as u64;
    require!(
        pool.payouts_this_window.checked_add(refund).ok_or(PactError::ArithmeticOverflow)? <= cap_limit,
        PactError::AggregateCapExceeded
    );

    let hostname_bytes = pool.provider_hostname.as_bytes().to_vec();
    let pool_bump = pool.bump;
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
            to: ctx.accounts.agent_token_account.to_account_info(),
            authority: pool.to_account_info(),
        },
        signer_seeds,
    );
    token::transfer(cpi_ctx, refund)?;

    let claim = &mut ctx.accounts.claim;
    claim.policy = ctx.accounts.policy.key();
    claim.pool = pool.key();
    claim.agent = ctx.accounts.policy.agent;
    claim.call_id = args.call_id;
    claim.trigger_type = args.trigger_type;
    claim.evidence_hash = args.evidence_hash;
    claim.call_timestamp = args.call_timestamp;
    claim.latency_ms = args.latency_ms;
    claim.status_code = args.status_code;
    claim.payment_amount = args.payment_amount;
    claim.refund_amount = refund;
    claim.status = ClaimStatus::Approved;
    claim.created_at = clock.unix_timestamp;
    claim.resolved_at = clock.unix_timestamp;
    claim.bump = ctx.bumps.claim;

    pool.total_claims_paid = pool.total_claims_paid.checked_add(refund).ok_or(PactError::ArithmeticOverflow)?;
    pool.total_available = pool.total_available.checked_sub(refund).ok_or(PactError::ArithmeticOverflow)?;
    pool.payouts_this_window = pool.payouts_this_window.checked_add(refund).ok_or(PactError::ArithmeticOverflow)?;
    pool.updated_at = clock.unix_timestamp;

    let policy = &mut ctx.accounts.policy;
    policy.total_claims_received = policy.total_claims_received.checked_add(refund).ok_or(PactError::ArithmeticOverflow)?;
    policy.calls_covered = policy.calls_covered.checked_add(1).ok_or(PactError::ArithmeticOverflow)?;

    Ok(())
}
