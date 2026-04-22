#![allow(unexpected_cfgs)]

pub mod constants;
pub mod discriminator;
pub mod entrypoint;
pub mod error;
pub mod pda;
pub mod state;

#[cfg(feature = "bpf-entrypoint")]
pinocchio::entrypoint!(entrypoint::process_instruction);

solana_address::declare_id!("2Go74eCvY8vCco3WPuteGzrhKz8v3R7Pcp5tjuFpcmN3");
