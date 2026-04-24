#![allow(unexpected_cfgs)]

pub mod constants;
pub mod discriminator;
pub mod entrypoint;
pub mod error;
pub mod instructions;
pub mod pda;
pub mod state;
pub mod system;
pub mod token;
pub mod token_account;

#[cfg(feature = "bpf-entrypoint")]
pinocchio::entrypoint!(entrypoint::process_instruction);

solana_address::declare_id!("2Go74eCvY8vCco3WPuteGzrhKz8v3R7Pcp5tjuFpcmN3");

/// Hard-coded deployer pubkey enforced when the `enforce-deployer` feature is
/// ON. Mirrors the Anchor crate's `DEPLOYER_PUBKEY` so the two builds agree on
/// who can ship `initialize_protocol` to mainnet / devnet.
#[cfg(feature = "enforce-deployer")]
pub const DEPLOYER_PUBKEY: solana_address::Address =
    solana_address::Address::from_str_const("5XyGGyazg6rGJU3Hjkrx1PDM1rBE3FraRnMauSR46rW1");
