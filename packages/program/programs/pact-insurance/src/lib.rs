pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("4Z1Y3W49U2Cn6bz9UpkahVP7LaeobQ4cAaEt3uNaqSob");

// Hardcoded deployer pubkey for mainnet/devnet deploys. Only enforced when
// compiled with `--features enforce-deployer`. Tests build without this
// feature so they can use a dynamic provider wallet.
#[cfg(feature = "enforce-deployer")]
pub const DEPLOYER_PUBKEY: Pubkey = anchor_lang::pubkey!(
    "11111111111111111111111111111111"
);

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

    pub fn update_oracle(ctx: Context<UpdateOracle>, new_oracle: Pubkey) -> Result<()> {
        instructions::update_oracle::handler(ctx, new_oracle)
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
