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
}
