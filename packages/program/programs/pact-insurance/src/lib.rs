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
}
