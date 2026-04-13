pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("4Z1Y3W49U2Cn6bz9UpkahVP7LaeobQ4cAaEt3uNaqSob");

#[program]
pub mod pact_insurance {
    use super::*;

    pub fn initialize_protocol(
        ctx: Context<InitializeProtocol>,
        args: InitializeProtocolArgs,
    ) -> Result<()> {
        instructions::initialize_protocol::handler(ctx, args)
    }

    pub fn update_config(
        ctx: Context<UpdateConfig>,
        args: UpdateConfigArgs,
    ) -> Result<()> {
        instructions::update_config::handler(ctx, args)
    }

    pub fn create_pool(
        ctx: Context<CreatePool>,
        args: CreatePoolArgs,
    ) -> Result<()> {
        instructions::create_pool::handler(ctx, args)
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        instructions::deposit::handler(ctx, amount)
    }

    pub fn enable_insurance(
        ctx: Context<EnableInsurance>,
        args: EnableInsuranceArgs,
    ) -> Result<()> {
        instructions::enable_insurance::handler(ctx, args)
    }

    pub fn settle_premium(ctx: Context<SettlePremium>, call_value: u64) -> Result<()> {
        instructions::settle_premium::handler(ctx, call_value)
    }

    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        instructions::withdraw::handler(ctx, amount)
    }

    pub fn update_rates(ctx: Context<UpdateRates>, new_rate_bps: u16) -> Result<()> {
        instructions::update_rates::handler(ctx, new_rate_bps)
    }

    pub fn submit_claim(ctx: Context<SubmitClaim>, args: SubmitClaimArgs) -> Result<()> {
        instructions::submit_claim::handler(ctx, args)
    }
}
