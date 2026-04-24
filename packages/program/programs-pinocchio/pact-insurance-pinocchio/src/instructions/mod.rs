//! Instruction handlers.
//!
//! Each submodule implements a single 1-byte-discriminated instruction whose
//! index matches the variant of `crate::discriminator::Discriminator`.
//! The entrypoint dispatches based on the leading byte of `instruction_data`
//! and forwards the remaining payload bytes to the handler.

pub mod create_pool;
pub mod deposit;
pub mod enable_insurance;
pub mod initialize_protocol;
pub mod update_config;
pub mod update_oracle;
pub mod update_rates;
pub mod withdraw;
