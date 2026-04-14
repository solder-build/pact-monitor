#![allow(ambiguous_glob_reexports)]

pub mod create_pool;
pub mod deposit;
pub mod enable_insurance;
pub mod initialize_protocol;
pub mod settle_premium;
pub mod submit_claim;
pub mod update_config;
pub mod update_oracle;
pub mod update_rates;
pub mod withdraw;

pub use create_pool::*;
pub use deposit::*;
pub use enable_insurance::*;
pub use initialize_protocol::*;
pub use settle_premium::*;
pub use submit_claim::*;
pub use update_config::*;
pub use update_oracle::*;
pub use update_rates::*;
pub use withdraw::*;
