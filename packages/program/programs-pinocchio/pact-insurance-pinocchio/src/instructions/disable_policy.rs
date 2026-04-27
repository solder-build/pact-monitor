//! `disable_policy` (discriminator 6) — Pinocchio port.
//!
//! Agent-initiated flag flip: sets `policy.active = 0` and decrements
//! `pool.active_policies` with `saturating_sub(1)`. No CPIs, no account
//! creation, no payload. The Anchor source of truth is
//! `packages/program/programs/pact-insurance/src/instructions/disable_policy.rs`
//! and the binding constraints live in spec §3.7.
//!
//! ### Why `saturating_sub` (not `checked_sub`)
//! Anchor's handler uses `saturating_sub(1)`, so a hypothetically-corrupted
//! pool counter (already at zero when a disable lands) silently clamps at 0
//! rather than erroring. The port preserves this exactly — no new PactError
//! variant, no semantic drift. Tests against H-05 rely on the bookkeeping
//! staying in lock-step with Anchor's.
//!
//! ### Validation (matches Anchor `has_one = agent` + `constraint`s)
//! 1. `agent.is_signer()` — missing signature → `MissingRequiredSignature`.
//! 2. `pool` and `policy` writable — else `InvalidAccountData`.
//! 3. Both owned by this program — `PactError::Unauthorized` (6018) on mismatch.
//! 4. `policy.pool == pool.key()` — guards against a policy for a different
//!    pool being passed in (cross-pool swap). → `PactError::Unauthorized` (6018)
//!    to match Anchor's `constraint = policy.pool == pool.key()` semantics.
//! 5. `policy.agent == agent.key()` — the `has_one = agent` rule; Anchor maps
//!    this to `PactError::Unauthorized` (6018).
//! 6. `policy.active == 1` — Anchor's `constraint = policy.active @
//!    PactError::PolicyInactive` (6006) — idempotent-disable is an error here,
//!    preserve that.
//!
//! Accounts (order matches the Anchor builder):
//!   0. `pool`   — writable, PDA `[b"pool", hostname]`
//!   1. `policy` — writable, PDA `[b"policy", pool, agent]`
//!   2. `agent`  — signer (must equal `policy.agent`)

use pinocchio::{account::AccountView, error::ProgramError, ProgramResult};

use crate::{error::PactError, state::{CoveragePool, Policy}};

const ACCOUNT_COUNT: usize = 3;

pub fn process(accounts: &[AccountView], data: &[u8]) -> ProgramResult {
    if accounts.len() < ACCOUNT_COUNT {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if !data.is_empty() {
        return Err(ProgramError::InvalidInstructionData);
    }

    let pool_acct = &accounts[0];
    let policy_acct = &accounts[1];
    let agent_acct = &accounts[2];

    // ---- structural guards --------------------------------------------------
    if !agent_acct.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !pool_acct.is_writable() || !policy_acct.is_writable() {
        return Err(ProgramError::InvalidAccountData);
    }

    // ---- ownership guards ---------------------------------------------------
    if !pool_acct.owned_by(&crate::ID) || !policy_acct.owned_by(&crate::ID) {
        return Err(PactError::Unauthorized.into());
    }

    // ---- policy.pool / policy.agent / policy.active checks ------------------
    {
        let policy_data = policy_acct.try_borrow()?;
        let policy = Policy::try_from_bytes(&policy_data)?;
        if policy.pool != *pool_acct.address() {
            return Err(PactError::Unauthorized.into());
        }
        if policy.agent != *agent_acct.address() {
            return Err(PactError::Unauthorized.into());
        }
        if policy.active == 0 {
            return Err(PactError::PolicyInactive.into());
        }
    }

    // ---- mutation: policy.active = 0 ----------------------------------------
    {
        let mut policy_data = policy_acct.try_borrow_mut()?;
        let policy = Policy::try_from_bytes_mut(&mut policy_data)?;
        policy.active = 0;
    }

    // ---- pool.active_policies = saturating_sub(1) ---------------------------
    {
        let mut pool_data = pool_acct.try_borrow_mut()?;
        let pool = CoveragePool::try_from_bytes_mut(&mut pool_data)?;
        pool.active_policies = pool.active_policies.saturating_sub(1);
    }

    Ok(())
}
