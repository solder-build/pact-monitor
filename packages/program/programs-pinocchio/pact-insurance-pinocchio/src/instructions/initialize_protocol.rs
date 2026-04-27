//! `initialize_protocol` (discriminator 0) — Pinocchio port.
//!
//! Creates the singleton `ProtocolConfig` PDA on first boot and populates it
//! with the deployer-supplied `authority` / `oracle` / `treasury` / `usdc_mint`
//! plus the constants-derived defaults for fees, rates and safety floors.
//!
//! Instruction layout (after the 1-byte discriminator that the entrypoint has
//! already stripped):
//!   offset 0..32    authority   (32-byte Address, little-endian)
//!   offset 32..64   oracle
//!   offset 64..96   treasury
//!   offset 96..128  usdc_mint
//!
//! Anchor's `InitializeProtocolArgs` Borsh layout has no variable-length
//! fields, so manual byte slicing is both shorter and avoids pulling `borsh`
//! into the SBF build — kept fixed at 128 bytes.
//!
//! Accounts (order matches the Anchor builder):
//!   0. `config`        — writable, PDA `[b"protocol"]`, created here
//!   1. `deployer`      — writable, signer (payer for rent)
//!   2. `system_program` — `11111111111111111111111111111111`

use pinocchio::{
    account::AccountView,
    cpi::Seed,
    error::ProgramError,
    sysvars::{rent::Rent, Sysvar},
    ProgramResult,
};
use solana_address::Address;

use crate::{
    constants::{
        DEFAULT_AGGREGATE_CAP_BPS, DEFAULT_AGGREGATE_CAP_WINDOW, DEFAULT_CLAIM_WINDOW,
        DEFAULT_INSURANCE_RATE_BPS, DEFAULT_MAX_CLAIMS_PER_BATCH, DEFAULT_MAX_COVERAGE_PER_CALL,
        DEFAULT_MIN_POOL_DEPOSIT, DEFAULT_MIN_PREMIUM_BPS, DEFAULT_PROTOCOL_FEE_BPS,
        DEFAULT_WITHDRAWAL_COOLDOWN,
    },
    pda::{derive_protocol, PROTOCOL_SEED},
    state::ProtocolConfig,
    system::{create_account, SYSTEM_PROGRAM_ID},
    ID,
};

/// Length of the raw `InitializeProtocolArgs` payload (four `Pubkey` fields).
const ARGS_LEN: usize = 32 * 4;

/// Expected account count.
const ACCOUNT_COUNT: usize = 3;

pub fn process(accounts: &[AccountView], data: &[u8]) -> ProgramResult {
    if accounts.len() < ACCOUNT_COUNT {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let config = &accounts[0];
    let deployer = &accounts[1];
    let system_program = &accounts[2];

    // ---- system_program key guard --------------------------------------
    if system_program.address() != &SYSTEM_PROGRAM_ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    // ---- deployer signer/writable guard --------------------------------
    if !deployer.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !deployer.is_writable() {
        return Err(ProgramError::InvalidAccountData);
    }

    // Optional mainnet / devnet guard. Default build leaves this OFF so that
    // `cargo test` / localnet tests can use an arbitrary payer.
    #[cfg(feature = "enforce-deployer")]
    {
        use crate::error::PactError;
        use crate::DEPLOYER_PUBKEY;
        if deployer.address() != &DEPLOYER_PUBKEY {
            return Err(PactError::UnauthorizedDeployer.into());
        }
    }

    // ---- config PDA derivation + re-init guard -------------------------
    if !config.is_writable() {
        return Err(ProgramError::InvalidAccountData);
    }
    let (expected_pda, bump) = derive_protocol();
    if config.address() != &expected_pda {
        return Err(ProgramError::InvalidSeeds);
    }
    // Re-init attack: if the PDA already holds data the System Program
    // CreateAccount CPI below would fail with `AccountAlreadyInUse`, but we
    // reject up-front with a cleaner `AccountAlreadyInitialized` to match
    // the Anchor `init` semantics.
    if !config.is_data_empty() {
        return Err(ProgramError::AccountAlreadyInitialized);
    }

    // ---- parse args ----------------------------------------------------
    if data.len() != ARGS_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }
    let authority = read_address(&data[0..32]);
    let oracle = read_address(&data[32..64]);
    let treasury = read_address(&data[64..96]);
    let usdc_mint = read_address(&data[96..128]);

    // ---- CPI: System Program CreateAccount -----------------------------
    let rent = Rent::get()?;
    let lamports = rent.try_minimum_balance(ProtocolConfig::LEN)?;
    let bump_seed = [bump];
    let signer_seeds: [Seed; 2] = [Seed::from(PROTOCOL_SEED), Seed::from(&bump_seed[..])];

    create_account(
        deployer,
        config,
        lamports,
        ProtocolConfig::LEN as u64,
        &ID,
        &signer_seeds,
    )?;

    // ---- populate ProtocolConfig ---------------------------------------
    //
    // Newly-allocated account is zero-filled by the runtime, so the explicit
    // `_pad` / `_pad_tail` padding bytes are already correct. We only need to
    // write the discriminator and domain fields. Using a typed `&mut` via
    // `try_from_bytes_mut` would fail the discriminator check (it's still 0
    // from zero-fill, which happens to equal `ProtocolConfig::DISCRIMINATOR`
    // — so it would actually pass — but re-using the raw buffer is clearer
    // and avoids depending on that coincidence).
    {
        let mut data_ref = config.try_borrow_mut()?;
        let bytes: &mut [u8] = &mut data_ref;
        // Length asserts match what `create_account` just allocated. Belt &
        // suspenders: if these ever diverge we'd silently corrupt adjacent
        // fields through the raw slice writes below.
        if bytes.len() != ProtocolConfig::LEN {
            return Err(ProgramError::InvalidAccountData);
        }

        let cfg = ProtocolConfig::try_from_bytes_mut(bytes)?;
        cfg.discriminator = ProtocolConfig::DISCRIMINATOR;
        cfg.authority = authority;
        cfg.oracle = oracle;
        cfg.treasury = treasury;
        cfg.usdc_mint = usdc_mint;

        cfg.protocol_fee_bps = DEFAULT_PROTOCOL_FEE_BPS;
        cfg.min_pool_deposit = DEFAULT_MIN_POOL_DEPOSIT;
        cfg.default_insurance_rate_bps = DEFAULT_INSURANCE_RATE_BPS;
        cfg.default_max_coverage_per_call = DEFAULT_MAX_COVERAGE_PER_CALL;
        cfg.min_premium_bps = DEFAULT_MIN_PREMIUM_BPS;

        cfg.withdrawal_cooldown_seconds = DEFAULT_WITHDRAWAL_COOLDOWN;
        cfg.aggregate_cap_bps = DEFAULT_AGGREGATE_CAP_BPS;
        cfg.aggregate_cap_window_seconds = DEFAULT_AGGREGATE_CAP_WINDOW;

        cfg.claim_window_seconds = DEFAULT_CLAIM_WINDOW;
        cfg.max_claims_per_batch = DEFAULT_MAX_CLAIMS_PER_BATCH;

        cfg.paused = 0;
        cfg.bump = bump;
    }

    Ok(())
}

#[inline]
fn read_address(bytes: &[u8]) -> Address {
    let mut buf = [0u8; 32];
    buf.copy_from_slice(bytes);
    Address::new_from_array(buf)
}
