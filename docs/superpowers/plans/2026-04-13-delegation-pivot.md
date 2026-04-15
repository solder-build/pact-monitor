# Delegation Pivot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pivot the Policy lifecycle from a "prepaid balance" model to an SPL token delegation model so agents never deposit funds — their wallet balance ticks down per settlement instead.

**Architecture:** Agent grants the Pact program SPL token delegation via `spl_token::approve`. Policy account records the approved token account. Backend crank settles premiums by pulling tiny amounts directly from agent's ATA → pool vault (pool premium) and agent's ATA → treasury ATA (protocol fee), both signed by the pool PDA as delegate. Agent's USDC stays in their wallet until consumed; Phantom/any wallet shows the real, ticking-down balance.

**Tech Stack:** Anchor 1.0, anchor-spl 1.0, SPL Token Program (standard, not Token-2022), TypeScript tests via ts-mocha, solana-test-validator on localhost for testing.

**Spec:** `docs/superpowers/specs/2026-04-10-phase3-insurance-design.md` (will be updated in Task 1 of this plan)

**Main implementation plan:** `docs/superpowers/plans/2026-04-10-phase3-insurance-implementation.md` (Tasks 10 and 11 will be superseded by this pivot plan)

**Branch:** `feature/phase3-onchain-insurance`

---

## Context and Why This Pivot

Rick's feedback on 2026-04-12: the prepaid balance model has friction because agents see a chunk of USDC move into a vault upfront, then track a separate balance inside the policy. He wants the "pay per call" feel — balance ticks down per call, funds stay in the agent's wallet, no upfront deposit.

**Why SPL delegation works:**
Solana's SPL token program supports a delegate pattern: an owner grants another account (a delegate) permission to transfer up to N tokens from their account. The delegate can then execute transfers up to the approved amount without the owner re-signing. This is exactly what Uniswap, Jupiter, and every other Solana dapp uses when they say "approve". After the approved amount is consumed, the delegate clears and the owner must re-approve.

**Net effect for the agent:**
1. One-time `approve` signature grants Pact program permission to debit up to N USDC from their ATA
2. Agent makes API calls normally (no Solana tx per call)
3. Backend crank calls `settle_premium`, which (signed by the pool PDA as delegate) pulls premium amounts from agent's ATA
4. Agent's wallet balance visibly decreases in small increments — exactly the UX Rick wants
5. When approval runs out, SDK prompts for re-approval

**Scope of this pivot:**
- Spec: small edit in one section
- State: Policy account gains `agent_token_account`, loses `prepaid_balance`
- Instructions: `create_policy` is renamed and restructured to `enable_insurance`; `top_up` is deleted (replaced by plain SPL `approve` on the client side); `settle_premium` uses delegate transfer instead of vault deduction
- Tests: update existing test patterns to set up SPL approve before enabling insurance
- Devnet: upgrade the deployed program binary (one `anchor program deploy --upgrade`)

None of the existing deployed functionality is affected: ProtocolConfig, CoveragePool, UnderwriterPosition, deposit, withdraw, submit_claim, initialize_protocol, update_config, create_pool all stay the same.

---

## File Map

Files created or modified in this plan:

**Spec update (Task 1):**
- Modify: `docs/superpowers/specs/2026-04-10-phase3-insurance-design.md` — replace the Policy section and the `create_policy` / `top_up` / `settle_premium` instruction descriptions with delegation equivalents

**State changes (Task 2):**
- Modify: `packages/program/programs/pact-insurance/src/state.rs` — Policy struct: remove `prepaid_balance`, add `agent_token_account: Pubkey`

**Error additions (Task 2):**
- Modify: `packages/program/programs/pact-insurance/src/error.rs` — add `DelegationMissing`, `DelegationInsufficient`, `TokenAccountMismatch`

**Instructions (Tasks 3, 4):**
- Create: `packages/program/programs/pact-insurance/src/instructions/enable_insurance.rs`
- Create: `packages/program/programs/pact-insurance/src/instructions/settle_premium.rs`
- Modify: `packages/program/programs/pact-insurance/src/instructions/mod.rs` — register both
- Modify: `packages/program/programs/pact-insurance/src/lib.rs` — add entry-point functions

**Tests (Task 5):**
- Create: `packages/program/tests/policy.ts`
- Create: `packages/program/tests/settlement.ts`

**Deployment (Task 6):**
- No new files; runs `anchor program deploy --upgrade` and verifies on devnet

---

## Task 1: Update the design spec

**Files:**
- Modify: `docs/superpowers/specs/2026-04-10-phase3-insurance-design.md`

- [ ] **Step 1: Replace the Policy section**

Open the spec and find the `### Policy` section (around line 186-204 based on current spec layout). Replace it with:

```markdown
### Policy

Per-agent-per-pool. `seeds = ["policy", pool.key(), agent.key()]`.

```rust
#[account]
pub struct Policy {
    pub agent: Pubkey,
    pub pool: Pubkey,
    pub agent_id: String,                // max 64 chars
    pub agent_token_account: Pubkey,     // the agent's USDC ATA that was approved as delegate source
    pub total_premiums_paid: u64,
    pub total_claims_received: u64,
    pub calls_covered: u64,
    pub active: bool,
    pub created_at: i64,
    pub expires_at: i64,                 // 0 = never
    pub bump: u8,
}
```

**Delegation model (not prepaid):** An agent does NOT deposit USDC when enabling insurance. Instead, they call SPL `approve(delegate: pool_pda, amount: N)` on their USDC token account — this grants the pool PDA permission to transfer up to N USDC from the agent's ATA. The actual USDC stays in the agent's wallet.

When the crank calls `settle_premium`, it uses the pool PDA as the delegate to pull premium amounts directly from the agent's ATA into the pool vault (pool_premium) and treasury ATA (protocol_fee). The agent's wallet balance visibly decreases with each settlement — there is no separate "prepaid balance" to track.

**Why not prepaid:** Rick's 2026-04-12 feedback: agents should not see a chunk of USDC move into a vault upfront. They should see their wallet balance tick down per settlement, exactly like a prepaid phone. SPL token delegation delivers this without adding per-call on-chain overhead.
```

