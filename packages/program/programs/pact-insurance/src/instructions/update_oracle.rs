use anchor_lang::prelude::*;
use crate::state::ProtocolConfig;
use crate::error::PactError;

#[derive(Accounts)]
pub struct UpdateOracle<'info> {
    #[account(
        mut,
        seeds = [ProtocolConfig::SEED],
        bump = config.bump,
        has_one = authority @ PactError::Unauthorized,
    )]
    pub config: Account<'info, ProtocolConfig>,

    pub authority: Signer<'info>,
}

pub fn handler(ctx: Context<UpdateOracle>, new_oracle: Pubkey) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.oracle = new_oracle;
    Ok(())
}