- [ ] **Step 2: Replace the `create_policy` instruction entry**

Find `### 6. \`create_policy\`` in the spec. Replace its entire subsection with:

```markdown
### 6. `enable_insurance`

**Signer:** agent.
**Args:** `agent_id: String`, `expires_at: i64`.
**Behavior:**
- Rejects if `config.paused`
- Rejects if policy already exists for this agent/pool pair (PDA collision)
- Validates that `agent_token_account.delegate == Some(pool_pda)` (agent must have done SPL approve first)
- Validates `agent_token_account.delegated_amount > 0`
- Validates `agent_token_account.owner == agent.key()`
- Validates `agent_token_account.mint == pool.usdc_mint`
- Creates `Policy` PDA, records `agent_token_account` pubkey, sets `active = true`

**SDK flow:** The agent SDK builds a single transaction containing two instructions:
1. `spl_token::approve` — sets `pool_pda` as delegate with an initial allowance (e.g., 10 USDC)
2. `enable_insurance` — creates the Policy PDA

Both signed by the agent in one atomic transaction.
```

- [ ] **Step 3: Delete the `top_up` instruction entry**

Find `### 7. \`top_up\`` in the spec. Delete the entire subsection — top-up is now a client-side operation (plain SPL `approve` with a new amount) and requires no Pact instruction.

- [ ] **Step 4: Replace the `settle_premium` instruction entry**

Find `### 8. \`settle_premium\`` in the spec. Replace its entire subsection with:

```markdown
### 7. `settle_premium`

**Signer:** `config.authority` (called by crank).
**Args:** `call_value: u64` (total x402 payment value since last settlement for this agent+pool).
**Accounts:** config, pool, vault, policy, agent_token_account, treasury_token_account, authority, token_program.
**Behavior:**
- Rejects if `!policy.active`
- Rejects if `agent_token_account.key() != policy.agent_token_account` (sanity check)
- Rejects if `agent_token_account.delegate != Some(pool.key())` (agent must still have an active delegation)
- Compute `gross_premium = call_value * pool.insurance_rate_bps / 10000`
- Cap `gross_premium` at `min(agent_token_account.delegated_amount, agent_token_account.amount)`
- If `gross_premium == 0`: return Ok (nothing to settle)
- Compute `protocol_fee = gross_premium * config.protocol_fee_bps / 10000`
- Compute `pool_premium = gross_premium - protocol_fee`
- Transfer `pool_premium` from `agent_token_account` → `vault` via delegate-signed SPL transfer (pool PDA as authority)
- If `protocol_fee > 0`: transfer `protocol_fee` from `agent_token_account` → `treasury_token_account` via delegate-signed SPL transfer
- `policy.total_premiums_paid += gross_premium`
- `pool.total_premiums_earned += pool_premium`
- `pool.total_available += pool_premium` (yield becomes underwriter capital)
- If `agent_token_account.delegated_amount` reaches 0 after the transfers: SPL token program auto-clears the delegate. Policy stays `active` but subsequent settlements will fail the delegation check until agent re-approves. Off-chain SDK should prompt the agent to re-approve when delegation is low.
```

- [ ] **Step 5: Renumber subsequent instructions**

In the spec's instruction list, the original numbering was:
1. `initialize_protocol`
2. `update_config`
3. `create_pool`
4. `deposit`
5. `withdraw`
6. `create_policy`
7. `top_up`
8. `settle_premium`
9. `update_rates`
10. `submit_claim`

New numbering (top_up removed, create_policy → enable_insurance):
1. `initialize_protocol`
2. `update_config`
3. `create_pool`
4. `deposit`
5. `withdraw`
6. `enable_insurance`
7. `settle_premium`
8. `update_rates`
9. `submit_claim`

Update the subsection headers in the spec to match.

- [ ] **Step 6: Commit the spec update**

```bash
git add docs/superpowers/specs/2026-04-10-phase3-insurance-design.md
git commit -m "docs(spec): pivot Policy lifecycle to SPL token delegation model

- Policy account: prepaid_balance -> agent_token_account (records delegated ATA)
- create_policy renamed to enable_insurance (expects prior SPL approve)
- top_up removed (now client-side plain SPL approve)
- settle_premium uses delegate transfer from agent ATA instead of vault deduction
- Agent's USDC stays in their wallet; balance ticks down per settlement
- Matches Rick's per-call UX intent without adding per-call on-chain overhead"
```

---

## Task 2: Update Policy account state and errors

**Files:**
- Modify: `packages/program/programs/pact-insurance/src/state.rs`
- Modify: `packages/program/programs/pact-insurance/src/error.rs`

- [ ] **Step 1: Read current state.rs**

```bash
cat packages/program/programs/pact-insurance/src/state.rs
```

As of this plan, state.rs only contains `ProtocolConfig`. The Policy, CoveragePool, UnderwriterPosition, and Claim structs have not been added yet — they come from later tasks in the main plan. This pivot plan assumes those structs will be added per the main plan EXCEPT the Policy struct, which this task defines.

- [ ] **Step 2: Append the Policy struct to state.rs**

Append the following to `packages/program/programs/pact-insurance/src/state.rs`:

```rust
use crate::constants::MAX_AGENT_ID_LEN;

#[account]
#[derive(InitSpace)]
pub struct Policy {
    pub agent: Pubkey,
    pub pool: Pubkey,
    #[max_len(MAX_AGENT_ID_LEN)]
    pub agent_id: String,
    pub agent_token_account: Pubkey,
    pub total_premiums_paid: u64,
    pub total_claims_received: u64,
    pub calls_covered: u64,
    pub active: bool,
    pub created_at: i64,
    pub expires_at: i64,
    pub bump: u8,
}

impl Policy {
    pub const SEED_PREFIX: &'static [u8] = b"policy";
}
```

Note: `MAX_AGENT_ID_LEN` already exists in `constants.rs`. The `#[max_len(...)]` attribute is required by Anchor's `InitSpace` derive for variable-length fields.

- [ ] **Step 3: Add delegation errors to error.rs**

Open `packages/program/programs/pact-insurance/src/error.rs` and add three new variants to the `PactError` enum, right after `PolicyAlreadyExists`:

```rust
    #[msg("Agent token account has no delegation set")]
    DelegationMissing,

    #[msg("Agent token account delegated amount is insufficient")]
    DelegationInsufficient,

    #[msg("Agent token account does not match policy")]
    TokenAccountMismatch,
```

- [ ] **Step 4: Verify state.rs and error.rs compile**

```bash
cd packages/program
cargo check --package pact-insurance 2>&1 | tail -10
cd ../..
```

Expected: compiles with warnings about unused imports/variants (they'll be used in later tasks). No hard errors.

- [ ] **Step 5: Commit**

```bash
git add packages/program/programs/pact-insurance/src/state.rs packages/program/programs/pact-insurance/src/error.rs
git commit -m "feat(program): add Policy account state and delegation errors

- Policy struct records agent_token_account (the SPL-approved ATA)
- No prepaid_balance field (delegation model, funds stay in agent wallet)
- New errors: DelegationMissing, DelegationInsufficient, TokenAccountMismatch"
```

---

## Task 3: Implement `enable_insurance` instruction

**Files:**
- Create: `packages/program/programs/pact-insurance/src/instructions/enable_insurance.rs`
- Modify: `packages/program/programs/pact-insurance/src/instructions/mod.rs`
- Modify: `packages/program/programs/pact-insurance/src/lib.rs`

- [ ] **Step 1: Write enable_insurance.rs**

Create `packages/program/programs/pact-insurance/src/instructions/enable_insurance.rs`:

```rust
use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};
use crate::state::{ProtocolConfig, CoveragePool, Policy};
use crate::constants::MAX_AGENT_ID_LEN;
use crate::error::PactError;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct EnableInsuranceArgs {
    pub agent_id: String,
    pub expires_at: i64,
}

#[derive(Accounts)]
#[instruction(args: EnableInsuranceArgs)]
pub struct EnableInsurance<'info> {
    #[account(
        seeds = [ProtocolConfig::SEED],
        bump = config.bump,
        constraint = !config.paused @ PactError::ProtocolPaused,
    )]
    pub config: Account<'info, ProtocolConfig>,

    #[account(
        seeds = [CoveragePool::SEED_PREFIX, pool.provider_hostname.as_bytes()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, CoveragePool>,

    #[account(
        init,
        payer = agent,
        space = 8 + Policy::INIT_SPACE,
        seeds = [
            Policy::SEED_PREFIX,
            pool.key().as_ref(),
            agent.key().as_ref()
        ],
        bump
    )]
    pub policy: Account<'info, Policy>,

    #[account(
        constraint = agent_token_account.owner == agent.key() @ PactError::Unauthorized,
        constraint = agent_token_account.mint == pool.usdc_mint @ PactError::TokenAccountMismatch,
        constraint = agent_token_account.delegate.is_some() @ PactError::DelegationMissing,
        constraint = agent_token_account.delegate.unwrap() == pool.key() @ PactError::DelegationMissing,
        constraint = agent_token_account.delegated_amount > 0 @ PactError::DelegationInsufficient,
    )]
    pub agent_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub agent: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<EnableInsurance>, args: EnableInsuranceArgs) -> Result<()> {
    require!(
        args.agent_id.len() <= MAX_AGENT_ID_LEN,
        PactError::AgentIdTooLong
    );

    let policy = &mut ctx.accounts.policy;
    let pool = &mut ctx.accounts.pool;
    let clock = Clock::get()?;

    policy.agent = ctx.accounts.agent.key();
    policy.pool = pool.key();
    policy.agent_id = args.agent_id;
    policy.agent_token_account = ctx.accounts.agent_token_account.key();
    policy.total_premiums_paid = 0;
    policy.total_claims_received = 0;
    policy.calls_covered = 0;
    policy.active = true;
    policy.created_at = clock.unix_timestamp;
    policy.expires_at = args.expires_at;
    policy.bump = ctx.bumps.policy;

    pool.active_policies = pool.active_policies.checked_add(1).unwrap();
    pool.updated_at = clock.unix_timestamp;

    Ok(())
}
```

Note: `Account<'info, TokenAccount>` reads the agent's SPL token account so we can check the delegate constraints. `agent_token_account.delegate` is a `COption<Pubkey>`, so we check `is_some()` before `unwrap()`.

Note: this task depends on `CoveragePool` being present in `state.rs`. If `CoveragePool` hasn't been added yet (main plan Task 7), add it first per the main plan before continuing. Without it, this instruction won't compile because the `pool` account constraint references `CoveragePool::SEED_PREFIX`, `pool.provider_hostname`, `pool.bump`, `pool.usdc_mint`, and `pool.active_policies`.

- [ ] **Step 2: Register in mod.rs**

Open `packages/program/programs/pact-insurance/src/instructions/mod.rs` and replace with:

```rust
pub mod initialize_protocol;
pub mod enable_insurance;

pub use initialize_protocol::*;
pub use enable_insurance::*;
```

- [ ] **Step 3: Register in lib.rs**

Open `packages/program/programs/pact-insurance/src/lib.rs` and add a new entry-point function inside `pub mod pact_insurance`, after the existing `initialize_protocol`:

```rust
    pub fn enable_insurance(
        ctx: Context<EnableInsurance>,
        args: EnableInsuranceArgs,
    ) -> Result<()> {
        instructions::enable_insurance::handler(ctx, args)
    }
```

- [ ] **Step 4: Build**

```bash
export PATH="$HOME/.cargo/bin:/Users/q3labsadmin/.local/share/solana/install/active_release/bin:$PATH"
cd packages/program
anchor build 2>&1 | tail -20
cd ../..
```

Expected: compiles. If it complains about missing `CoveragePool`, that struct needs to be added first (it's in main plan Task 7).

- [ ] **Step 5: Commit**

```bash
git add packages/program/programs/pact-insurance/src/instructions/enable_insurance.rs packages/program/programs/pact-insurance/src/instructions/mod.rs packages/program/programs/pact-insurance/src/lib.rs
git commit -m "feat(program): add enable_insurance instruction (delegation pattern)

Creates Policy PDA and validates agent's token account already has
pool_pda as delegate with non-zero delegated_amount. Agent must call
SPL approve first (client-side, in the same tx)."
```

---

## Task 4: Implement `settle_premium` instruction

**Files:**
- Create: `packages/program/programs/pact-insurance/src/instructions/settle_premium.rs`
- Modify: `packages/program/programs/pact-insurance/src/instructions/mod.rs`
- Modify: `packages/program/programs/pact-insurance/src/lib.rs`

- [ ] **Step 1: Write settle_premium.rs**

Create `packages/program/programs/pact-insurance/src/instructions/settle_premium.rs`:

```rust
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::state::{ProtocolConfig, CoveragePool, Policy};
use crate::error::PactError;

#[derive(Accounts)]
pub struct SettlePremium<'info> {
    #[account(
        seeds = [ProtocolConfig::SEED],
        bump = config.bump,
        has_one = authority @ PactError::Unauthorized,
    )]
    pub config: Account<'info, ProtocolConfig>,

    #[account(
        mut,
        seeds = [CoveragePool::SEED_PREFIX, pool.provider_hostname.as_bytes()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, CoveragePool>,

    #[account(
        mut,
        seeds = [CoveragePool::VAULT_SEED_PREFIX, pool.key().as_ref()],
        bump,
        constraint = vault.mint == pool.usdc_mint,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [
            Policy::SEED_PREFIX,
            pool.key().as_ref(),
            policy.agent.as_ref()
        ],
        bump = policy.bump,
        constraint = policy.active @ PactError::PolicyInactive,
        constraint = policy.pool == pool.key(),
    )]
    pub policy: Account<'info, Policy>,

    #[account(
        mut,
        constraint = agent_token_account.key() == policy.agent_token_account @ PactError::TokenAccountMismatch,
        constraint = agent_token_account.mint == pool.usdc_mint @ PactError::TokenAccountMismatch,
    )]
    pub agent_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = treasury_token_account.mint == pool.usdc_mint,
        constraint = treasury_token_account.owner == config.treasury,
    )]
    pub treasury_token_account: Account<'info, TokenAccount>,

    pub authority: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<SettlePremium>, call_value: u64) -> Result<()> {
    require!(call_value > 0, PactError::ZeroAmount);

    // Validate delegation is still present
    let agent_ata = &ctx.accounts.agent_token_account;
    require!(
        agent_ata.delegate.is_some(),
        PactError::DelegationMissing
    );
    require!(
        agent_ata.delegate.unwrap() == ctx.accounts.pool.key(),
        PactError::DelegationMissing
    );

    let pool = &ctx.accounts.pool;
    let config = &ctx.accounts.config;

    // Compute gross premium
    let mut gross_premium = (call_value as u128)
        .checked_mul(pool.insurance_rate_bps as u128)
        .ok_or(PactError::ArithmeticOverflow)?
        .checked_div(10_000)
        .ok_or(PactError::ArithmeticOverflow)? as u64;

    // Cap at delegated amount and agent's actual balance
    if gross_premium > agent_ata.delegated_amount {
        gross_premium = agent_ata.delegated_amount;
    }
    if gross_premium > agent_ata.amount {
        gross_premium = agent_ata.amount;
    }

    if gross_premium == 0 {
        return Ok(());
    }

    // Compute split
    let protocol_fee = (gross_premium as u128)
        .checked_mul(config.protocol_fee_bps as u128)
        .ok_or(PactError::ArithmeticOverflow)?
        .checked_div(10_000)
        .ok_or(PactError::ArithmeticOverflow)? as u64;
    let pool_premium = gross_premium
        .checked_sub(protocol_fee)
        .ok_or(PactError::ArithmeticOverflow)?;

    // Build signer seeds for pool PDA (acting as delegate)
    let hostname_bytes = pool.provider_hostname.as_bytes().to_vec();
    let pool_bump = pool.bump;
    let seeds: &[&[u8]] = &[
        CoveragePool::SEED_PREFIX,
        &hostname_bytes,
        &[pool_bump],
    ];
    let signer_seeds = &[seeds];

    // Transfer pool_premium from agent ATA → pool vault (pool PDA signs as delegate)
    if pool_premium > 0 {
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.agent_token_account.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.pool.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(cpi_ctx, pool_premium)?;
    }

    // Transfer protocol_fee from agent ATA → treasury (pool PDA signs as delegate)
    if protocol_fee > 0 {
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.agent_token_account.to_account_info(),
                to: ctx.accounts.treasury_token_account.to_account_info(),
                authority: ctx.accounts.pool.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(cpi_ctx, protocol_fee)?;
    }

    // Update state
    let pool = &mut ctx.accounts.pool;
    let policy = &mut ctx.accounts.policy;
    let clock = Clock::get()?;

    policy.total_premiums_paid = policy
        .total_premiums_paid
        .checked_add(gross_premium)
        .unwrap();

    pool.total_premiums_earned = pool
        .total_premiums_earned
        .checked_add(pool_premium)
        .unwrap();
    pool.total_available = pool.total_available.checked_add(pool_premium).unwrap();
    pool.updated_at = clock.unix_timestamp;

    // Note: policy stays active even if delegated_amount reaches 0.
    // Subsequent settle_premium calls will fail the DelegationMissing check
    // (because SPL clears the delegate once delegated_amount hits 0).
    // The SDK should prompt agent to re-approve before that happens.

    Ok(())
}
```

- [ ] **Step 2: Register in mod.rs**

Update `packages/program/programs/pact-insurance/src/instructions/mod.rs`:

```rust
pub mod initialize_protocol;
pub mod enable_insurance;
pub mod settle_premium;

pub use initialize_protocol::*;
pub use enable_insurance::*;
pub use settle_premium::*;
```

- [ ] **Step 3: Register in lib.rs**

Add to `lib.rs` inside `pub mod pact_insurance`:

```rust
    pub fn settle_premium(ctx: Context<SettlePremium>, call_value: u64) -> Result<()> {
        instructions::settle_premium::handler(ctx, call_value)
    }
```

- [ ] **Step 4: Build**

```bash
export PATH="$HOME/.cargo/bin:/Users/q3labsadmin/.local/share/solana/install/active_release/bin:$PATH"
cd packages/program
anchor build 2>&1 | tail -20
cd ../..
```

Expected: compiles.

- [ ] **Step 5: Commit**

```bash
git add packages/program/programs/pact-insurance/src/instructions/settle_premium.rs packages/program/programs/pact-insurance/src/instructions/mod.rs packages/program/programs/pact-insurance/src/lib.rs
git commit -m "feat(program): add settle_premium instruction (delegate transfer)

Crank-signed instruction. Pool PDA acts as SPL delegate, pulls
premium from agent's token account and splits into pool vault
(pool_premium) and treasury (protocol_fee). Validates delegation
is still present; returns early if delegated amount is 0."
```

---

## Task 5: Write integration tests for the delegation flow

**Files:**
- Create: `packages/program/tests/policy.ts`
- Create: `packages/program/tests/settlement.ts`

**Dependency note:** These tests require CoveragePool, `create_pool`, and `deposit` to be implemented. If they haven't been added yet per the main plan (Tasks 7 and 8), add those first.

- [ ] **Step 1: Write policy.ts (enable_insurance flow)**

Create `packages/program/tests/policy.ts`:

```typescript
import * as anchor from "@anchor-lang/core";
import { Program, BN } from "@anchor-lang/core";
import { PactInsurance } from "../target/types/pact_insurance";
import { PublicKey, Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  createApproveInstruction,
  getAccount,
} from "@solana/spl-token";
import { expect } from "chai";

describe("pact-insurance: enable_insurance (delegation)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.PactInsurance as Program<PactInsurance>;

  let usdcMint: PublicKey;
  const hostname = "policy-delegation-test.example.com";
  let protocolPda: PublicKey;
  let poolPda: PublicKey;
  let vaultPda: PublicKey;
  let policyPda: PublicKey;
  const oracle = Keypair.generate();
  const agent = Keypair.generate();
  let agentAta: PublicKey;

  before(async () => {
    [protocolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("protocol")],
      program.programId
    );

    usdcMint = await createMint(
      provider.connection,
      (provider.wallet as anchor.Wallet).payer,
      provider.wallet.publicKey,
      null,
      6
    );

    // Init protocol if not already. Authority = oracle.
    try {
      await program.methods
        .initializeProtocol({
          authority: oracle.publicKey,
          treasury: provider.wallet.publicKey,
          usdcMint,
        })
        .accounts({
          config: protocolPda,
          deployer: provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    } catch (_) {
      // already initialized in a previous test run
    }

    // Update config to point at this mint + oracle
    // (safe even on a reused devnet validator because authority check uses oracle signer)
    try {
      await program.methods
        .updateConfig({
          protocolFeeBps: null, minPoolDeposit: null, defaultInsuranceRateBps: null,
          defaultMaxCoveragePerCall: null, minPremiumBps: null,
          withdrawalCooldownSeconds: null, aggregateCapBps: null,
          aggregateCapWindowSeconds: null, claimWindowSeconds: null,
          maxClaimsPerBatch: null, paused: null, treasury: null, usdcMint,
        })
        .accounts({ config: protocolPda, authority: oracle.publicKey })
        .signers([oracle])
        .rpc();
    } catch (_) {}

    [poolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), Buffer.from(hostname)],
      program.programId
    );
    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), poolPda.toBuffer()],
      program.programId
    );
    [policyPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("policy"), poolPda.toBuffer(), agent.publicKey.toBuffer()],
      program.programId
    );

    // Oracle creates pool
    const airdrop = await provider.connection.requestAirdrop(oracle.publicKey, 2_000_000_000);
    await provider.connection.confirmTransaction(airdrop);

    await program.methods
      .createPool({
        providerHostname: hostname,
        insuranceRateBps: null,
        maxCoveragePerCall: null,
      })
      .accounts({
        config: protocolPda, pool: poolPda, vault: vaultPda, usdcMint,
        authority: oracle.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([oracle])
      .rpc();

    // Fund agent, create ATA, mint USDC
    const sig = await provider.connection.requestAirdrop(agent.publicKey, 2_000_000_000);
    await provider.connection.confirmTransaction(sig);
    agentAta = await createAccount(provider.connection, agent, usdcMint, agent.publicKey);
    await mintTo(
      provider.connection,
      (provider.wallet as anchor.Wallet).payer,
      usdcMint,
      agentAta,
      provider.wallet.publicKey,
      50_000_000 // 50 USDC in agent wallet
    );
  });

  it("fails enable_insurance without prior SPL approve", async () => {
    try {
      await program.methods
        .enableInsurance({
          agentId: "agent-no-approve",
          expiresAt: new BN(0),
        })
        .accounts({
          config: protocolPda,
          pool: poolPda,
          policy: policyPda,
          agentTokenAccount: agentAta,
          agent: agent.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([agent])
        .rpc();
      expect.fail("should have rejected without delegation");
    } catch (err: any) {
      expect(String(err)).to.match(/DelegationMissing/);
    }
  });

  it("enables insurance after SPL approve to pool PDA", async () => {
    // Client-side: build a single tx with approve + enable_insurance
    const approveIx = createApproveInstruction(
      agentAta,
      poolPda, // delegate
      agent.publicKey,
      10_000_000 // 10 USDC allowance
    );

    const enableIx = await program.methods
      .enableInsurance({
        agentId: "agent-with-approve",
        expiresAt: new BN(0),
      })
      .accounts({
        config: protocolPda,
        pool: poolPda,
        policy: policyPda,
        agentTokenAccount: agentAta,
        agent: agent.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx = new Transaction().add(approveIx).add(enableIx);
    await provider.sendAndConfirm(tx, [agent]);

    const policy = await program.account.policy.fetch(policyPda);
    expect(policy.agent.toString()).to.equal(agent.publicKey.toString());
    expect(policy.agentId).to.equal("agent-with-approve");
    expect(policy.agentTokenAccount.toString()).to.equal(agentAta.toString());
    expect(policy.active).to.equal(true);
    expect(policy.totalPremiumsPaid.toNumber()).to.equal(0);

    // Verify agent's token account balance is UNCHANGED (delegation, not transfer)
    const agentAcc = await getAccount(provider.connection, agentAta);
    expect(Number(agentAcc.amount)).to.equal(50_000_000);
    expect(agentAcc.delegate?.toString()).to.equal(poolPda.toString());
    expect(Number(agentAcc.delegatedAmount)).to.equal(10_000_000);
  });
});
```

- [ ] **Step 2: Write settlement.ts (settle_premium flow)**

Create `packages/program/tests/settlement.ts`:

```typescript
import * as anchor from "@anchor-lang/core";
import { Program, BN } from "@anchor-lang/core";
import { PactInsurance } from "../target/types/pact_insurance";
import { PublicKey, Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  createApproveInstruction,
  getAccount,
} from "@solana/spl-token";
import { expect } from "chai";

describe("pact-insurance: settle_premium (delegate transfer)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.PactInsurance as Program<PactInsurance>;

  let usdcMint: PublicKey;
  const hostname = "settle-delegation-test.example.com";
  let protocolPda: PublicKey;
  let poolPda: PublicKey;
  let vaultPda: PublicKey;
  let policyPda: PublicKey;
  let treasuryAta: PublicKey;
  const oracle = Keypair.generate();
  const agent = Keypair.generate();
  let agentAta: PublicKey;

  before(async () => {
    [protocolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("protocol")],
      program.programId
    );

    usdcMint = await createMint(
      provider.connection,
      (provider.wallet as anchor.Wallet).payer,
      provider.wallet.publicKey,
      null,
      6
    );

    // Init / re-target protocol
    try {
      await program.methods
        .initializeProtocol({
          authority: oracle.publicKey,
          treasury: provider.wallet.publicKey,
          usdcMint,
        })
        .accounts({
          config: protocolPda,
          deployer: provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    } catch (_) {}

    try {
      await program.methods
        .updateConfig({
          protocolFeeBps: null, minPoolDeposit: null, defaultInsuranceRateBps: null,
          defaultMaxCoveragePerCall: null, minPremiumBps: null,
          withdrawalCooldownSeconds: null, aggregateCapBps: null,
          aggregateCapWindowSeconds: null, claimWindowSeconds: null,
          maxClaimsPerBatch: null, paused: null,
          treasury: provider.wallet.publicKey, usdcMint,
        })
        .accounts({ config: protocolPda, authority: oracle.publicKey })
        .signers([oracle])
        .rpc();
    } catch (_) {}

    // Treasury ATA
    treasuryAta = await createAccount(
      provider.connection,
      (provider.wallet as anchor.Wallet).payer,
      usdcMint,
      provider.wallet.publicKey
    );

    [poolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), Buffer.from(hostname)],
      program.programId
    );
    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), poolPda.toBuffer()],
      program.programId
    );
    [policyPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("policy"), poolPda.toBuffer(), agent.publicKey.toBuffer()],
      program.programId
    );

    // Oracle creates pool
    const airdrop = await provider.connection.requestAirdrop(oracle.publicKey, 2_000_000_000);
    await provider.connection.confirmTransaction(airdrop);

    await program.methods
      .createPool({
        providerHostname: hostname,
        insuranceRateBps: null,
        maxCoveragePerCall: null,
      })
      .accounts({
        config: protocolPda, pool: poolPda, vault: vaultPda, usdcMint,
        authority: oracle.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([oracle])
      .rpc();

    // Fund agent and create ATA
    const sig = await provider.connection.requestAirdrop(agent.publicKey, 2_000_000_000);
    await provider.connection.confirmTransaction(sig);
    agentAta = await createAccount(provider.connection, agent, usdcMint, agent.publicKey);
    await mintTo(
      provider.connection,
      (provider.wallet as anchor.Wallet).payer,
      usdcMint,
      agentAta,
      provider.wallet.publicKey,
      50_000_000 // 50 USDC
    );

    // Agent: approve + enable_insurance in one tx
    const approveIx = createApproveInstruction(
      agentAta,
      poolPda,
      agent.publicKey,
      10_000_000
    );
    const enableIx = await program.methods
      .enableInsurance({
        agentId: "settle-agent",
        expiresAt: new BN(0),
      })
      .accounts({
        config: protocolPda,
        pool: poolPda,
        policy: policyPda,
        agentTokenAccount: agentAta,
        agent: agent.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    await provider.sendAndConfirm(new Transaction().add(approveIx).add(enableIx), [agent]);
  });

  it("settles premium by pulling from agent ATA (not from a vault balance)", async () => {
    const beforeAgent = await getAccount(provider.connection, agentAta);
    const beforeVault = await getAccount(provider.connection, vaultPda);
    const beforeTreasury = await getAccount(provider.connection, treasuryAta);

    // call_value = 4 USDC (4_000_000 lamports), rate = 25 bps
    // gross_premium = 4_000_000 * 25 / 10000 = 10_000 (0.01 USDC)
    // protocol_fee = 10_000 * 1500 / 10000 = 1500
    // pool_premium = 10_000 - 1500 = 8500
    await program.methods
      .settlePremium(new BN(4_000_000))
      .accounts({
        config: protocolPda,
        pool: poolPda,
        vault: vaultPda,
        policy: policyPda,
        agentTokenAccount: agentAta,
        treasuryTokenAccount: treasuryAta,
        authority: oracle.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([oracle])
      .rpc();

    const afterAgent = await getAccount(provider.connection, agentAta);
    const afterVault = await getAccount(provider.connection, vaultPda);
    const afterTreasury = await getAccount(provider.connection, treasuryAta);

    expect(Number(beforeAgent.amount) - Number(afterAgent.amount)).to.equal(10_000);
    expect(Number(afterVault.amount) - Number(beforeVault.amount)).to.equal(8500);
    expect(Number(afterTreasury.amount) - Number(beforeTreasury.amount)).to.equal(1500);

    // Delegated amount also decreased
    expect(Number(beforeAgent.delegatedAmount) - Number(afterAgent.delegatedAmount)).to.equal(10_000);

    // Policy state
    const policy = await program.account.policy.fetch(policyPda);
    expect(policy.totalPremiumsPaid.toNumber()).to.equal(10_000);

    // Pool state
    const pool = await program.account.coveragePool.fetch(poolPda);
    expect(pool.totalPremiumsEarned.toNumber()).to.equal(8500);
    expect(pool.totalAvailable.toNumber()).to.equal(8500);
  });

  it("rejects settle_premium when authority is wrong", async () => {
    const rando = Keypair.generate();
    const airdrop = await provider.connection.requestAirdrop(rando.publicKey, 1_000_000_000);
    await provider.connection.confirmTransaction(airdrop);

    try {
      await program.methods
        .settlePremium(new BN(1_000_000))
        .accounts({
          config: protocolPda,
          pool: poolPda,
          vault: vaultPda,
          policy: policyPda,
          agentTokenAccount: agentAta,
          treasuryTokenAccount: treasuryAta,
          authority: rando.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([rando])
        .rpc();
      expect.fail("should have rejected");
    } catch (err: any) {
      expect(String(err)).to.match(/Unauthorized|has_one/i);
    }
  });
});
```

- [ ] **Step 3: Start local validator**

In a separate terminal (or background), start the validator:

```bash
export PATH="/Users/q3labsadmin/.local/share/solana/install/active_release/bin:$PATH"
cd /tmp
solana-test-validator --reset --quiet
```

Wait until `solana cluster-version --url http://127.0.0.1:8899` returns a version, then airdrop to the wallet:

```bash
solana airdrop 10 --url http://127.0.0.1:8899
```

- [ ] **Step 4: Run the new tests**

```bash
export PATH="$HOME/.cargo/bin:/Users/q3labsadmin/.local/share/solana/install/active_release/bin:$PATH"
cd packages/program
anchor test --skip-local-validator 2>&1 | tail -40
cd ../..
```

Expected: existing `protocol.ts` tests still pass + 2 new tests in `policy.ts` pass + 2 new tests in `settlement.ts` pass. Total 6+ passing tests.

- [ ] **Step 5: Kill the validator and commit**

```bash
pkill -f solana-test-validator
git add packages/program/tests/policy.ts packages/program/tests/settlement.ts
git commit -m "test(program): add integration tests for enable_insurance and settle_premium

- policy.ts: rejects enable_insurance without prior SPL approve;
  accepts enable_insurance with approve + enable in one tx;
  verifies agent USDC balance unchanged (delegation only).
- settlement.ts: settles premium by pulling from agent ATA (not vault);
  verifies 15% fee split (1500 to treasury, 8500 to pool vault);
  verifies delegated_amount decremented; rejects wrong authority."
```

---

## Task 6: Upgrade program on devnet and verify

**Files:** no new files; uses existing `anchor program deploy --upgrade` mechanism.

**Prerequisites:**
- Phantom wallet keypair at `~/.config/solana/phantom-devnet.json` has been imported and funded (done yesterday)
- Phantom wallet is the upgrade authority on the deployed program (done yesterday)
- Phantom wallet has at least 2 SOL on devnet (for rent of any new account data)

- [ ] **Step 1: Build the program with all new instructions**

```bash
export PATH="$HOME/.cargo/bin:/Users/q3labsadmin/.local/share/solana/install/active_release/bin:$PATH"
cd packages/program
anchor build 2>&1 | tail -10
cd ../..
```

Expected: build succeeds. IDL regenerates at `target/idl/pact_insurance.json`.

- [ ] **Step 2: Check devnet balance**

```bash
solana balance --keypair ~/.config/solana/phantom-devnet.json --url devnet
```

If under 2 SOL, fund via https://faucet.solana.com/ with the Phantom pubkey before proceeding.

- [ ] **Step 3: Upgrade the devnet program**

```bash
anchor program deploy --provider.cluster devnet --provider.wallet ~/.config/solana/phantom-devnet.json
```

Anchor will detect the existing program at that ID and perform an upgrade (not a new deploy). Expected output: "Program Id: 4Z1Y3W49U2Cn6bz9UpkahVP7LaeobQ4cAaEt3uNaqSob" and success.

**IMPORTANT GOTCHA:** Do not pass both `--provider.cluster devnet` and `--provider.wallet` on separate lines — the shell will split them into two commands. Keep it one line.

- [ ] **Step 4: Verify the new IDL is on-chain**

```bash
anchor idl fetch --provider.cluster devnet 4Z1Y3W49U2Cn6bz9UpkahVP7LaeobQ4cAaEt3uNaqSob | head -30
```

Expected: JSON starts with `"name": "pact_insurance"` and includes `enable_insurance` and `settle_premium` in the `instructions` array.

If the IDL on-chain is out of date, push it:

```bash
anchor idl upgrade --provider.cluster devnet --provider.wallet ~/.config/solana/phantom-devnet.json --filepath target/idl/pact_insurance.json 4Z1Y3W49U2Cn6bz9UpkahVP7LaeobQ4cAaEt3uNaqSob
```

- [ ] **Step 5: Run init-devnet.ts (only if protocol is not already initialized)**

```bash
cd packages/program
npx tsx scripts/init-devnet.ts
cd ../..
```

Expected: either "Protocol already initialized" (with the existing config printed) or "Initialized" followed by the new config. Either is fine — the program upgrade doesn't reset the ProtocolConfig PDA.

- [ ] **Step 6: Manually run a delegation flow on devnet (smoke test)**

Not part of this plan — will be covered by the main plan's simulation integration tests. For now, the unit tests on localnet + successful program upgrade is sufficient.

---

## Self-Review

**Coverage check:**
- [x] Spec updated to describe delegation model (Task 1)
- [x] Policy struct updated (Task 2)
- [x] Delegation errors added (Task 2)
- [x] `enable_insurance` instruction (Task 3)
- [x] `settle_premium` instruction (Task 4)
- [x] `top_up` removed (Task 1 via spec delete, no instruction to write)
- [x] Tests cover: missing delegation, successful enable, settle math, wrong authority rejection (Task 5)
- [x] Devnet program upgrade (Task 6)
- [x] IDL refreshed on devnet (Task 6 Step 4)

**Placeholder scan:** No TBD/TODO/fill-in placeholders. All code complete.

**Type consistency:**
- `Policy.agent_token_account: Pubkey` — referenced consistently in enable_insurance, settle_premium, and both tests
- `PactError::DelegationMissing`, `DelegationInsufficient`, `TokenAccountMismatch` — defined in Task 2, used in Tasks 3 and 4
- `EnableInsuranceArgs { agent_id, expires_at }` — used in Task 3 instruction and Task 5 test
- Pool PDA signs as delegate using seeds `[b"pool", hostname_bytes, &[bump]]` — consistent across settle_premium and any future uses

**Known gaps:**
- Main plan Task 7 (`CoveragePool` state + `create_pool`) and Task 8 (`UnderwriterPosition` + `deposit`) must be completed before this pivot plan's Tasks 3-6, because the instructions in this plan reference `CoveragePool`, its seeds, its fields, and expect a pool to already exist in tests.
- If a subagent runs this pivot plan BEFORE those main-plan tasks, it will hit compile errors. The fix: do main plan Tasks 7 and 8 first, then this pivot plan (Tasks 1-6), then resume main plan Task 12 onward.
- Main plan's Task 9 (`withdraw`) is independent — can be done in any order relative to this pivot.

---

## Execution Order

### Already complete (do not re-do)

These were finished in the Friday 2026-04-10 session and the Sunday 2026-04-13 morning session. Do not include them in any subagent dispatch:

| Main plan task | Status | Commit |
|---|---|---|
| 0: Solana CLI + Anchor + dev keypair + oracle keypair + .gitignore | ✓ done | `0ac127e` (gitignore); keypairs in `~/.config/solana/id.json` and `packages/backend/.secrets/oracle-keypair.json` |
| 1: Anchor scaffold | ✓ done | `55cb581` |
| 2: constants.rs | ✓ done | `1cb2d96` |
| 3: error.rs (PactError enum) | ✓ done | `6c0e8f7` |
| 4: state.rs / ProtocolConfig only | ✓ done | `c7155cc` |
| 5: initialize_protocol + tests | ✓ done | `cc96962` (initial), `c99e31e` (split deployer/authority refactor) |
| Plus: Phantom wallet imported, devnet program deployed, init-devnet.ts script written | ✓ done | `ae71747` |

**Caveats from Friday/Sunday work:**
- The deployed devnet program currently only knows `initialize_protocol`. Every other instruction in this pivot plan (and the main plan) requires a `anchor program deploy --upgrade`.
- `init-devnet.ts` was written but **never run** — the ProtocolConfig PDA does NOT exist on devnet yet. It will be created during the final devnet verification step (this pivot plan Task 6, Step 5).
- Anchor 1.0 is installed (not 0.31). `@anchor-lang/core` is the TS client (not `@coral-xyz/anchor`). The `instructions/` directory pattern is in use (not single `instructions.rs`). Local validator workaround: `solana-test-validator` + `cluster = "http://127.0.0.1:8899"` in `Anchor.toml` + `anchor test --skip-local-validator`.

### Remaining sequence

Each step lists which plan it comes from. The main plan is `2026-04-10-phase3-insurance-implementation.md`; pivot is this file.

| # | Source | Task | Why this order |
|---|---|---|---|
| 1 | Pivot | Task 1 (update spec) | Standalone, do first to lock the design contract |
| 2 | Main | Task 6 (update_config) | Independent of pivot, prerequisite for all `update_config` calls in tests |
| 3 | Main | Task 7 (CoveragePool + create_pool) | Required by pivot Tasks 3-5 (Policy depends on CoveragePool struct) |
| 4 | Main | Task 8 (UnderwriterPosition + deposit) | Required by pivot Task 5 tests (need a deposited pool) |
| 5 | Main | Task 9 (withdraw) | Slots in here naturally after Task 8 |
| 6 | Pivot | Task 2 (Policy state + delegation errors) | Refactor of main plan Task 10's state changes |
| 7 | Pivot | Task 3 (enable_insurance) | Replaces main plan Task 10's create_policy/top_up |
| 8 | Pivot | Task 4 (settle_premium) | Replaces main plan Task 11's settle_premium |
| 9 | Main | Task 12 (update_rates) | Independent, can come before or after pivot tasks |
| 10 | Main | Task 13 (submit_claim) | Final program instruction |
| 11 | Pivot | Task 5 (delegation integration tests) | Now that all instructions exist, run the e2e test |
| 12 | Pivot | Task 6 (upgrade devnet program + run init-devnet.ts) | Pushes new binary to devnet, creates ProtocolConfig PDA |
| 13 | Main | Task 14 (finalize devnet — verify deployment) | Sanity check, additional pools |
| 14+ | Main | Tasks 15-42 (backend integration, SDK, scorecard, simulation) | Main plan continues unchanged |

### What changes from the original main plan

The pivot plan **replaces** the following from the main plan:
- Main plan Task 10's policy lifecycle code (create_policy + top_up) → pivot Tasks 2 + 3
- Main plan Task 11's settle_premium → pivot Task 4
- Spec's Policy section + create_policy/top_up/settle_premium subsections → pivot Task 1

Everything else in the main plan is **untouched** — backend, SDK, monitor, scorecard, and simulation tests work the same way, with minor copy/UX changes (call it "approval remaining" instead of "prepaid balance" in user-facing strings). The backend's `claim-settlement.ts` and crank loops also need small updates (the `settle_premium` accounts list now includes `agent_token_account` and `treasury_token_account`), but those are mechanical updates done in main plan Tasks 17 and 20.
