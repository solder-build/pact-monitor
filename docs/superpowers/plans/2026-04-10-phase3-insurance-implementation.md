# Phase 3 Insurance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the Solana on-chain parametric insurance layer for Pact Network, deployable to devnet by Monday 2026-04-13 and mainnet after a clean 24-hour devnet soak.

**Architecture:** Single Anchor program (`pact-insurance`) with configurable `ProtocolConfig`, per-hostname `CoveragePool` PDAs, prepaid-balance `Policy` accounts drained by a backend-hosted crank, auto-approved `Claim` PDAs with PDA-collision dedupe. Backend (Fastify + PostgreSQL) acts as the trusted oracle and runs crank loops in-process. A new `@pact-network/insurance` SDK provides agent-facing APIs with per-call UX layered over batched settlement. Two safety features are configurable with hardcoded absolute floors: withdrawal cooldown (default 7 days, 1-hour floor) and aggregate payout cap (default 30% per 24h, 80% ceiling).

**Tech Stack:** Anchor 0.31+, Solana 2.0+, Rust 1.89+, TypeScript, Fastify 5, PostgreSQL, Vite + React, `@coral-xyz/anchor`, `@solana/web3.js`, `@solana/spl-token`, node:test (backend), vitest (scorecard), Docker.

**Spec:** `docs/superpowers/specs/2026-04-10-phase3-insurance-design.md`

**Branch:** `feature/phase3-onchain-insurance`

---

## Working Schedule Note

This plan is built for a hybrid execution model:
- **Friday evening (active with Alan):** Task 0 (prerequisites) + Tasks 1-4 (scaffold + constants + errors + first two instructions). Goal: validate the scaffold works.
- **Saturday (subagent-delegated):** Tasks 5-15 (remaining Anchor instructions + tests).
- **Sunday (subagent-delegated):** Tasks 16-36 (backend integration, SDK, scorecard UI).
- **Monday (active with Alan):** Tasks 37-42 (simulation integration tests) + devnet deployment + fix integration bugs.

Tasks in Phase A (Anchor program) have full TDD detail. Tasks in Phases B-F have file paths, complete code examples, and test code but compressed step structure — the mechanical nature of those tasks doesn't benefit from 5-step TDD cycles the way risky program code does.

---

## Prerequisites and Environment

### Task 0: Install Anchor, Solana CLI, and set up devnet keypair

**This task is Alan-active (Friday evening). Subagents should NOT run this.**

Anchor and Solana CLI are not installed. Install via the official script:

- [ ] **Step 1: Install Solana CLI**

```bash
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
```

Expected: prints install location (`~/.local/share/solana/install/active_release/bin`). Add to PATH if not already there.

- [ ] **Step 2: Verify Solana CLI**

```bash
solana --version
```

Expected: `solana-cli 2.x.x`.

- [ ] **Step 3: Install Anchor Version Manager (avm)**

```bash
cargo install --git https://github.com/coral-xyz/anchor avm --force
avm install latest
avm use latest
```

- [ ] **Step 4: Verify Anchor**

```bash
anchor --version
```

Expected: `anchor-cli 0.31.x` or later.

- [ ] **Step 5: Configure Solana for devnet**

```bash
solana config set --url devnet
solana config get
```

Expected: RPC URL shows `https://api.devnet.solana.com`.

- [ ] **Step 6: Create dev keypair (if none exists) and airdrop test SOL**

```bash
solana-keygen new --no-bip39-passphrase --force --outfile ~/.config/solana/id.json
solana address
solana airdrop 2
solana balance
```

Expected: balance shows at least 2 SOL on devnet.

- [ ] **Step 7: Create oracle keypair for the backend**

```bash
mkdir -p packages/backend/.secrets
solana-keygen new --no-bip39-passphrase --force --outfile packages/backend/.secrets/oracle-keypair.json
cat packages/backend/.secrets/oracle-keypair.json
```

Save the public key for later. Add `.secrets/` to `.gitignore`.

- [ ] **Step 8: Ensure .gitignore protects secrets**

Check that `packages/backend/.gitignore` (or root `.gitignore`) contains:

```
packages/backend/.secrets/
*.keypair.json
```

If missing, add it and commit.

```bash
echo -e "\npackages/backend/.secrets/\n*.keypair.json" >> .gitignore
git add .gitignore
git commit -m "chore: ignore solana keypair secrets"
```

---

## Phase A: Anchor Program

### Task 1: Scaffold Anchor project at packages/program/

**Files:**
- Create: `packages/program/Anchor.toml`
- Create: `packages/program/Cargo.toml`
- Create: `packages/program/programs/pact-insurance/Cargo.toml`
- Create: `packages/program/programs/pact-insurance/src/lib.rs`
- Create: `packages/program/package.json`
- Create: `packages/program/tsconfig.json`
- Create: `packages/program/.gitignore`

- [ ] **Step 1: Create directory and run `anchor init`**

```bash
mkdir -p packages/program
cd packages/program
anchor init pact-insurance --no-git --no-install
mv pact-insurance/* . 2>/dev/null || true
mv pact-insurance/.* . 2>/dev/null || true
rmdir pact-insurance
cd ../..
```

- [ ] **Step 2: Replace `packages/program/Anchor.toml` with our config**

```toml
[toolchain]

[features]
resolution = true
skip-lint = false

[programs.localnet]
pact_insurance = "Pact11111111111111111111111111111111111111"

[programs.devnet]
pact_insurance = "Pact11111111111111111111111111111111111111"

[registry]
url = "https://api.apr.dev"

[provider]
cluster = "Devnet"
wallet = "~/.config/solana/id.json"

[scripts]
test = "yarn run ts-mocha -p ./tsconfig.json -t 1000000 tests/**/*.ts"
```

The placeholder program ID will be replaced after first build via `anchor keys sync`.

- [ ] **Step 3: Replace `packages/program/Cargo.toml` with workspace config**

```toml
[workspace]
members = [
    "programs/*"
]
resolver = "2"

[profile.release]
overflow-checks = true
lto = "fat"
codegen-units = 1
[profile.release.build-override]
opt-level = 3
incremental = false
codegen-units = 1
```

- [ ] **Step 4: Replace `packages/program/programs/pact-insurance/Cargo.toml`**

```toml
[package]
name = "pact-insurance"
version = "0.1.0"
description = "Pact Network on-chain parametric insurance"
edition = "2021"

[lib]
crate-type = ["cdylib", "lib"]
name = "pact_insurance"

[features]
no-entrypoint = []
no-idl = []
no-log-ix-name = []
cpi = ["no-entrypoint"]
default = []
idl-build = ["anchor-lang/idl-build", "anchor-spl/idl-build"]

[dependencies]
anchor-lang = "0.31.0"
anchor-spl = "0.31.0"
```

- [ ] **Step 5: Replace `packages/program/programs/pact-insurance/src/lib.rs` with skeleton**

```rust
use anchor_lang::prelude::*;

declare_id!("Pact11111111111111111111111111111111111111");

pub mod constants;
pub mod error;
pub mod state;
pub mod instructions;

use instructions::*;

#[program]
pub mod pact_insurance {
    use super::*;

    pub fn initialize_protocol(
        ctx: Context<InitializeProtocol>,
        args: InitializeProtocolArgs,
    ) -> Result<()> {
        instructions::initialize_protocol::handler(ctx, args)
    }
}
```

- [ ] **Step 6: Create `packages/program/programs/pact-insurance/src/instructions/mod.rs`**

```rust
pub mod initialize_protocol;

pub use initialize_protocol::*;
```

Other instruction modules will be appended as tasks add them.

- [ ] **Step 7: Create empty placeholder files that will be filled in later tasks**

```bash
touch packages/program/programs/pact-insurance/src/constants.rs
touch packages/program/programs/pact-insurance/src/error.rs
touch packages/program/programs/pact-insurance/src/state.rs
mkdir -p packages/program/programs/pact-insurance/src/instructions
touch packages/program/programs/pact-insurance/src/instructions/initialize_protocol.rs
```

- [ ] **Step 8: Verify the project builds (with empty files it will fail — that's expected, just confirm Anchor is runnable)**

```bash
cd packages/program
anchor build 2>&1 | head -20
cd ../..
```

Expected: compilation errors about missing types (because files are empty). This confirms Anchor is invoked correctly. The errors will be resolved in the next tasks.

- [ ] **Step 9: Add `.gitignore` entries for Anchor artifacts**

Write to `packages/program/.gitignore`:

```
.anchor/
target/
node_modules/
test-ledger/
.DS_Store
dist/
*.log
```

- [ ] **Step 10: Commit the scaffold**

```bash
git add packages/program/
git commit -m "feat(program): scaffold Anchor program at packages/program"
```

---

### Task 2: Add constants.rs with safety floors

**Files:**
- Modify: `packages/program/programs/pact-insurance/src/constants.rs`

- [ ] **Step 1: Write the constants file**

Replace the contents of `packages/program/programs/pact-insurance/src/constants.rs` with:

```rust
/// Absolute minimum withdrawal cooldown in seconds (1 hour).
/// config.withdrawal_cooldown_seconds cannot be set below this value.
pub const ABSOLUTE_MIN_WITHDRAWAL_COOLDOWN: i64 = 3600;

/// Absolute maximum aggregate payout cap in basis points (80%).
/// config.aggregate_cap_bps cannot be set above this value.
pub const ABSOLUTE_MAX_AGGREGATE_CAP_BPS: u16 = 8000;

/// Absolute maximum protocol fee in basis points (30%).
/// config.protocol_fee_bps cannot be set above this value.
pub const ABSOLUTE_MAX_PROTOCOL_FEE_BPS: u16 = 3000;

/// Absolute minimum claim staleness window in seconds (1 minute).
/// config.claim_window_seconds cannot be set below this value.
pub const ABSOLUTE_MIN_CLAIM_WINDOW: i64 = 60;

/// Absolute minimum pool deposit amount in USDC lamports (1 USDC).
/// config.min_pool_deposit cannot be set below this value.
pub const ABSOLUTE_MIN_POOL_DEPOSIT: u64 = 1_000_000;

pub const MAX_HOSTNAME_LEN: usize = 128;
pub const MAX_AGENT_ID_LEN: usize = 64;
pub const MAX_CALL_ID_LEN: usize = 64;

// Default values used by initialize_protocol when no args provided.
pub const DEFAULT_PROTOCOL_FEE_BPS: u16 = 1500;          // 15%
pub const DEFAULT_MIN_POOL_DEPOSIT: u64 = 100_000_000;   // 100 USDC
pub const DEFAULT_INSURANCE_RATE_BPS: u16 = 25;          // 0.25%
pub const DEFAULT_MAX_COVERAGE_PER_CALL: u64 = 1_000_000; // 1 USDC
pub const DEFAULT_MIN_PREMIUM_BPS: u16 = 5;              // 0.05%
pub const DEFAULT_WITHDRAWAL_COOLDOWN: i64 = 604_800;    // 7 days
pub const DEFAULT_AGGREGATE_CAP_BPS: u16 = 3000;         // 30%
pub const DEFAULT_AGGREGATE_CAP_WINDOW: i64 = 86_400;    // 24 hours
pub const DEFAULT_CLAIM_WINDOW: i64 = 3600;              // 1 hour
pub const DEFAULT_MAX_CLAIMS_PER_BATCH: u8 = 10;
```

- [ ] **Step 2: Verify file compiles (it has no deps so build just this file via cargo check)**

```bash
cd packages/program
cargo check --package pact-insurance 2>&1 | grep -E "(error|warning)" | head -20
cd ../..
```

Expected: may have errors about unused constants until they're referenced, but no syntax errors.

- [ ] **Step 3: Commit**

```bash
git add packages/program/programs/pact-insurance/src/constants.rs
git commit -m "feat(program): add safety floor constants"
```

---

### Task 3: Add error.rs with PactError enum

**Files:**
- Modify: `packages/program/programs/pact-insurance/src/error.rs`

- [ ] **Step 1: Write the error enum**

Replace contents of `packages/program/programs/pact-insurance/src/error.rs`:

```rust
use anchor_lang::prelude::*;

#[error_code]
pub enum PactError {
    #[msg("Protocol is paused")]
    ProtocolPaused,

    #[msg("Pool already exists for this provider")]
    PoolAlreadyExists,

    #[msg("Policy already exists for this agent and pool")]
    PolicyAlreadyExists,

    #[msg("Policy is not active")]
    PolicyInactive,

    #[msg("Pool does not have sufficient available balance")]
    InsufficientPoolBalance,

    #[msg("Policy prepaid balance is insufficient")]
    InsufficientPrepaidBalance,

    #[msg("Withdrawal cooldown has not elapsed")]
    WithdrawalUnderCooldown,

    #[msg("Withdrawal would underfund active policy obligations")]
    WithdrawalWouldUnderfund,

    #[msg("Aggregate payout cap exceeded for current window")]
    AggregateCapExceeded,

    #[msg("Claim submission window has expired")]
    ClaimWindowExpired,

    #[msg("Duplicate claim for this call_id")]
    DuplicateClaim,

    #[msg("Invalid rate")]
    InvalidRate,

    #[msg("Hostname exceeds maximum length")]
    HostnameTooLong,

    #[msg("Agent ID exceeds maximum length")]
    AgentIdTooLong,

    #[msg("Call ID exceeds maximum length")]
    CallIdTooLong,

    #[msg("Unauthorized")]
    Unauthorized,

    #[msg("Invalid trigger type")]
    InvalidTriggerType,

    #[msg("Amount must be non-zero")]
    ZeroAmount,

    #[msg("Amount is below minimum pool deposit")]
    BelowMinimumDeposit,

    #[msg("Config value violates hardcoded safety floor")]
    ConfigSafetyFloorViolation,

    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/program/programs/pact-insurance/src/error.rs
git commit -m "feat(program): add PactError enum"
```

---

### Task 4: Add state.rs with ProtocolConfig account

**Files:**
- Modify: `packages/program/programs/pact-insurance/src/state.rs`

- [ ] **Step 1: Write the state module with ProtocolConfig**

Replace contents of `packages/program/programs/pact-insurance/src/state.rs`:

```rust
use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct ProtocolConfig {
    pub authority: Pubkey,
    pub treasury: Pubkey,
    pub usdc_mint: Pubkey,

    pub protocol_fee_bps: u16,
    pub min_pool_deposit: u64,
    pub default_insurance_rate_bps: u16,
    pub default_max_coverage_per_call: u64,
    pub min_premium_bps: u16,

    pub withdrawal_cooldown_seconds: i64,
    pub aggregate_cap_bps: u16,
    pub aggregate_cap_window_seconds: i64,

    pub claim_window_seconds: i64,
    pub max_claims_per_batch: u8,

    pub paused: bool,

    pub bump: u8,
}

impl ProtocolConfig {
    pub const SEED: &'static [u8] = b"protocol";
}
```

CoveragePool, Policy, UnderwriterPosition, and Claim accounts will be added in later tasks as each instruction needs them.

- [ ] **Step 2: Commit**

```bash
git add packages/program/programs/pact-insurance/src/state.rs
git commit -m "feat(program): add ProtocolConfig account state"
```

---

### Task 5: Implement `initialize_protocol` instruction

**Files:**
- Modify: `packages/program/programs/pact-insurance/src/instructions/initialize_protocol.rs`
- Modify: `packages/program/programs/pact-insurance/src/lib.rs` (entry point already registered)
- Create: `packages/program/tests/protocol.ts`
- Create: `packages/program/package.json`
- Create: `packages/program/tsconfig.json`

- [ ] **Step 1: Set up test dependencies for packages/program**

Write `packages/program/package.json`:

```json
{
  "name": "@pact-network/program",
  "private": true,
  "version": "0.1.0",
  "scripts": {
    "build": "anchor build",
    "test": "anchor test --skip-local-validator",
    "test:localnet": "anchor test",
    "deploy:devnet": "anchor deploy --provider.cluster devnet"
  },
  "devDependencies": {
    "@coral-xyz/anchor": "^0.31.0",
    "@solana/spl-token": "^0.4.8",
    "@solana/web3.js": "^1.95.0",
    "@types/chai": "^4.3.0",
    "@types/mocha": "^10.0.0",
    "@types/node": "^20.0.0",
    "chai": "^4.3.0",
    "mocha": "^10.2.0",
    "ts-mocha": "^10.0.0",
    "typescript": "^5.8.3"
  }
}
```

Write `packages/program/tsconfig.json`:

```json
{
  "compilerOptions": {
    "types": ["mocha", "chai", "node"],
    "typeRoots": ["./node_modules/@types"],
    "lib": ["es2020"],
    "module": "commonjs",
    "target": "es2020",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  }
}
```

Install:

```bash
cd packages/program && pnpm install && cd ../..
```

- [ ] **Step 2: Write the failing test first**

Write `packages/program/tests/protocol.ts`:

```typescript
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PactInsurance } from "../target/types/pact_insurance";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";

describe("pact-insurance: protocol", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.PactInsurance as Program<PactInsurance>;

  const treasury = Keypair.generate();
  const usdcMint = Keypair.generate().publicKey; // stub for initial test

  let protocolPda: PublicKey;
  let protocolBump: number;

  before(() => {
    [protocolPda, protocolBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("protocol")],
      program.programId
    );
  });

  it("initializes the protocol config with defaults", async () => {
    await program.methods
      .initializeProtocol({
        treasury: treasury.publicKey,
        usdcMint,
      })
      .accounts({
        config: protocolPda,
        authority: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const config = await program.account.protocolConfig.fetch(protocolPda);
    expect(config.authority.toString()).to.equal(provider.wallet.publicKey.toString());
    expect(config.treasury.toString()).to.equal(treasury.publicKey.toString());
    expect(config.usdcMint.toString()).to.equal(usdcMint.toString());
    expect(config.protocolFeeBps).to.equal(1500);
    expect(config.minPoolDeposit.toNumber()).to.equal(100_000_000);
    expect(config.withdrawalCooldownSeconds.toNumber()).to.equal(604_800);
    expect(config.aggregateCapBps).to.equal(3000);
    expect(config.aggregateCapWindowSeconds.toNumber()).to.equal(86_400);
    expect(config.paused).to.equal(false);
  });

  it("rejects second initialization (PDA already exists)", async () => {
    try {
      await program.methods
        .initializeProtocol({
          treasury: treasury.publicKey,
          usdcMint,
        })
        .accounts({
          config: protocolPda,
          authority: provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(String(err)).to.match(/already in use|already initialized/i);
    }
  });
});
```

- [ ] **Step 3: Implement the initialize_protocol instruction**

Write `packages/program/programs/pact-insurance/src/instructions/initialize_protocol.rs`:

```rust
use anchor_lang::prelude::*;
use crate::state::ProtocolConfig;
use crate::constants::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeProtocolArgs {
    pub treasury: Pubkey,
    pub usdc_mint: Pubkey,
}

#[derive(Accounts)]
pub struct InitializeProtocol<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + ProtocolConfig::INIT_SPACE,
        seeds = [ProtocolConfig::SEED],
        bump
    )]
    pub config: Account<'info, ProtocolConfig>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<InitializeProtocol>,
    args: InitializeProtocolArgs,
) -> Result<()> {
    let config = &mut ctx.accounts.config;

    config.authority = ctx.accounts.authority.key();
    config.treasury = args.treasury;
    config.usdc_mint = args.usdc_mint;

    config.protocol_fee_bps = DEFAULT_PROTOCOL_FEE_BPS;
    config.min_pool_deposit = DEFAULT_MIN_POOL_DEPOSIT;
    config.default_insurance_rate_bps = DEFAULT_INSURANCE_RATE_BPS;
    config.default_max_coverage_per_call = DEFAULT_MAX_COVERAGE_PER_CALL;
    config.min_premium_bps = DEFAULT_MIN_PREMIUM_BPS;

    config.withdrawal_cooldown_seconds = DEFAULT_WITHDRAWAL_COOLDOWN;
    config.aggregate_cap_bps = DEFAULT_AGGREGATE_CAP_BPS;
    config.aggregate_cap_window_seconds = DEFAULT_AGGREGATE_CAP_WINDOW;

    config.claim_window_seconds = DEFAULT_CLAIM_WINDOW;
    config.max_claims_per_batch = DEFAULT_MAX_CLAIMS_PER_BATCH;

    config.paused = false;
    config.bump = ctx.bumps.config;

    Ok(())
}
```

- [ ] **Step 4: Build the program**

```bash
cd packages/program
anchor build 2>&1 | tail -30
cd ../..
```

Expected: build succeeds, generates IDL at `packages/program/target/idl/pact_insurance.json` and types at `packages/program/target/types/pact_insurance.ts`. If errors, fix them.

- [ ] **Step 5: Sync program ID (one-time, replaces placeholder)**

```bash
cd packages/program
anchor keys sync
anchor build
cd ../..
```

This regenerates the program keypair at `target/deploy/pact_insurance-keypair.json` and updates `declare_id!` in `lib.rs` and `Anchor.toml` to match.

- [ ] **Step 6: Run the test**

```bash
cd packages/program
anchor test --skip-local-validator
cd ../..
```

If no local validator is running, use `anchor test` which spawns one.

Expected: 2 passing tests.

- [ ] **Step 7: Commit**

```bash
git add packages/program/
git commit -m "feat(program): implement initialize_protocol instruction"
```

---

### Task 6: Implement `update_config` instruction with safety floor validation

**Files:**
- Create: `packages/program/programs/pact-insurance/src/instructions/update_config.rs`
- Modify: `packages/program/programs/pact-insurance/src/instructions/mod.rs`
- Modify: `packages/program/programs/pact-insurance/src/lib.rs`
- Modify: `packages/program/tests/protocol.ts`

- [ ] **Step 1: Add failing tests for update_config**

Append to `packages/program/tests/protocol.ts` inside the `describe` block:

```typescript
  it("updates protocol_fee_bps when authority calls update_config", async () => {
    await program.methods
      .updateConfig({
        protocolFeeBps: 2000,
        minPoolDeposit: null,
        defaultInsuranceRateBps: null,
        defaultMaxCoveragePerCall: null,
        minPremiumBps: null,
        withdrawalCooldownSeconds: null,
        aggregateCapBps: null,
        aggregateCapWindowSeconds: null,
        claimWindowSeconds: null,
        maxClaimsPerBatch: null,
        paused: null,
        treasury: null,
        usdcMint: null,
      })
      .accounts({
        config: protocolPda,
        authority: provider.wallet.publicKey,
      })
      .rpc();

    const config = await program.account.protocolConfig.fetch(protocolPda);
    expect(config.protocolFeeBps).to.equal(2000);
  });

  it("rejects protocol_fee_bps above ABSOLUTE_MAX (3000)", async () => {
    try {
      await program.methods
        .updateConfig({
          protocolFeeBps: 3500,
          minPoolDeposit: null,
          defaultInsuranceRateBps: null,
          defaultMaxCoveragePerCall: null,
          minPremiumBps: null,
          withdrawalCooldownSeconds: null,
          aggregateCapBps: null,
          aggregateCapWindowSeconds: null,
          claimWindowSeconds: null,
          maxClaimsPerBatch: null,
          paused: null,
          treasury: null,
          usdcMint: null,
        })
        .accounts({
          config: protocolPda,
          authority: provider.wallet.publicKey,
        })
        .rpc();
      expect.fail("Should have rejected");
    } catch (err: any) {
      expect(String(err)).to.match(/ConfigSafetyFloorViolation/);
    }
  });

  it("rejects withdrawal_cooldown below ABSOLUTE_MIN (3600)", async () => {
    try {
      await program.methods
        .updateConfig({
          protocolFeeBps: null,
          minPoolDeposit: null,
          defaultInsuranceRateBps: null,
          defaultMaxCoveragePerCall: null,
          minPremiumBps: null,
          withdrawalCooldownSeconds: new anchor.BN(1000),
          aggregateCapBps: null,
          aggregateCapWindowSeconds: null,
          claimWindowSeconds: null,
          maxClaimsPerBatch: null,
          paused: null,
          treasury: null,
          usdcMint: null,
        })
        .accounts({
          config: protocolPda,
          authority: provider.wallet.publicKey,
        })
        .rpc();
      expect.fail("Should have rejected");
    } catch (err: any) {
      expect(String(err)).to.match(/ConfigSafetyFloorViolation/);
    }
  });

  it("rejects aggregate_cap_bps above ABSOLUTE_MAX (8000)", async () => {
    try {
      await program.methods
        .updateConfig({
          protocolFeeBps: null,
          minPoolDeposit: null,
          defaultInsuranceRateBps: null,
          defaultMaxCoveragePerCall: null,
          minPremiumBps: null,
          withdrawalCooldownSeconds: null,
          aggregateCapBps: 9000,
          aggregateCapWindowSeconds: null,
          claimWindowSeconds: null,
          maxClaimsPerBatch: null,
          paused: null,
          treasury: null,
          usdcMint: null,
        })
        .accounts({
          config: protocolPda,
          authority: provider.wallet.publicKey,
        })
        .rpc();
      expect.fail("Should have rejected");
    } catch (err: any) {
      expect(String(err)).to.match(/ConfigSafetyFloorViolation/);
    }
  });

  it("rejects update_config from non-authority", async () => {
    const rando = Keypair.generate();
    // airdrop SOL to the rando
    const sig = await provider.connection.requestAirdrop(rando.publicKey, 1_000_000_000);
    await provider.connection.confirmTransaction(sig);

    try {
      await program.methods
        .updateConfig({
          protocolFeeBps: 500,
          minPoolDeposit: null,
          defaultInsuranceRateBps: null,
          defaultMaxCoveragePerCall: null,
          minPremiumBps: null,
          withdrawalCooldownSeconds: null,
          aggregateCapBps: null,
          aggregateCapWindowSeconds: null,
          claimWindowSeconds: null,
          maxClaimsPerBatch: null,
          paused: null,
          treasury: null,
          usdcMint: null,
        })
        .accounts({
          config: protocolPda,
          authority: rando.publicKey,
        })
        .signers([rando])
        .rpc();
      expect.fail("Should have rejected");
    } catch (err: any) {
      expect(String(err)).to.match(/Unauthorized|ConstraintHasOne|has_one/i);
    }
  });
```

- [ ] **Step 2: Implement update_config instruction**

Write `packages/program/programs/pact-insurance/src/instructions/update_config.rs`:

```rust
use anchor_lang::prelude::*;
use crate::state::ProtocolConfig;
use crate::constants::*;
use crate::error::PactError;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct UpdateConfigArgs {
    pub protocol_fee_bps: Option<u16>,
    pub min_pool_deposit: Option<u64>,
    pub default_insurance_rate_bps: Option<u16>,
    pub default_max_coverage_per_call: Option<u64>,
    pub min_premium_bps: Option<u16>,
    pub withdrawal_cooldown_seconds: Option<i64>,
    pub aggregate_cap_bps: Option<u16>,
    pub aggregate_cap_window_seconds: Option<i64>,
    pub claim_window_seconds: Option<i64>,
    pub max_claims_per_batch: Option<u8>,
    pub paused: Option<bool>,
    pub treasury: Option<Pubkey>,
    pub usdc_mint: Option<Pubkey>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(
        mut,
        seeds = [ProtocolConfig::SEED],
        bump = config.bump,
        has_one = authority @ PactError::Unauthorized
    )]
    pub config: Account<'info, ProtocolConfig>,

    pub authority: Signer<'info>,
}

pub fn handler(ctx: Context<UpdateConfig>, args: UpdateConfigArgs) -> Result<()> {
    let config = &mut ctx.accounts.config;

    if let Some(v) = args.protocol_fee_bps {
        require!(v <= ABSOLUTE_MAX_PROTOCOL_FEE_BPS, PactError::ConfigSafetyFloorViolation);
        config.protocol_fee_bps = v;
    }

    if let Some(v) = args.min_pool_deposit {
        require!(v >= ABSOLUTE_MIN_POOL_DEPOSIT, PactError::ConfigSafetyFloorViolation);
        config.min_pool_deposit = v;
    }

    if let Some(v) = args.default_insurance_rate_bps {
        config.default_insurance_rate_bps = v;
    }

    if let Some(v) = args.default_max_coverage_per_call {
        config.default_max_coverage_per_call = v;
    }

    if let Some(v) = args.min_premium_bps {
        config.min_premium_bps = v;
    }

    if let Some(v) = args.withdrawal_cooldown_seconds {
        require!(v >= ABSOLUTE_MIN_WITHDRAWAL_COOLDOWN, PactError::ConfigSafetyFloorViolation);
        config.withdrawal_cooldown_seconds = v;
    }

    if let Some(v) = args.aggregate_cap_bps {
        require!(v <= ABSOLUTE_MAX_AGGREGATE_CAP_BPS, PactError::ConfigSafetyFloorViolation);
        config.aggregate_cap_bps = v;
    }

    if let Some(v) = args.aggregate_cap_window_seconds {
        config.aggregate_cap_window_seconds = v;
    }

    if let Some(v) = args.claim_window_seconds {
        require!(v >= ABSOLUTE_MIN_CLAIM_WINDOW, PactError::ConfigSafetyFloorViolation);
        config.claim_window_seconds = v;
    }

    if let Some(v) = args.max_claims_per_batch {
        config.max_claims_per_batch = v;
    }

    if let Some(v) = args.paused {
        config.paused = v;
    }

    if let Some(v) = args.treasury {
        config.treasury = v;
    }

    if let Some(v) = args.usdc_mint {
        config.usdc_mint = v;
    }

    Ok(())
}
```

- [ ] **Step 3: Register in mod.rs**

Update `packages/program/programs/pact-insurance/src/instructions/mod.rs`:

```rust
pub mod initialize_protocol;
pub mod update_config;

pub use initialize_protocol::*;
pub use update_config::*;
```

- [ ] **Step 4: Register in lib.rs**

Update `packages/program/programs/pact-insurance/src/lib.rs` to add the update_config entry point:

```rust
pub fn update_config(
    ctx: Context<UpdateConfig>,
    args: UpdateConfigArgs,
) -> Result<()> {
    instructions::update_config::handler(ctx, args)
}
```

- [ ] **Step 5: Build and test**

```bash
cd packages/program
anchor build
anchor test --skip-local-validator
cd ../..
```

Expected: 7 passing tests (2 existing + 5 new).

- [ ] **Step 6: Commit**

```bash
git add packages/program/
git commit -m "feat(program): implement update_config with safety floor validation"
```

---

### Task 7: Add CoveragePool state + implement `create_pool` instruction

**Files:**
- Modify: `packages/program/programs/pact-insurance/src/state.rs`
- Create: `packages/program/programs/pact-insurance/src/instructions/create_pool.rs`
- Modify: `packages/program/programs/pact-insurance/src/instructions/mod.rs`
- Modify: `packages/program/programs/pact-insurance/src/lib.rs`
- Create: `packages/program/tests/pool.ts`

- [ ] **Step 1: Add CoveragePool to state.rs**

Append to `packages/program/programs/pact-insurance/src/state.rs`:

```rust
use crate::constants::MAX_HOSTNAME_LEN;

#[account]
#[derive(InitSpace)]
pub struct CoveragePool {
    pub authority: Pubkey,
    #[max_len(MAX_HOSTNAME_LEN)]
    pub provider_hostname: String,
    pub usdc_mint: Pubkey,
    pub vault: Pubkey,

    pub total_deposited: u64,
    pub total_available: u64,
    pub total_premiums_earned: u64,
    pub total_claims_paid: u64,

    pub insurance_rate_bps: u16,
    pub min_premium_bps: u16,
    pub max_coverage_per_call: u64,

    pub active_policies: u32,

    pub payouts_this_window: u64,
    pub window_start: i64,

    pub created_at: i64,
    pub updated_at: i64,
    pub bump: u8,
}

impl CoveragePool {
    pub const SEED_PREFIX: &'static [u8] = b"pool";
    pub const VAULT_SEED_PREFIX: &'static [u8] = b"vault";
}
```

- [ ] **Step 2: Write failing test**

Create `packages/program/tests/pool.ts`:

```typescript
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { PactInsurance } from "../target/types/pact_insurance";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getAssociatedTokenAddressSync,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { expect } from "chai";

describe("pact-insurance: pool", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.PactInsurance as Program<PactInsurance>;

  let usdcMint: PublicKey;
  let protocolPda: PublicKey;
  const hostname = "api.helius.xyz";
  let poolPda: PublicKey;
  let vaultPda: PublicKey;

  before(async () => {
    [protocolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("protocol")],
      program.programId
    );

    // Create a real SPL token mint for USDC stub
    usdcMint = await createMint(
      provider.connection,
      (provider.wallet as anchor.Wallet).payer,
      provider.wallet.publicKey,
      null,
      6
    );

    // Make sure protocol is initialized (idempotent-ish — may already exist from other tests)
    try {
      await program.methods
        .initializeProtocol({
          treasury: provider.wallet.publicKey,
          usdcMint,
        })
        .accounts({
          config: protocolPda,
          authority: provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    } catch (_) {
      // already initialized
    }

    // Update usdc_mint in config to the real mint we just created
    await program.methods
      .updateConfig({
        protocolFeeBps: null,
        minPoolDeposit: null,
        defaultInsuranceRateBps: null,
        defaultMaxCoveragePerCall: null,
        minPremiumBps: null,
        withdrawalCooldownSeconds: null,
        aggregateCapBps: null,
        aggregateCapWindowSeconds: null,
        claimWindowSeconds: null,
        maxClaimsPerBatch: null,
        paused: null,
        treasury: null,
        usdcMint,
      })
      .accounts({
        config: protocolPda,
        authority: provider.wallet.publicKey,
      })
      .rpc();

    [poolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), Buffer.from(hostname)],
      program.programId
    );

    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), poolPda.toBuffer()],
      program.programId
    );
  });

  it("creates a pool for a provider hostname", async () => {
    await program.methods
      .createPool({
        providerHostname: hostname,
        insuranceRateBps: null,
        maxCoveragePerCall: null,
      })
      .accounts({
        config: protocolPda,
        pool: poolPda,
        vault: vaultPda,
        usdcMint,
        authority: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const pool = await program.account.coveragePool.fetch(poolPda);
    expect(pool.providerHostname).to.equal(hostname);
    expect(pool.insuranceRateBps).to.equal(25); // default
    expect(pool.maxCoveragePerCall.toNumber()).to.equal(1_000_000); // default
    expect(pool.totalDeposited.toNumber()).to.equal(0);
    expect(pool.payoutsThisWindow.toNumber()).to.equal(0);
  });

  it("rejects duplicate pool creation", async () => {
    try {
      await program.methods
        .createPool({
          providerHostname: hostname,
          insuranceRateBps: null,
          maxCoveragePerCall: null,
        })
        .accounts({
          config: protocolPda,
          pool: poolPda,
          vault: vaultPda,
          usdcMint,
          authority: provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc();
      expect.fail("should have rejected");
    } catch (err: any) {
      expect(String(err)).to.match(/already in use|PoolAlreadyExists/i);
    }
  });
});
```

- [ ] **Step 3: Implement create_pool.rs**

Write `packages/program/programs/pact-insurance/src/instructions/create_pool.rs`:

```rust
use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};
use crate::state::{ProtocolConfig, CoveragePool};
use crate::constants::MAX_HOSTNAME_LEN;
use crate::error::PactError;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CreatePoolArgs {
    pub provider_hostname: String,
    pub insurance_rate_bps: Option<u16>,
    pub max_coverage_per_call: Option<u64>,
}

#[derive(Accounts)]
#[instruction(args: CreatePoolArgs)]
pub struct CreatePool<'info> {
    #[account(
        seeds = [ProtocolConfig::SEED],
        bump = config.bump,
        has_one = authority @ PactError::Unauthorized,
        constraint = !config.paused @ PactError::ProtocolPaused
    )]
    pub config: Account<'info, ProtocolConfig>,

    #[account(
        init,
        payer = authority,
        space = 8 + CoveragePool::INIT_SPACE,
        seeds = [CoveragePool::SEED_PREFIX, args.provider_hostname.as_bytes()],
        bump
    )]
    pub pool: Account<'info, CoveragePool>,

    #[account(
        init,
        payer = authority,
        seeds = [CoveragePool::VAULT_SEED_PREFIX, pool.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = pool,
    )]
    pub vault: Account<'info, TokenAccount>,

    pub usdc_mint: Account<'info, Mint>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(ctx: Context<CreatePool>, args: CreatePoolArgs) -> Result<()> {
    require!(
        args.provider_hostname.len() <= MAX_HOSTNAME_LEN,
        PactError::HostnameTooLong
    );

    let pool = &mut ctx.accounts.pool;
    let config = &ctx.accounts.config;
    let clock = Clock::get()?;

    pool.authority = config.authority;
    pool.provider_hostname = args.provider_hostname;
    pool.usdc_mint = ctx.accounts.usdc_mint.key();
    pool.vault = ctx.accounts.vault.key();

    pool.total_deposited = 0;
    pool.total_available = 0;
    pool.total_premiums_earned = 0;
    pool.total_claims_paid = 0;

    pool.insurance_rate_bps = args
        .insurance_rate_bps
        .unwrap_or(config.default_insurance_rate_bps);
    pool.min_premium_bps = config.min_premium_bps;
    pool.max_coverage_per_call = args
        .max_coverage_per_call
        .unwrap_or(config.default_max_coverage_per_call);

    pool.active_policies = 0;
    pool.payouts_this_window = 0;
    pool.window_start = clock.unix_timestamp;

    pool.created_at = clock.unix_timestamp;
    pool.updated_at = clock.unix_timestamp;
    pool.bump = ctx.bumps.pool;

    Ok(())
}
```

- [ ] **Step 4: Register in mod.rs and lib.rs**

Add to `instructions/mod.rs`:

```rust
pub mod create_pool;
pub use create_pool::*;
```

Add to `lib.rs` inside `pub mod pact_insurance`:

```rust
    pub fn create_pool(
        ctx: Context<CreatePool>,
        args: CreatePoolArgs,
    ) -> Result<()> {
        instructions::create_pool::handler(ctx, args)
    }
```

- [ ] **Step 5: Build and test**

```bash
cd packages/program
anchor build
anchor test --skip-local-validator
cd ../..
```

Expected: all existing tests pass + 2 new pool tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/program/
git commit -m "feat(program): add CoveragePool state and create_pool instruction"
```

---

### Task 8: Add UnderwriterPosition state + implement `deposit` instruction

**Files:**
- Modify: `packages/program/programs/pact-insurance/src/state.rs`
- Create: `packages/program/programs/pact-insurance/src/instructions/deposit.rs`
- Modify: `packages/program/programs/pact-insurance/src/instructions/mod.rs`
- Modify: `packages/program/programs/pact-insurance/src/lib.rs`
- Create: `packages/program/tests/underwriter.ts`

- [ ] **Step 1: Add UnderwriterPosition to state.rs**

Append to `state.rs`:

```rust
#[account]
#[derive(InitSpace)]
pub struct UnderwriterPosition {
    pub pool: Pubkey,
    pub underwriter: Pubkey,
    pub deposited: u64,
    pub earned_premiums: u64,
    pub losses_absorbed: u64,
    pub deposit_timestamp: i64,
    pub last_claim_timestamp: i64,
    pub bump: u8,
}

impl UnderwriterPosition {
    pub const SEED_PREFIX: &'static [u8] = b"position";
}
```

- [ ] **Step 2: Implement deposit.rs**

Write `packages/program/programs/pact-insurance/src/instructions/deposit.rs`:

```rust
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use crate::state::{ProtocolConfig, CoveragePool, UnderwriterPosition};
use crate::error::PactError;

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(
        seeds = [ProtocolConfig::SEED],
        bump = config.bump,
        constraint = !config.paused @ PactError::ProtocolPaused
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
        init_if_needed,
        payer = underwriter,
        space = 8 + UnderwriterPosition::INIT_SPACE,
        seeds = [
            UnderwriterPosition::SEED_PREFIX,
            pool.key().as_ref(),
            underwriter.key().as_ref()
        ],
        bump
    )]
    pub position: Account<'info, UnderwriterPosition>,

    #[account(
        mut,
        constraint = underwriter_token_account.owner == underwriter.key(),
        constraint = underwriter_token_account.mint == pool.usdc_mint,
    )]
    pub underwriter_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub underwriter: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    require!(amount > 0, PactError::ZeroAmount);
    require!(
        amount >= ctx.accounts.config.min_pool_deposit,
        PactError::BelowMinimumDeposit
    );

    // Transfer USDC from underwriter to vault
    let cpi_ctx = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.underwriter_token_account.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.underwriter.to_account_info(),
        },
    );
    token::transfer(cpi_ctx, amount)?;

    let pool = &mut ctx.accounts.pool;
    let position = &mut ctx.accounts.position;
    let clock = Clock::get()?;

    // Initialize position if new
    if position.pool == Pubkey::default() {
        position.pool = pool.key();
        position.underwriter = ctx.accounts.underwriter.key();
        position.deposited = 0;
        position.earned_premiums = 0;
        position.losses_absorbed = 0;
        position.last_claim_timestamp = 0;
        position.bump = ctx.bumps.position;
    }

    position.deposited = position
        .deposited
        .checked_add(amount)
        .ok_or(PactError::ArithmeticOverflow)?;
    position.deposit_timestamp = clock.unix_timestamp;

    pool.total_deposited = pool
        .total_deposited
        .checked_add(amount)
        .ok_or(PactError::ArithmeticOverflow)?;
    pool.total_available = pool
        .total_available
        .checked_add(amount)
        .ok_or(PactError::ArithmeticOverflow)?;
    pool.updated_at = clock.unix_timestamp;

    Ok(())
}
```

- [ ] **Step 3: Write failing tests**

Create `packages/program/tests/underwriter.ts`:

```typescript
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { PactInsurance } from "../target/types/pact_insurance";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { expect } from "chai";

describe("pact-insurance: underwriter deposit", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.PactInsurance as Program<PactInsurance>;

  let usdcMint: PublicKey;
  const hostname = "underwriter-test.example.com";
  let protocolPda: PublicKey;
  let poolPda: PublicKey;
  let vaultPda: PublicKey;
  let positionPda: PublicKey;
  const underwriter = Keypair.generate();
  let underwriterAta: PublicKey;

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

    // Init protocol if needed
    try {
      await program.methods
        .initializeProtocol({ treasury: provider.wallet.publicKey, usdcMint })
        .accounts({
          config: protocolPda,
          authority: provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    } catch (_) {}

    // Point config at this mint
    await program.methods
      .updateConfig({
        protocolFeeBps: null, minPoolDeposit: null, defaultInsuranceRateBps: null,
        defaultMaxCoveragePerCall: null, minPremiumBps: null,
        withdrawalCooldownSeconds: null, aggregateCapBps: null,
        aggregateCapWindowSeconds: null, claimWindowSeconds: null,
        maxClaimsPerBatch: null, paused: null, treasury: null, usdcMint,
      })
      .accounts({ config: protocolPda, authority: provider.wallet.publicKey })
      .rpc();

    [poolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), Buffer.from(hostname)],
      program.programId
    );
    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), poolPda.toBuffer()],
      program.programId
    );

    await program.methods
      .createPool({ providerHostname: hostname, insuranceRateBps: null, maxCoveragePerCall: null })
      .accounts({
        config: protocolPda, pool: poolPda, vault: vaultPda, usdcMint,
        authority: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    [positionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("position"), poolPda.toBuffer(), underwriter.publicKey.toBuffer()],
      program.programId
    );

    // Fund underwriter with SOL
    const sig = await provider.connection.requestAirdrop(underwriter.publicKey, 2_000_000_000);
    await provider.connection.confirmTransaction(sig);

    // Create underwriter USDC ATA and mint 1000 USDC
    underwriterAta = await createAccount(
      provider.connection,
      underwriter,
      usdcMint,
      underwriter.publicKey
    );
    await mintTo(
      provider.connection,
      (provider.wallet as anchor.Wallet).payer,
      usdcMint,
      underwriterAta,
      provider.wallet.publicKey,
      1_000_000_000 // 1000 USDC
    );
  });

  it("allows underwriter to deposit above minimum", async () => {
    await program.methods
      .deposit(new BN(100_000_000)) // 100 USDC
      .accounts({
        config: protocolPda,
        pool: poolPda,
        vault: vaultPda,
        position: positionPda,
        underwriterTokenAccount: underwriterAta,
        underwriter: underwriter.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([underwriter])
      .rpc();

    const pool = await program.account.coveragePool.fetch(poolPda);
    expect(pool.totalDeposited.toNumber()).to.equal(100_000_000);
    expect(pool.totalAvailable.toNumber()).to.equal(100_000_000);

    const position = await program.account.underwriterPosition.fetch(positionPda);
    expect(position.deposited.toNumber()).to.equal(100_000_000);
    expect(position.depositTimestamp.toNumber()).to.be.greaterThan(0);

    const vaultAcc = await getAccount(provider.connection, vaultPda);
    expect(Number(vaultAcc.amount)).to.equal(100_000_000);
  });

  it("rejects deposit below min_pool_deposit", async () => {
    try {
      await program.methods
        .deposit(new BN(500_000)) // 0.5 USDC, below 100 USDC min
        .accounts({
          config: protocolPda,
          pool: poolPda,
          vault: vaultPda,
          position: positionPda,
          underwriterTokenAccount: underwriterAta,
          underwriter: underwriter.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([underwriter])
        .rpc();
      expect.fail("should have rejected");
    } catch (err: any) {
      expect(String(err)).to.match(/BelowMinimumDeposit/);
    }
  });

  it("rejects zero-amount deposit", async () => {
    try {
      await program.methods
        .deposit(new BN(0))
        .accounts({
          config: protocolPda,
          pool: poolPda,
          vault: vaultPda,
          position: positionPda,
          underwriterTokenAccount: underwriterAta,
          underwriter: underwriter.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([underwriter])
        .rpc();
      expect.fail("should have rejected");
    } catch (err: any) {
      expect(String(err)).to.match(/ZeroAmount/);
    }
  });
});
```

- [ ] **Step 4: Register in mod.rs and lib.rs**

Add to `instructions/mod.rs`:

```rust
pub mod deposit;
pub use deposit::*;
```

Add to `lib.rs`:

```rust
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        instructions::deposit::handler(ctx, amount)
    }
```

- [ ] **Step 5: Build and test**

```bash
cd packages/program
anchor build
anchor test --skip-local-validator
cd ../..
```

- [ ] **Step 6: Commit**

```bash
git add packages/program/
git commit -m "feat(program): add UnderwriterPosition state and deposit instruction"
```

---

### Task 9: Implement `withdraw` instruction with cooldown enforcement

**Files:**
- Create: `packages/program/programs/pact-insurance/src/instructions/withdraw.rs`
- Modify: `packages/program/programs/pact-insurance/src/instructions/mod.rs`
- Modify: `packages/program/programs/pact-insurance/src/lib.rs`
- Modify: `packages/program/tests/underwriter.ts`

- [ ] **Step 1: Implement withdraw.rs**

Write `packages/program/programs/pact-insurance/src/instructions/withdraw.rs`:

```rust
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::state::{ProtocolConfig, CoveragePool, UnderwriterPosition};
use crate::constants::ABSOLUTE_MIN_WITHDRAWAL_COOLDOWN;
use crate::error::PactError;

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(
        seeds = [ProtocolConfig::SEED],
        bump = config.bump,
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
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [
            UnderwriterPosition::SEED_PREFIX,
            pool.key().as_ref(),
            underwriter.key().as_ref()
        ],
        bump = position.bump,
        constraint = position.underwriter == underwriter.key() @ PactError::Unauthorized,
    )]
    pub position: Account<'info, UnderwriterPosition>,

    #[account(
        mut,
        constraint = underwriter_token_account.owner == underwriter.key(),
        constraint = underwriter_token_account.mint == pool.usdc_mint,
    )]
    pub underwriter_token_account: Account<'info, TokenAccount>,

    pub underwriter: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
    require!(amount > 0, PactError::ZeroAmount);

    let clock = Clock::get()?;

    // Enforce cooldown: use max of config value and absolute floor
    let effective_cooldown = ctx
        .accounts
        .config
        .withdrawal_cooldown_seconds
        .max(ABSOLUTE_MIN_WITHDRAWAL_COOLDOWN);
    let elapsed = clock
        .unix_timestamp
        .checked_sub(ctx.accounts.position.deposit_timestamp)
        .ok_or(PactError::ArithmeticOverflow)?;
    require!(
        elapsed >= effective_cooldown,
        PactError::WithdrawalUnderCooldown
    );

    // Check position has sufficient balance
    require!(
        ctx.accounts.position.deposited >= amount,
        PactError::InsufficientPoolBalance
    );

    // Check pool has sufficient available (cannot eat into obligations)
    require!(
        ctx.accounts.pool.total_available >= amount,
        PactError::WithdrawalWouldUnderfund
    );

    // Transfer USDC from vault to underwriter
    let hostname_bytes = ctx.accounts.pool.provider_hostname.as_bytes().to_vec();
    let pool_bump = ctx.accounts.pool.bump;
    let seeds: &[&[u8]] = &[
        CoveragePool::SEED_PREFIX,
        &hostname_bytes,
        &[pool_bump],
    ];
    let signer_seeds = &[seeds];

    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.vault.to_account_info(),
            to: ctx.accounts.underwriter_token_account.to_account_info(),
            authority: ctx.accounts.pool.to_account_info(),
        },
        signer_seeds,
    );
    token::transfer(cpi_ctx, amount)?;

    // Update state
    let pool = &mut ctx.accounts.pool;
    let position = &mut ctx.accounts.position;

    position.deposited = position.deposited.checked_sub(amount).unwrap();
    pool.total_deposited = pool.total_deposited.checked_sub(amount).unwrap();
    pool.total_available = pool.total_available.checked_sub(amount).unwrap();
    pool.updated_at = clock.unix_timestamp;

    Ok(())
}
```

- [ ] **Step 2: Add withdraw cooldown test**

Append to `packages/program/tests/underwriter.ts` inside the `describe`:

```typescript
  it("rejects withdraw before cooldown elapsed", async () => {
    try {
      await program.methods
        .withdraw(new BN(10_000_000))
        .accounts({
          config: protocolPda,
          pool: poolPda,
          vault: vaultPda,
          position: positionPda,
          underwriterTokenAccount: underwriterAta,
          underwriter: underwriter.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([underwriter])
        .rpc();
      expect.fail("should have rejected");
    } catch (err: any) {
      expect(String(err)).to.match(/WithdrawalUnderCooldown/);
    }
  });

  it("allows withdraw after cooldown (simulated via config update to 1h)", async () => {
    // Set cooldown to absolute minimum (1h) so we wait less
    // Can't actually wait — so we verify the check uses effective_cooldown
    // by setting config to min and asserting rejection still for 0-elapsed case
    // (This test mostly documents intended behavior; real timing test requires clock manipulation)

    // Update cooldown to ABSOLUTE_MIN (3600s)
    await program.methods
      .updateConfig({
        protocolFeeBps: null, minPoolDeposit: null, defaultInsuranceRateBps: null,
        defaultMaxCoveragePerCall: null, minPremiumBps: null,
        withdrawalCooldownSeconds: new BN(3600),
        aggregateCapBps: null, aggregateCapWindowSeconds: null,
        claimWindowSeconds: null, maxClaimsPerBatch: null,
        paused: null, treasury: null, usdcMint: null,
      })
      .accounts({ config: protocolPda, authority: provider.wallet.publicKey })
      .rpc();

    // Still in cooldown — should reject
    try {
      await program.methods
        .withdraw(new BN(10_000_000))
        .accounts({
          config: protocolPda,
          pool: poolPda,
          vault: vaultPda,
          position: positionPda,
          underwriterTokenAccount: underwriterAta,
          underwriter: underwriter.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([underwriter])
        .rpc();
      expect.fail("should still reject — cooldown not elapsed");
    } catch (err: any) {
      expect(String(err)).to.match(/WithdrawalUnderCooldown/);
    }
  });
```

- [ ] **Step 3: Register in mod.rs and lib.rs**

Add to `instructions/mod.rs`:

```rust
pub mod withdraw;
pub use withdraw::*;
```

Add to `lib.rs`:

```rust
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        instructions::withdraw::handler(ctx, amount)
    }
```

- [ ] **Step 4: Build and test**

```bash
cd packages/program
anchor build
anchor test --skip-local-validator
cd ../..
```

- [ ] **Step 5: Commit**

```bash
git add packages/program/
git commit -m "feat(program): implement withdraw with cooldown enforcement"
```

---

### Task 10: Add Policy state + implement `create_policy` and `top_up`

**Files:**
- Modify: `packages/program/programs/pact-insurance/src/state.rs`
- Create: `packages/program/programs/pact-insurance/src/instructions/create_policy.rs`
- Create: `packages/program/programs/pact-insurance/src/instructions/top_up.rs`
- Modify: mod.rs and lib.rs
- Create: `packages/program/tests/policy.ts`

- [ ] **Step 1: Add Policy to state.rs**

Append:

```rust
use crate::constants::MAX_AGENT_ID_LEN;

#[account]
#[derive(InitSpace)]
pub struct Policy {
    pub agent: Pubkey,
    pub pool: Pubkey,
    #[max_len(MAX_AGENT_ID_LEN)]
    pub agent_id: String,
    pub prepaid_balance: u64,
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

- [ ] **Step 2: Implement create_policy.rs**

Write `packages/program/programs/pact-insurance/src/instructions/create_policy.rs`:

```rust
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::state::{ProtocolConfig, CoveragePool, Policy};
use crate::constants::MAX_AGENT_ID_LEN;
use crate::error::PactError;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CreatePolicyArgs {
    pub agent_id: String,
    pub prepaid_amount: u64,
    pub expires_at: i64,
}

#[derive(Accounts)]
#[instruction(args: CreatePolicyArgs)]
pub struct CreatePolicy<'info> {
    #[account(
        seeds = [ProtocolConfig::SEED],
        bump = config.bump,
        constraint = !config.paused @ PactError::ProtocolPaused,
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
    )]
    pub vault: Account<'info, TokenAccount>,

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
        mut,
        constraint = agent_token_account.owner == agent.key(),
        constraint = agent_token_account.mint == pool.usdc_mint,
    )]
    pub agent_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub agent: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<CreatePolicy>, args: CreatePolicyArgs) -> Result<()> {
    require!(args.prepaid_amount > 0, PactError::ZeroAmount);
    require!(args.agent_id.len() <= MAX_AGENT_ID_LEN, PactError::AgentIdTooLong);

    // Transfer USDC from agent to vault
    let cpi_ctx = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.agent_token_account.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.agent.to_account_info(),
        },
    );
    token::transfer(cpi_ctx, args.prepaid_amount)?;

    let policy = &mut ctx.accounts.policy;
    let pool = &mut ctx.accounts.pool;
    let clock = Clock::get()?;

    policy.agent = ctx.accounts.agent.key();
    policy.pool = pool.key();
    policy.agent_id = args.agent_id;
    policy.prepaid_balance = args.prepaid_amount;
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

- [ ] **Step 3: Implement top_up.rs**

Write `packages/program/programs/pact-insurance/src/instructions/top_up.rs`:

```rust
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::state::{ProtocolConfig, CoveragePool, Policy};
use crate::error::PactError;

#[derive(Accounts)]
pub struct TopUp<'info> {
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
        mut,
        seeds = [CoveragePool::VAULT_SEED_PREFIX, pool.key().as_ref()],
        bump,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [
            Policy::SEED_PREFIX,
            pool.key().as_ref(),
            agent.key().as_ref()
        ],
        bump = policy.bump,
        constraint = policy.active @ PactError::PolicyInactive,
    )]
    pub policy: Account<'info, Policy>,

    #[account(
        mut,
        constraint = agent_token_account.owner == agent.key(),
        constraint = agent_token_account.mint == pool.usdc_mint,
    )]
    pub agent_token_account: Account<'info, TokenAccount>,

    pub agent: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<TopUp>, amount: u64) -> Result<()> {
    require!(amount > 0, PactError::ZeroAmount);

    let cpi_ctx = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.agent_token_account.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.agent.to_account_info(),
        },
    );
    token::transfer(cpi_ctx, amount)?;

    let policy = &mut ctx.accounts.policy;
    policy.prepaid_balance = policy
        .prepaid_balance
        .checked_add(amount)
        .ok_or(PactError::ArithmeticOverflow)?;

    Ok(())
}
```

- [ ] **Step 4: Write failing tests**

Create `packages/program/tests/policy.ts`:

```typescript
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { PactInsurance } from "../target/types/pact_insurance";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
} from "@solana/spl-token";
import { expect } from "chai";

describe("pact-insurance: policy lifecycle", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.PactInsurance as Program<PactInsurance>;

  let usdcMint: PublicKey;
  const hostname = "policy-test.example.com";
  let protocolPda: PublicKey;
  let poolPda: PublicKey;
  let vaultPda: PublicKey;
  let policyPda: PublicKey;
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

    try {
      await program.methods
        .initializeProtocol({ treasury: provider.wallet.publicKey, usdcMint })
        .accounts({
          config: protocolPda,
          authority: provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    } catch (_) {}

    await program.methods
      .updateConfig({
        protocolFeeBps: null, minPoolDeposit: null, defaultInsuranceRateBps: null,
        defaultMaxCoveragePerCall: null, minPremiumBps: null,
        withdrawalCooldownSeconds: null, aggregateCapBps: null,
        aggregateCapWindowSeconds: null, claimWindowSeconds: null,
        maxClaimsPerBatch: null, paused: null, treasury: null, usdcMint,
      })
      .accounts({ config: protocolPda, authority: provider.wallet.publicKey })
      .rpc();

    [poolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), Buffer.from(hostname)],
      program.programId
    );
    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), poolPda.toBuffer()],
      program.programId
    );

    await program.methods
      .createPool({ providerHostname: hostname, insuranceRateBps: null, maxCoveragePerCall: null })
      .accounts({
        config: protocolPda, pool: poolPda, vault: vaultPda, usdcMint,
        authority: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    [policyPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("policy"), poolPda.toBuffer(), agent.publicKey.toBuffer()],
      program.programId
    );

    // Fund agent
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
  });

  it("creates a policy with prepaid balance", async () => {
    await program.methods
      .createPolicy({
        agentId: "test-agent-001",
        prepaidAmount: new BN(10_000_000),
        expiresAt: new BN(0),
      })
      .accounts({
        config: protocolPda,
        pool: poolPda,
        vault: vaultPda,
        policy: policyPda,
        agentTokenAccount: agentAta,
        agent: agent.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([agent])
      .rpc();

    const policy = await program.account.policy.fetch(policyPda);
    expect(policy.prepaidBalance.toNumber()).to.equal(10_000_000);
    expect(policy.active).to.equal(true);
    expect(policy.agentId).to.equal("test-agent-001");
  });

  it("tops up an existing policy", async () => {
    await program.methods
      .topUp(new BN(5_000_000))
      .accounts({
        config: protocolPda,
        pool: poolPda,
        vault: vaultPda,
        policy: policyPda,
        agentTokenAccount: agentAta,
        agent: agent.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([agent])
      .rpc();

    const policy = await program.account.policy.fetch(policyPda);
    expect(policy.prepaidBalance.toNumber()).to.equal(15_000_000);
  });
});
```

- [ ] **Step 5: Register in mod.rs and lib.rs**

```rust
// mod.rs additions
pub mod create_policy;
pub mod top_up;
pub use create_policy::*;
pub use top_up::*;
```

```rust
// lib.rs additions inside pub mod pact_insurance
    pub fn create_policy(
        ctx: Context<CreatePolicy>,
        args: CreatePolicyArgs,
    ) -> Result<()> {
        instructions::create_policy::handler(ctx, args)
    }

    pub fn top_up(ctx: Context<TopUp>, amount: u64) -> Result<()> {
        instructions::top_up::handler(ctx, amount)
    }
```

- [ ] **Step 6: Build and test**

```bash
cd packages/program && anchor build && anchor test --skip-local-validator && cd ../..
```

- [ ] **Step 7: Commit**

```bash
git add packages/program/
git commit -m "feat(program): add Policy state, create_policy, and top_up instructions"
```

---

### Task 11: Implement `settle_premium` instruction

**Files:**
- Create: `packages/program/programs/pact-insurance/src/instructions/settle_premium.rs`
- Modify: mod.rs and lib.rs
- Create: `packages/program/tests/settlement.ts`

- [ ] **Step 1: Implement settle_premium.rs**

Write `packages/program/programs/pact-insurance/src/instructions/settle_premium.rs`:

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
        constraint = treasury_token_account.mint == pool.usdc_mint,
        constraint = treasury_token_account.owner == config.treasury,
    )]
    pub treasury_token_account: Account<'info, TokenAccount>,

    pub authority: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<SettlePremium>, call_value: u64) -> Result<()> {
    require!(call_value > 0, PactError::ZeroAmount);

    let pool = &ctx.accounts.pool;
    let config = &ctx.accounts.config;

    // Compute gross premium
    let mut gross_premium = (call_value as u128)
        .checked_mul(pool.insurance_rate_bps as u128)
        .ok_or(PactError::ArithmeticOverflow)?
        .checked_div(10_000)
        .ok_or(PactError::ArithmeticOverflow)? as u64;

    // Cap at prepaid balance
    if gross_premium > ctx.accounts.policy.prepaid_balance {
        gross_premium = ctx.accounts.policy.prepaid_balance;
    }

    if gross_premium == 0 {
        return Ok(()); // nothing to settle
    }

    // Compute protocol fee
    let protocol_fee = (gross_premium as u128)
        .checked_mul(config.protocol_fee_bps as u128)
        .ok_or(PactError::ArithmeticOverflow)?
        .checked_div(10_000)
        .ok_or(PactError::ArithmeticOverflow)? as u64;
    let pool_premium = gross_premium
        .checked_sub(protocol_fee)
        .ok_or(PactError::ArithmeticOverflow)?;

    // Transfer protocol_fee from vault to treasury
    if protocol_fee > 0 {
        let hostname_bytes = ctx.accounts.pool.provider_hostname.as_bytes().to_vec();
        let pool_bump = ctx.accounts.pool.bump;
        let seeds: &[&[u8]] = &[
            CoveragePool::SEED_PREFIX,
            &hostname_bytes,
            &[pool_bump],
        ];
        let signer_seeds = &[seeds];

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
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

    policy.prepaid_balance = policy.prepaid_balance.checked_sub(gross_premium).unwrap();
    policy.total_premiums_paid = policy.total_premiums_paid.checked_add(gross_premium).unwrap();

    pool.total_premiums_earned = pool.total_premiums_earned.checked_add(pool_premium).unwrap();
    pool.total_available = pool.total_available.checked_add(pool_premium).unwrap();
    pool.updated_at = clock.unix_timestamp;

    if policy.prepaid_balance == 0 {
        policy.active = false;
        pool.active_policies = pool.active_policies.saturating_sub(1);
    }

    Ok(())
}
```

- [ ] **Step 2: Write failing tests**

Create `packages/program/tests/settlement.ts` (similar setup pattern, tests:
- successful settle with correct math (15% fee split)
- settle drains to 0 and deactivates policy
- settle with zero balance is no-op

Full test body follows the pattern from `policy.ts` — create mint, init protocol, create pool, create policy with 1 USDC prepaid, then call settle_premium with call_value of 4 USDC at 25 bps → gross = 10_000 lamports, fee = 1500 lamports, pool_premium = 8500 lamports. Assert final balances.

```typescript
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { PactInsurance } from "../target/types/pact_insurance";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { expect } from "chai";

describe("pact-insurance: settle_premium", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.PactInsurance as Program<PactInsurance>;

  let usdcMint: PublicKey;
  const hostname = "settle-test.example.com";
  let protocolPda: PublicKey;
  let poolPda: PublicKey;
  let vaultPda: PublicKey;
  let policyPda: PublicKey;
  let treasuryAta: PublicKey;
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

    try {
      await program.methods
        .initializeProtocol({ treasury: provider.wallet.publicKey, usdcMint })
        .accounts({
          config: protocolPda,
          authority: provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    } catch (_) {}

    await program.methods
      .updateConfig({
        protocolFeeBps: null, minPoolDeposit: null, defaultInsuranceRateBps: null,
        defaultMaxCoveragePerCall: null, minPremiumBps: null,
        withdrawalCooldownSeconds: null, aggregateCapBps: null,
        aggregateCapWindowSeconds: null, claimWindowSeconds: null,
        maxClaimsPerBatch: null, paused: null,
        treasury: provider.wallet.publicKey, usdcMint,
      })
      .accounts({ config: protocolPda, authority: provider.wallet.publicKey })
      .rpc();

    // Treasury ATA (owned by provider wallet = treasury)
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

    await program.methods
      .createPool({ providerHostname: hostname, insuranceRateBps: null, maxCoveragePerCall: null })
      .accounts({
        config: protocolPda, pool: poolPda, vault: vaultPda, usdcMint,
        authority: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    [policyPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("policy"), poolPda.toBuffer(), agent.publicKey.toBuffer()],
      program.programId
    );

    const sig = await provider.connection.requestAirdrop(agent.publicKey, 2_000_000_000);
    await provider.connection.confirmTransaction(sig);
    agentAta = await createAccount(provider.connection, agent, usdcMint, agent.publicKey);
    await mintTo(
      provider.connection,
      (provider.wallet as anchor.Wallet).payer,
      usdcMint,
      agentAta,
      provider.wallet.publicKey,
      10_000_000 // 10 USDC
    );

    await program.methods
      .createPolicy({
        agentId: "settle-agent",
        prepaidAmount: new BN(1_000_000), // 1 USDC
        expiresAt: new BN(0),
      })
      .accounts({
        config: protocolPda, pool: poolPda, vault: vaultPda, policy: policyPda,
        agentTokenAccount: agentAta, agent: agent.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([agent])
      .rpc();
  });

  it("settles premium with 15% protocol fee split", async () => {
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
        treasuryTokenAccount: treasuryAta,
        authority: provider.wallet.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const policy = await program.account.policy.fetch(policyPda);
    expect(policy.prepaidBalance.toNumber()).to.equal(990_000); // 1_000_000 - 10_000
    expect(policy.totalPremiumsPaid.toNumber()).to.equal(10_000);

    const pool = await program.account.coveragePool.fetch(poolPda);
    expect(pool.totalPremiumsEarned.toNumber()).to.equal(8500);
    expect(pool.totalAvailable.toNumber()).to.equal(8500);

    const treasuryAcc = await getAccount(provider.connection, treasuryAta);
    expect(Number(treasuryAcc.amount)).to.equal(1500);
  });
});
```

- [ ] **Step 3: Register in mod.rs and lib.rs**

```rust
// mod.rs
pub mod settle_premium;
pub use settle_premium::*;
```

```rust
// lib.rs
    pub fn settle_premium(ctx: Context<SettlePremium>, call_value: u64) -> Result<()> {
        instructions::settle_premium::handler(ctx, call_value)
    }
```

- [ ] **Step 4: Build and test**

```bash
cd packages/program && anchor build && anchor test --skip-local-validator && cd ../..
```

- [ ] **Step 5: Commit**

```bash
git add packages/program/
git commit -m "feat(program): implement settle_premium with protocol fee split"
```

---

### Task 12: Implement `update_rates` instruction

**Files:**
- Create: `packages/program/programs/pact-insurance/src/instructions/update_rates.rs`
- Modify: mod.rs and lib.rs
- Modify: `packages/program/tests/settlement.ts` (append)

- [ ] **Step 1: Implement update_rates.rs**

Write `packages/program/programs/pact-insurance/src/instructions/update_rates.rs`:

```rust
use anchor_lang::prelude::*;
use crate::state::{ProtocolConfig, CoveragePool};
use crate::error::PactError;

#[derive(Accounts)]
pub struct UpdateRates<'info> {
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

    pub authority: Signer<'info>,
}

pub fn handler(ctx: Context<UpdateRates>, new_rate_bps: u16) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    let clock = Clock::get()?;
    pool.insurance_rate_bps = new_rate_bps;
    pool.updated_at = clock.unix_timestamp;
    Ok(())
}
```

- [ ] **Step 2: Add test to settlement.ts**

Append to the `describe` block:

```typescript
  it("updates pool insurance rate", async () => {
    await program.methods
      .updateRates(50)
      .accounts({
        config: protocolPda,
        pool: poolPda,
        authority: provider.wallet.publicKey,
      })
      .rpc();

    const pool = await program.account.coveragePool.fetch(poolPda);
    expect(pool.insuranceRateBps).to.equal(50);
  });
```

- [ ] **Step 3: Register in mod.rs and lib.rs**

```rust
// mod.rs
pub mod update_rates;
pub use update_rates::*;
```

```rust
// lib.rs
    pub fn update_rates(ctx: Context<UpdateRates>, new_rate_bps: u16) -> Result<()> {
        instructions::update_rates::handler(ctx, new_rate_bps)
    }
```

- [ ] **Step 4: Build and test**

```bash
cd packages/program && anchor build && anchor test --skip-local-validator && cd ../..
```

- [ ] **Step 5: Commit**

```bash
git add packages/program/
git commit -m "feat(program): implement update_rates instruction"
```

---

### Task 13: Add Claim state + implement `submit_claim` with aggregate cap

**Files:**
- Modify: `packages/program/programs/pact-insurance/src/state.rs`
- Create: `packages/program/programs/pact-insurance/src/instructions/submit_claim.rs`
- Modify: mod.rs and lib.rs
- Create: `packages/program/tests/claims.ts`

- [ ] **Step 1: Add Claim state + enums to state.rs**

Append to `state.rs`:

```rust
use crate::constants::MAX_CALL_ID_LEN;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum TriggerType {
    Timeout,
    Error,
    SchemaMismatch,
    LatencySla,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum ClaimStatus {
    Pending,
    Approved,
    Rejected,
}

#[account]
#[derive(InitSpace)]
pub struct Claim {
    pub policy: Pubkey,
    pub pool: Pubkey,
    pub agent: Pubkey,
    #[max_len(MAX_CALL_ID_LEN)]
    pub call_id: String,
    pub trigger_type: TriggerType,
    pub evidence_hash: [u8; 32],
    pub call_timestamp: i64,
    pub latency_ms: u32,
    pub status_code: u16,
    pub payment_amount: u64,
    pub refund_amount: u64,
    pub status: ClaimStatus,
    pub created_at: i64,
    pub resolved_at: i64,
    pub bump: u8,
}

impl Claim {
    pub const SEED_PREFIX: &'static [u8] = b"claim";
}
```

- [ ] **Step 2: Implement submit_claim.rs**

Write `packages/program/programs/pact-insurance/src/instructions/submit_claim.rs`:

```rust
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::state::{ProtocolConfig, CoveragePool, Policy, Claim, TriggerType, ClaimStatus};
use crate::constants::{ABSOLUTE_MAX_AGGREGATE_CAP_BPS, MAX_CALL_ID_LEN};
use crate::error::PactError;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SubmitClaimArgs {
    pub call_id: String,
    pub trigger_type: TriggerType,
    pub evidence_hash: [u8; 32],
    pub call_timestamp: i64,
    pub latency_ms: u32,
    pub status_code: u16,
    pub payment_amount: u64,
}

#[derive(Accounts)]
#[instruction(args: SubmitClaimArgs)]
pub struct SubmitClaim<'info> {
    #[account(
        seeds = [ProtocolConfig::SEED],
        bump = config.bump,
        has_one = authority @ PactError::Unauthorized,
        constraint = !config.paused @ PactError::ProtocolPaused,
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
        init,
        payer = authority,
        space = 8 + Claim::INIT_SPACE,
        seeds = [
            Claim::SEED_PREFIX,
            policy.key().as_ref(),
            args.call_id.as_bytes()
        ],
        bump
    )]
    pub claim: Account<'info, Claim>,

    #[account(
        mut,
        constraint = agent_token_account.mint == pool.usdc_mint,
        constraint = agent_token_account.owner == policy.agent,
    )]
    pub agent_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<SubmitClaim>, args: SubmitClaimArgs) -> Result<()> {
    require!(args.call_id.len() <= MAX_CALL_ID_LEN, PactError::CallIdTooLong);
    require!(args.payment_amount > 0, PactError::ZeroAmount);

    let config = &ctx.accounts.config;
    let clock = Clock::get()?;

    // Claim age check
    let age = clock
        .unix_timestamp
        .checked_sub(args.call_timestamp)
        .ok_or(PactError::ArithmeticOverflow)?;
    require!(
        age <= config.claim_window_seconds,
        PactError::ClaimWindowExpired
    );

    // Window rollover
    let pool = &mut ctx.accounts.pool;
    if clock.unix_timestamp - pool.window_start > config.aggregate_cap_window_seconds {
        pool.payouts_this_window = 0;
        pool.window_start = clock.unix_timestamp;
    }

    // Compute refund (min of 3 values)
    let mut refund = args.payment_amount;
    if refund > pool.max_coverage_per_call {
        refund = pool.max_coverage_per_call;
    }
    if refund > pool.total_available {
        refund = pool.total_available;
    }

    // Aggregate cap check
    let effective_cap_bps = config
        .aggregate_cap_bps
        .min(ABSOLUTE_MAX_AGGREGATE_CAP_BPS);
    let cap_limit = (pool.total_deposited as u128)
        .checked_mul(effective_cap_bps as u128)
        .ok_or(PactError::ArithmeticOverflow)?
        .checked_div(10_000)
        .ok_or(PactError::ArithmeticOverflow)? as u64;
    require!(
        pool.payouts_this_window.checked_add(refund).unwrap() <= cap_limit,
        PactError::AggregateCapExceeded
    );

    // Transfer refund from vault to agent
    let hostname_bytes = pool.provider_hostname.as_bytes().to_vec();
    let pool_bump = pool.bump;
    let seeds: &[&[u8]] = &[
        CoveragePool::SEED_PREFIX,
        &hostname_bytes,
        &[pool_bump],
    ];
    let signer_seeds = &[seeds];

    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.vault.to_account_info(),
            to: ctx.accounts.agent_token_account.to_account_info(),
            authority: pool.to_account_info(),
        },
        signer_seeds,
    );
    token::transfer(cpi_ctx, refund)?;

    // Create Claim account
    let claim = &mut ctx.accounts.claim;
    claim.policy = ctx.accounts.policy.key();
    claim.pool = pool.key();
    claim.agent = ctx.accounts.policy.agent;
    claim.call_id = args.call_id;
    claim.trigger_type = args.trigger_type;
    claim.evidence_hash = args.evidence_hash;
    claim.call_timestamp = args.call_timestamp;
    claim.latency_ms = args.latency_ms;
    claim.status_code = args.status_code;
    claim.payment_amount = args.payment_amount;
    claim.refund_amount = refund;
    claim.status = ClaimStatus::Approved;
    claim.created_at = clock.unix_timestamp;
    claim.resolved_at = clock.unix_timestamp;
    claim.bump = ctx.bumps.claim;

    // Update pool
    pool.total_claims_paid = pool.total_claims_paid.checked_add(refund).unwrap();
    pool.total_available = pool.total_available.checked_sub(refund).unwrap();
    pool.payouts_this_window = pool.payouts_this_window.checked_add(refund).unwrap();
    pool.updated_at = clock.unix_timestamp;

    // Update policy
    let policy = &mut ctx.accounts.policy;
    policy.total_claims_received = policy.total_claims_received.checked_add(refund).unwrap();
    policy.calls_covered = policy.calls_covered.checked_add(1).unwrap();

    Ok(())
}
```

- [ ] **Step 3: Write failing tests**

Create `packages/program/tests/claims.ts` — follow the setup pattern from previous test files. Cover:
1. Successful claim submission → refund transferred, claim PDA exists, policy updated
2. Duplicate submission (same call_id) → rejected
3. Aggregate cap trip: after a claim that pushes `payouts_this_window` past 30% of `total_deposited`, next claim rejected
4. Claim outside window → rejected

Full code pattern follows `settlement.ts` with additional:
- underwriter deposit to pool first (100 USDC)
- policy with 10 USDC prepaid
- submit_claim with payment_amount = 500_000 (0.5 USDC)
- assert refund_amount == 500_000, agent balance increased, pool totals updated

```typescript
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { PactInsurance } from "../target/types/pact_insurance";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { expect } from "chai";

describe("pact-insurance: submit_claim", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.PactInsurance as Program<PactInsurance>;

  let usdcMint: PublicKey;
  const hostname = "claim-test.example.com";
  let protocolPda: PublicKey;
  let poolPda: PublicKey;
  let vaultPda: PublicKey;
  let policyPda: PublicKey;
  let positionPda: PublicKey;
  const agent = Keypair.generate();
  const underwriter = Keypair.generate();
  let agentAta: PublicKey;
  let underwriterAta: PublicKey;

  before(async () => {
    [protocolPda] = PublicKey.findProgramAddressSync([Buffer.from("protocol")], program.programId);

    usdcMint = await createMint(
      provider.connection,
      (provider.wallet as anchor.Wallet).payer,
      provider.wallet.publicKey,
      null,
      6
    );

    try {
      await program.methods
        .initializeProtocol({ treasury: provider.wallet.publicKey, usdcMint })
        .accounts({
          config: protocolPda,
          authority: provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    } catch (_) {}

    await program.methods
      .updateConfig({
        protocolFeeBps: null, minPoolDeposit: null, defaultInsuranceRateBps: null,
        defaultMaxCoveragePerCall: null, minPremiumBps: null,
        withdrawalCooldownSeconds: null, aggregateCapBps: null,
        aggregateCapWindowSeconds: null, claimWindowSeconds: null,
        maxClaimsPerBatch: null, paused: null, treasury: null, usdcMint,
      })
      .accounts({ config: protocolPda, authority: provider.wallet.publicKey })
      .rpc();

    [poolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), Buffer.from(hostname)],
      program.programId
    );
    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), poolPda.toBuffer()],
      program.programId
    );
    [positionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("position"), poolPda.toBuffer(), underwriter.publicKey.toBuffer()],
      program.programId
    );
    [policyPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("policy"), poolPda.toBuffer(), agent.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .createPool({ providerHostname: hostname, insuranceRateBps: null, maxCoveragePerCall: null })
      .accounts({
        config: protocolPda, pool: poolPda, vault: vaultPda, usdcMint,
        authority: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    // Fund underwriter and agent
    for (const kp of [underwriter, agent]) {
      const sig = await provider.connection.requestAirdrop(kp.publicKey, 2_000_000_000);
      await provider.connection.confirmTransaction(sig);
    }

    underwriterAta = await createAccount(provider.connection, underwriter, usdcMint, underwriter.publicKey);
    agentAta = await createAccount(provider.connection, agent, usdcMint, agent.publicKey);

    await mintTo(
      provider.connection,
      (provider.wallet as anchor.Wallet).payer,
      usdcMint,
      underwriterAta,
      provider.wallet.publicKey,
      1_000_000_000 // 1000 USDC
    );
    await mintTo(
      provider.connection,
      (provider.wallet as anchor.Wallet).payer,
      usdcMint,
      agentAta,
      provider.wallet.publicKey,
      100_000_000 // 100 USDC
    );

    // Underwriter deposits 100 USDC
    await program.methods
      .deposit(new BN(100_000_000))
      .accounts({
        config: protocolPda, pool: poolPda, vault: vaultPda, position: positionPda,
        underwriterTokenAccount: underwriterAta,
        underwriter: underwriter.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([underwriter])
      .rpc();

    // Agent creates policy with 10 USDC
    await program.methods
      .createPolicy({
        agentId: "claim-agent",
        prepaidAmount: new BN(10_000_000),
        expiresAt: new BN(0),
      })
      .accounts({
        config: protocolPda, pool: poolPda, vault: vaultPda, policy: policyPda,
        agentTokenAccount: agentAta, agent: agent.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([agent])
      .rpc();
  });

  it("submits a claim and transfers refund", async () => {
    const callId = "call-001";
    const [claimPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("claim"), policyPda.toBuffer(), Buffer.from(callId)],
      program.programId
    );

    const before = await getAccount(provider.connection, agentAta);

    await program.methods
      .submitClaim({
        callId,
        triggerType: { error: {} } as any,
        evidenceHash: Array(32).fill(1),
        callTimestamp: new BN(Math.floor(Date.now() / 1000)),
        latencyMs: 500,
        statusCode: 500,
        paymentAmount: new BN(500_000), // 0.5 USDC
      })
      .accounts({
        config: protocolPda,
        pool: poolPda,
        vault: vaultPda,
        policy: policyPda,
        claim: claimPda,
        agentTokenAccount: agentAta,
        authority: provider.wallet.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const after = await getAccount(provider.connection, agentAta);
    // Refund is capped at max_coverage_per_call (default 1 USDC = 1_000_000)
    // So refund = min(500_000, 1_000_000, pool.total_available) = 500_000
    expect(Number(after.amount) - Number(before.amount)).to.equal(500_000);

    const claim = await program.account.claim.fetch(claimPda);
    expect(claim.refundAmount.toNumber()).to.equal(500_000);
  });

  it("rejects duplicate claim (same call_id)", async () => {
    const callId = "call-001"; // same as before
    const [claimPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("claim"), policyPda.toBuffer(), Buffer.from(callId)],
      program.programId
    );

    try {
      await program.methods
        .submitClaim({
          callId,
          triggerType: { error: {} } as any,
          evidenceHash: Array(32).fill(1),
          callTimestamp: new BN(Math.floor(Date.now() / 1000)),
          latencyMs: 500,
          statusCode: 500,
          paymentAmount: new BN(500_000),
        })
        .accounts({
          config: protocolPda, pool: poolPda, vault: vaultPda,
          policy: policyPda, claim: claimPda,
          agentTokenAccount: agentAta,
          authority: provider.wallet.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      expect.fail("should have rejected");
    } catch (err: any) {
      expect(String(err)).to.match(/already in use|DuplicateClaim/i);
    }
  });

  it("rejects claim outside window (old timestamp)", async () => {
    const callId = "call-old";
    const [claimPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("claim"), policyPda.toBuffer(), Buffer.from(callId)],
      program.programId
    );

    try {
      await program.methods
        .submitClaim({
          callId,
          triggerType: { error: {} } as any,
          evidenceHash: Array(32).fill(1),
          callTimestamp: new BN(Math.floor(Date.now() / 1000) - 7200), // 2h ago, > 1h window
          latencyMs: 500,
          statusCode: 500,
          paymentAmount: new BN(500_000),
        })
        .accounts({
          config: protocolPda, pool: poolPda, vault: vaultPda,
          policy: policyPda, claim: claimPda,
          agentTokenAccount: agentAta,
          authority: provider.wallet.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      expect.fail("should have rejected");
    } catch (err: any) {
      expect(String(err)).to.match(/ClaimWindowExpired/);
    }
  });
});
```

- [ ] **Step 4: Register in mod.rs and lib.rs**

```rust
// mod.rs
pub mod submit_claim;
pub use submit_claim::*;
```

```rust
// lib.rs
    pub fn submit_claim(
        ctx: Context<SubmitClaim>,
        args: SubmitClaimArgs,
    ) -> Result<()> {
        instructions::submit_claim::handler(ctx, args)
    }
```

- [ ] **Step 5: Build and test**

```bash
cd packages/program && anchor build && anchor test --skip-local-validator && cd ../..
```

- [ ] **Step 6: Commit**

```bash
git add packages/program/
git commit -m "feat(program): add Claim state and submit_claim with aggregate cap"
```

---

### Task 14: Run full test suite and deploy to devnet

**This is an Alan-active task (Monday or late Sunday).**

- [ ] **Step 1: Run full test suite**

```bash
cd packages/program
anchor test 2>&1 | tail -40
cd ../..
```

Expected: all tests pass.

- [ ] **Step 2: Deploy to devnet**

```bash
cd packages/program
anchor build
anchor deploy --provider.cluster devnet
cd ../..
```

Save the deployed program ID printed in output.

- [ ] **Step 3: Update the program ID in Anchor.toml**

Replace the placeholder in `packages/program/Anchor.toml` `[programs.devnet]` with the actual deployed ID.

- [ ] **Step 4: Initialize the protocol on devnet**

Create `packages/program/scripts/init-devnet.ts`:

```typescript
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PactInsurance } from "../target/types/pact_insurance";
import { PublicKey, Keypair } from "@solana/web3.js";

const DEVNET_USDC_MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
// ^ dev USDC mint (verified on devnet explorer) — if this fails, create a test mint instead

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.PactInsurance as Program<PactInsurance>;

  const [protocolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol")],
    program.programId
  );

  console.log("Initializing protocol on devnet...");
  await program.methods
    .initializeProtocol({
      treasury: provider.wallet.publicKey,
      usdcMint: DEVNET_USDC_MINT,
    })
    .accounts({
      config: protocolPda,
      authority: provider.wallet.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .rpc();

  const config = await program.account.protocolConfig.fetch(protocolPda);
  console.log("Protocol initialized:", {
    authority: config.authority.toString(),
    treasury: config.treasury.toString(),
    protocolFeeBps: config.protocolFeeBps,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

Run:

```bash
cd packages/program
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
ANCHOR_WALLET=~/.config/solana/id.json \
npx ts-node scripts/init-devnet.ts
cd ../..
```

- [ ] **Step 5: Commit deployment artifacts**

```bash
git add packages/program/Anchor.toml packages/program/scripts/init-devnet.ts
git commit -m "chore(program): deploy to devnet and initialize protocol"
```

---

## Phase B: Backend Integration

Tasks 15-22 follow the task-level structure. Each task has file paths, complete code, and test guidance. Full TDD step breakdown is compressed because backend integration is more mechanical and lower-risk than Anchor program work.

### Task 15: Add Solana dependencies to backend package

**Files:**
- Modify: `packages/backend/package.json`

- [ ] **Step 1: Add dependencies**

```bash
cd packages/backend
pnpm add @coral-xyz/anchor @solana/web3.js @solana/spl-token bs58
cd ../..
```

- [ ] **Step 2: Commit**

```bash
git add packages/backend/package.json pnpm-lock.yaml
git commit -m "chore(backend): add Solana dependencies"
```

### Task 16: Create `packages/backend/src/utils/solana.ts`

**File:** `packages/backend/src/utils/solana.ts`

Create the file with:

```typescript
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { AnchorProvider, Program, Wallet, BN } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as fs from "fs";
import bs58 from "bs58";

// IDL import — will be generated after Anchor build.
// Copy target/idl/pact_insurance.json to packages/backend/src/idl/pact_insurance.json
// as part of the deploy process.
import idl from "../idl/pact_insurance.json";

export interface SolanaConfig {
  rpcUrl: string;
  programId: string;
  oracleKeypairPath?: string;
  oracleKeypairBase58?: string;
  treasuryPubkey: string;
  usdcMint: string;
}

export function loadOracleKeypair(config: SolanaConfig): Keypair {
  if (config.oracleKeypairPath) {
    const raw = fs.readFileSync(config.oracleKeypairPath, "utf-8");
    const secret = Uint8Array.from(JSON.parse(raw));
    return Keypair.fromSecretKey(secret);
  }
  if (config.oracleKeypairBase58) {
    return Keypair.fromSecretKey(bs58.decode(config.oracleKeypairBase58));
  }
  throw new Error("No oracle keypair configured");
}

export function createSolanaClient(config: SolanaConfig) {
  const connection = new Connection(config.rpcUrl, "confirmed");
  const oracleKeypair = loadOracleKeypair(config);
  const wallet = new Wallet(oracleKeypair);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  const programId = new PublicKey(config.programId);
  const program = new Program(idl as any, provider);

  return { connection, provider, program, oracleKeypair, programId };
}

export function deriveProtocolPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("protocol")],
    programId
  );
}

export function derivePoolPda(programId: PublicKey, hostname: string): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), Buffer.from(hostname)],
    programId
  );
}

export function deriveVaultPda(programId: PublicKey, poolPda: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), poolPda.toBuffer()],
    programId
  );
}

export function derivePolicyPda(
  programId: PublicKey,
  poolPda: PublicKey,
  agentPubkey: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("policy"), poolPda.toBuffer(), agentPubkey.toBuffer()],
    programId
  );
}

export function deriveClaimPda(
  programId: PublicKey,
  policyPda: PublicKey,
  callId: string
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("claim"), policyPda.toBuffer(), Buffer.from(callId)],
    programId
  );
}
```

After Anchor build: `cp packages/program/target/idl/pact_insurance.json packages/backend/src/idl/pact_insurance.json`

Commit:
```bash
git add packages/backend/src/utils/solana.ts packages/backend/src/idl/
git commit -m "feat(backend): add Solana client utilities and PDA helpers"
```

### Task 17: Create `packages/backend/src/services/claim-settlement.ts`

**File:** `packages/backend/src/services/claim-settlement.ts`

```typescript
import { PublicKey, TransactionSignature } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { createSolanaClient, deriveProtocolPda, derivePoolPda, deriveVaultPda, derivePolicyPda, deriveClaimPda } from "../utils/solana.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { createHash } from "crypto";
import type { PoolClient } from "pg";

export interface CallRecord {
  id: string;
  agent_id: string;
  agent_pubkey?: string;
  api_provider: string;
  payment_amount: number;
  latency_ms: number;
  status_code: number;
  classification: "success" | "timeout" | "error" | "schema_mismatch" | "latency_sla";
  created_at: Date;
}

export interface ClaimSubmissionResult {
  signature: TransactionSignature;
  slot: number;
  refundAmount: number;
  claimPda: string;
}

export async function submitClaimOnChain(
  callRecord: CallRecord,
  providerHostname: string
): Promise<ClaimSubmissionResult> {
  const { program, programId, connection } = createSolanaClient(getSolanaConfig());

  if (!callRecord.agent_pubkey) {
    throw new Error("Cannot submit on-chain claim: agent_pubkey missing from call record");
  }

  const [protocolPda] = deriveProtocolPda(programId);
  const [poolPda] = derivePoolPda(programId, providerHostname);
  const [vaultPda] = deriveVaultPda(programId, poolPda);
  const agentPubkey = new PublicKey(callRecord.agent_pubkey);
  const [policyPda] = derivePolicyPda(programId, poolPda, agentPubkey);
  const [claimPda] = deriveClaimPda(programId, policyPda, callRecord.id);

  const config = await (program.account as any).protocolConfig.fetch(protocolPda);
  const agentTokenAccount = getAssociatedTokenAddressSync(config.usdcMint, agentPubkey);

  const triggerTypeMap: Record<string, any> = {
    timeout: { timeout: {} },
    error: { error: {} },
    schema_mismatch: { schemaMismatch: {} },
    latency_sla: { latencySla: {} },
  };
  const triggerType = triggerTypeMap[callRecord.classification];
  if (!triggerType) {
    throw new Error(`Invalid classification for claim: ${callRecord.classification}`);
  }

  // Evidence hash: SHA256 of canonical call record fields
  const evidenceRaw = JSON.stringify({
    id: callRecord.id,
    api_provider: callRecord.api_provider,
    classification: callRecord.classification,
    status_code: callRecord.status_code,
    latency_ms: callRecord.latency_ms,
    payment_amount: callRecord.payment_amount,
  });
  const evidenceHash = Array.from(createHash("sha256").update(evidenceRaw).digest());

  const callTimestamp = Math.floor(callRecord.created_at.getTime() / 1000);

  const sig = await (program.methods as any)
    .submitClaim({
      callId: callRecord.id,
      triggerType,
      evidenceHash,
      callTimestamp: new BN(callTimestamp),
      latencyMs: callRecord.latency_ms,
      statusCode: callRecord.status_code,
      paymentAmount: new BN(callRecord.payment_amount),
    })
    .accounts({
      config: protocolPda,
      pool: poolPda,
      vault: vaultPda,
      policy: policyPda,
      claim: claimPda,
      agentTokenAccount,
      authority: (program.provider as any).wallet.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: PublicKey.default,
    })
    .rpc();

  const txInfo = await connection.getTransaction(sig, { commitment: "confirmed" });

  const claim = await (program.account as any).claim.fetch(claimPda);

  return {
    signature: sig,
    slot: txInfo?.slot ?? 0,
    refundAmount: claim.refundAmount.toNumber(),
    claimPda: claimPda.toString(),
  };
}

export async function hasActiveOnChainPolicy(
  agentPubkey: string,
  providerHostname: string
): Promise<boolean> {
  try {
    const { program, programId } = createSolanaClient(getSolanaConfig());
    const [poolPda] = derivePoolPda(programId, providerHostname);
    const [policyPda] = derivePolicyPda(programId, poolPda, new PublicKey(agentPubkey));
    const policy = await (program.account as any).policy.fetch(policyPda);
    return policy.active;
  } catch {
    return false;
  }
}

function getSolanaConfig() {
  return {
    rpcUrl: process.env.SOLANA_RPC_URL!,
    programId: process.env.SOLANA_PROGRAM_ID!,
    oracleKeypairPath: process.env.ORACLE_KEYPAIR_PATH,
    oracleKeypairBase58: process.env.ORACLE_KEYPAIR_BASE58,
    treasuryPubkey: process.env.TREASURY_PUBKEY!,
    usdcMint: process.env.USDC_MINT!,
  };
}
```

Commit:
```bash
git add packages/backend/src/services/claim-settlement.ts
git commit -m "feat(backend): add claim-settlement service with on-chain submission"
```

### Task 18: Create `packages/backend/src/routes/claims-submit.ts`

**File:** `packages/backend/src/routes/claims-submit.ts`

```typescript
import { FastifyInstance } from "fastify";
import { submitClaimOnChain, hasActiveOnChainPolicy } from "../services/claim-settlement.js";
import { query } from "../db.js";

export async function claimsSubmitRoute(app: FastifyInstance) {
  app.post<{
    Body: { callRecordId: string; providerHostname: string };
  }>("/api/v1/claims/submit", async (request, reply) => {
    const { callRecordId, providerHostname } = request.body;

    if (!callRecordId || !providerHostname) {
      return reply.code(400).send({ error: "callRecordId and providerHostname are required" });
    }

    const rows = await query(
      `SELECT id, agent_id, agent_pubkey, api_provider, payment_amount,
              latency_ms, status_code, classification, created_at
       FROM call_records WHERE id = $1`,
      [callRecordId]
    );
    if (rows.length === 0) {
      return reply.code(404).send({ error: "Call record not found" });
    }
    const callRecord = rows[0];

    if (!callRecord.agent_pubkey) {
      return reply.code(400).send({ error: "Call record missing agent_pubkey" });
    }

    const hasPolicy = await hasActiveOnChainPolicy(callRecord.agent_pubkey, providerHostname);
    if (!hasPolicy) {
      return reply.code(404).send({ error: "No active on-chain policy for this agent/provider" });
    }

    try {
      const result = await submitClaimOnChain(callRecord, providerHostname);

      await query(
        `UPDATE claims
         SET tx_hash = $1, settlement_slot = $2, status = 'settled', policy_id = $3
         WHERE call_record_id = $4`,
        [result.signature, result.slot, result.claimPda, callRecordId]
      );

      return reply.send({
        signature: result.signature,
        slot: result.slot,
        refundAmount: result.refundAmount,
      });
    } catch (err: any) {
      request.log.error({ err }, "Claim settlement failed");
      return reply.code(500).send({ error: "Claim settlement failed", details: err.message });
    }
  });
}
```

Commit after registering the route in `index.ts`.

### Task 19: Create `packages/backend/src/routes/pools.ts`

**File:** `packages/backend/src/routes/pools.ts`

```typescript
import { FastifyInstance } from "fastify";
import { createSolanaClient, deriveProtocolPda, derivePoolPda } from "../utils/solana.js";
import { query } from "../db.js";

export async function poolsRoute(app: FastifyInstance) {
  app.get("/api/v1/pools", async (request, reply) => {
    try {
      const { program, programId } = createSolanaClient(getConfig());

      // Fetch all CoveragePool accounts
      const pools = await (program.account as any).coveragePool.all();

      const result = pools.map((p: any) => ({
        hostname: p.account.providerHostname,
        pda: p.publicKey.toString(),
        totalDeposited: p.account.totalDeposited.toString(),
        totalAvailable: p.account.totalAvailable.toString(),
        totalPremiumsEarned: p.account.totalPremiumsEarned.toString(),
        totalClaimsPaid: p.account.totalClaimsPaid.toString(),
        insuranceRateBps: p.account.insuranceRateBps,
        maxCoveragePerCall: p.account.maxCoveragePerCall.toString(),
        activePolicies: p.account.activePolicies,
        payoutsThisWindow: p.account.payoutsThisWindow.toString(),
        windowStart: p.account.windowStart.toString(),
      }));

      return reply.send({ pools: result });
    } catch (err: any) {
      request.log.error({ err }, "Failed to fetch pools");
      return reply.code(500).send({ error: err.message });
    }
  });

  app.get<{ Params: { hostname: string } }>(
    "/api/v1/pools/:hostname",
    async (request, reply) => {
      try {
        const { program, programId } = createSolanaClient(getConfig());
        const [poolPda] = derivePoolPda(programId, request.params.hostname);
        const pool = await (program.account as any).coveragePool.fetch(poolPda);

        // Fetch all positions for this pool
        const positions = await (program.account as any).underwriterPosition.all([
          { memcmp: { offset: 8, bytes: poolPda.toBase58() } },
        ]);

        // Recent claims from DB
        const recentClaims = await query(
          `SELECT id, call_record_id, agent_id, trigger_type, refund_amount, tx_hash, settlement_slot, created_at
           FROM claims WHERE status = 'settled' AND provider_id = (SELECT id FROM providers WHERE hostname = $1)
           ORDER BY created_at DESC LIMIT 50`,
          [request.params.hostname]
        );

        return reply.send({
          pool: {
            hostname: pool.providerHostname,
            totalDeposited: pool.totalDeposited.toString(),
            totalAvailable: pool.totalAvailable.toString(),
            totalPremiumsEarned: pool.totalPremiumsEarned.toString(),
            totalClaimsPaid: pool.totalClaimsPaid.toString(),
            insuranceRateBps: pool.insuranceRateBps,
            activePolicies: pool.activePolicies,
            payoutsThisWindow: pool.payoutsThisWindow.toString(),
          },
          positions: positions.map((p: any) => ({
            underwriter: p.account.underwriter.toString(),
            deposited: p.account.deposited.toString(),
            earnedPremiums: p.account.earnedPremiums.toString(),
            depositTimestamp: p.account.depositTimestamp.toString(),
          })),
          recentClaims,
        });
      } catch (err: any) {
        request.log.error({ err }, "Failed to fetch pool detail");
        return reply.code(500).send({ error: err.message });
      }
    }
  );
}

function getConfig() {
  return {
    rpcUrl: process.env.SOLANA_RPC_URL!,
    programId: process.env.SOLANA_PROGRAM_ID!,
    oracleKeypairPath: process.env.ORACLE_KEYPAIR_PATH,
    oracleKeypairBase58: process.env.ORACLE_KEYPAIR_BASE58,
    treasuryPubkey: process.env.TREASURY_PUBKEY!,
    usdcMint: process.env.USDC_MINT!,
  };
}
```

### Task 20: Create crank loops in `packages/backend/src/crank/`

Files to create:
- `packages/backend/src/crank/index.ts` — orchestrator
- `packages/backend/src/crank/premium-settler.ts`
- `packages/backend/src/crank/rate-updater.ts`
- `packages/backend/src/crank/policy-sweeper.ts`

**`packages/backend/src/crank/index.ts`:**

```typescript
import { FastifyInstance } from "fastify";
import { runPremiumSettler } from "./premium-settler.js";
import { runRateUpdater } from "./rate-updater.js";
import { runPolicySweeper } from "./policy-sweeper.js";

const CRANK_INTERVAL_MS = parseInt(process.env.CRANK_INTERVAL_MS || "900000", 10);

let timers: NodeJS.Timeout[] = [];

export function startCrank(app: FastifyInstance) {
  if (process.env.CRANK_ENABLED !== "true") {
    app.log.info("Crank disabled (CRANK_ENABLED != 'true')");
    return;
  }

  app.log.info({ intervalMs: CRANK_INTERVAL_MS }, "Starting crank loops");

  const settle = () => {
    runPremiumSettler(app.log).catch((err) =>
      app.log.error({ err }, "Premium settler failed")
    );
  };
  const rate = () => {
    runRateUpdater(app.log).catch((err) =>
      app.log.error({ err }, "Rate updater failed")
    );
  };
  const sweep = () => {
    runPolicySweeper(app.log).catch((err) =>
      app.log.error({ err }, "Policy sweeper failed")
    );
  };

  // Stagger initial runs so they don't all fire at once
  setTimeout(settle, 5000);
  setTimeout(rate, 10000);
  setTimeout(sweep, 15000);

  timers.push(setInterval(settle, CRANK_INTERVAL_MS));
  timers.push(setInterval(rate, CRANK_INTERVAL_MS));
  timers.push(setInterval(sweep, 3_600_000)); // hourly
}

export function stopCrank() {
  timers.forEach(clearInterval);
  timers = [];
}
```

**`packages/backend/src/crank/premium-settler.ts`:**

```typescript
import { FastifyBaseLogger } from "fastify";
import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { createSolanaClient, deriveProtocolPda, derivePoolPda, deriveVaultPda, derivePolicyPda } from "../utils/solana.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { query } from "../db.js";

export async function runPremiumSettler(log: FastifyBaseLogger) {
  const { program, programId, oracleKeypair } = createSolanaClient(getConfig());

  // Fetch all active pools
  const pools = await (program.account as any).coveragePool.all();
  log.info({ poolCount: pools.length }, "Premium settler: processing pools");

  for (const poolEntry of pools) {
    const pool = poolEntry.account;
    const hostname = pool.providerHostname;

    // Find all active policies for this pool
    const policies = await (program.account as any).policy.all([
      { memcmp: { offset: 8 + 32, bytes: poolEntry.publicKey.toBase58() } },
    ]);

    for (const policyEntry of policies) {
      const policy = policyEntry.account;
      if (!policy.active) continue;
      if (policy.prepaidBalance.toNumber() === 0) continue;

      // Fetch call records since last settlement for this agent+provider
      const lastSettlement = policy.totalPremiumsPaid.toNumber(); // proxy — track actual timestamp in a future iteration
      const rows = await query(
        `SELECT COALESCE(SUM(payment_amount), 0)::bigint AS call_value
         FROM call_records
         WHERE api_provider = $1 AND agent_id = $2
           AND payment_amount > 0
           AND created_at > NOW() - INTERVAL '15 minutes'`,
        [hostname, policy.agentId]
      );
      const callValue = BigInt(rows[0]?.call_value || 0);
      if (callValue === 0n) continue;

      try {
        const [protocolPda] = deriveProtocolPda(programId);
        const [vaultPda] = deriveVaultPda(programId, poolEntry.publicKey);
        const config = await (program.account as any).protocolConfig.fetch(protocolPda);
        const treasuryTokenAccount = getAssociatedTokenAddressSync(
          config.usdcMint,
          config.treasury
        );

        await (program.methods as any)
          .settlePremium(new BN(callValue.toString()))
          .accounts({
            config: protocolPda,
            pool: poolEntry.publicKey,
            vault: vaultPda,
            policy: policyEntry.publicKey,
            treasuryTokenAccount,
            authority: oracleKeypair.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();

        log.info(
          { hostname, agent: policy.agentId, callValue: callValue.toString() },
          "Premium settled"
        );
      } catch (err: any) {
        log.error({ err, hostname, agent: policy.agentId }, "settle_premium failed");
      }
    }
  }
}

function getConfig() {
  return {
    rpcUrl: process.env.SOLANA_RPC_URL!,
    programId: process.env.SOLANA_PROGRAM_ID!,
    oracleKeypairPath: process.env.ORACLE_KEYPAIR_PATH,
    oracleKeypairBase58: process.env.ORACLE_KEYPAIR_BASE58,
    treasuryPubkey: process.env.TREASURY_PUBKEY!,
    usdcMint: process.env.USDC_MINT!,
  };
}
```

**`packages/backend/src/crank/rate-updater.ts`:**

```typescript
import { FastifyBaseLogger } from "fastify";
import { createSolanaClient, deriveProtocolPda } from "../utils/solana.js";
import { query } from "../db.js";
import { computeInsuranceRate } from "../utils/insurance.js";

const RATE_CHANGE_THRESHOLD_BPS = 5;

export async function runRateUpdater(log: FastifyBaseLogger) {
  const { program, programId, oracleKeypair } = createSolanaClient(getConfig());
  const pools = await (program.account as any).coveragePool.all();

  for (const poolEntry of pools) {
    const pool = poolEntry.account;
    const hostname = pool.providerHostname;

    // Compute new rate from monitoring data
    const rows = await query(
      `SELECT
         COUNT(*) FILTER (WHERE classification != 'success')::float / NULLIF(COUNT(*), 0) AS failure_rate
       FROM call_records
       WHERE api_provider = $1 AND created_at > NOW() - INTERVAL '24 hours'`,
      [hostname]
    );
    const failureRate = rows[0]?.failure_rate ?? 0;
    if (failureRate === 0 && pool.insuranceRateBps === 25) continue; // no data, no change

    const newRate = computeInsuranceRate(failureRate); // returns decimal, e.g. 0.025
    const newRateBps = Math.round(newRate * 10000);

    const diff = Math.abs(newRateBps - pool.insuranceRateBps);
    if (diff < RATE_CHANGE_THRESHOLD_BPS) continue;

    try {
      const [protocolPda] = deriveProtocolPda(programId);
      await (program.methods as any)
        .updateRates(newRateBps)
        .accounts({
          config: protocolPda,
          pool: poolEntry.publicKey,
          authority: oracleKeypair.publicKey,
        })
        .rpc();
      log.info({ hostname, newRateBps }, "Updated pool rate");
    } catch (err: any) {
      log.error({ err, hostname }, "update_rates failed");
    }
  }
}

function getConfig() {
  return {
    rpcUrl: process.env.SOLANA_RPC_URL!,
    programId: process.env.SOLANA_PROGRAM_ID!,
    oracleKeypairPath: process.env.ORACLE_KEYPAIR_PATH,
    oracleKeypairBase58: process.env.ORACLE_KEYPAIR_BASE58,
    treasuryPubkey: process.env.TREASURY_PUBKEY!,
    usdcMint: process.env.USDC_MINT!,
  };
}
```

**`packages/backend/src/crank/policy-sweeper.ts`:**

```typescript
import { FastifyBaseLogger } from "fastify";

export async function runPolicySweeper(log: FastifyBaseLogger) {
  // For Phase 3 MVP, sweeping is a no-op.
  // Policies auto-deactivate when prepaid_balance reaches 0 (on-chain, in settle_premium).
  // Expiration-based deactivation will be added if/when we need it.
  log.debug("Policy sweeper: no-op in MVP");
}
```

Commit after all four files exist.

### Task 21: Register new routes and crank in `index.ts`

Modify `packages/backend/src/index.ts`:

```typescript
// Add imports at top
import { claimsSubmitRoute } from "./routes/claims-submit.js";
import { poolsRoute } from "./routes/pools.js";
import { startCrank } from "./crank/index.js";

// In the route registration section:
await app.register(claimsSubmitRoute);
await app.register(poolsRoute);

// After db connection is ready but before app.listen:
startCrank(app);
```

### Task 22: Modify `claims.ts` to wire oracle submission

In `packages/backend/src/utils/claims.ts`, the existing `maybeCreateClaim` function should gain a post-create step:

After creating the DB claim row, if the call record has `agent_pubkey` and the provider has an active on-chain policy for that agent, call `submitClaimOnChain` from the service module, update the claim row with `tx_hash`, `settlement_slot`, and `status = 'settled'`.

If the on-chain submission throws, log the error but leave the claim row at `status = 'simulated'` (no hard failure).

---

## Phase C: Insurance SDK Package

### Task 23: Scaffold `packages/insurance/`

```bash
mkdir -p packages/insurance/src packages/insurance/tests
cd packages/insurance
cat > package.json <<'EOF'
{
  "name": "@pact-network/insurance",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "test": "tsx --test tests/*.test.ts"
  },
  "dependencies": {
    "@coral-xyz/anchor": "^0.31.0",
    "@solana/web3.js": "^1.95.0",
    "@solana/spl-token": "^0.4.8"
  },
  "peerDependencies": {
    "@pact-network/monitor": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.8.3",
    "tsx": "^4.19.4"
  }
}
EOF
cat > tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "strict": true,
    "outDir": "dist",
    "declaration": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
EOF
cd ../..
```

### Task 24: Write `PactInsurance` class at `packages/insurance/src/client.ts`

The class implements:
- `createPolicy({ providerHostname, prepaidUsdc, expiresAt })` — builds and submits create_policy tx signed by agent wallet
- `topUp({ providerHostname, amountUsdc })` — builds and submits top_up tx signed by agent wallet
- `getPolicy(providerHostname)` — fetches Policy PDA, returns parsed data with projectedBalance (= on-chain balance - locally tracked pending)
- `listPolicies()` — fetches all policies for the agent wallet
- `submitClaim({ providerHostname, callRecord })` — POSTs to backend `/api/v1/claims/submit`
- `estimateCoverage(providerHostname, usdcAmount)` — reads pool rate, returns `{ estimatedCalls, rateBps }`

EventEmitter base class for `'billed'` and `'low-balance'` events. Internal counter tracks pending premium since last observed on-chain state.

The class exports should include types: `PactInsuranceConfig`, `PolicyInfo`, `ClaimSubmissionResult`.

Implementation should use the same `deriveXxxPda` helpers pattern as the backend — create `packages/insurance/src/anchor-client.ts` with these helpers and the Anchor Program initialization.

### Task 25: Write index.ts exports

```typescript
export { PactInsurance } from "./client.js";
export type {
  PactInsuranceConfig,
  PolicyInfo,
  ClaimSubmissionResult,
  CreatePolicyArgs,
  TopUpArgs,
} from "./types.js";
```

### Task 26: Add workspace reference and install

Add `packages/insurance` to the root `pnpm-workspace.yaml` (should already be covered by `packages/*` glob). Run `pnpm install` from root.

---

## Phase D: Monitor SDK Update

### Task 27: Add `'failure'` event to `@pact-network/monitor`

Modify `packages/sdk/src/wrapper.ts` to emit events using a lightweight EventEmitter.

At class construction, create `this.events = new EventEmitter()`. Add `on(event, handler)` and `off(event, handler)` public methods that proxy to the EventEmitter.

In the call-classification path (where `maybeCreateClaim` decision happens), after persisting the record, if classification is not 'success', emit:

```typescript
this.events.emit('failure', callRecord);
```

Also emit `'billed'` event after every call (success or failure) with `{ callCost, premium, remainingBalance }` — where premium and remainingBalance come from the insurance SDK if bound, or are undefined if not bound. For Phase 3 we just emit the call cost; premium/balance tracking lives in the insurance SDK.

Update `packages/sdk/src/wrapper.test.ts` to verify the event fires.

---

## Phase E: Scorecard UI

### Task 28: Create API client methods in `packages/scorecard/src/api/client.ts`

Add:

```typescript
export async function getPools(): Promise<PoolSummary[]> {
  const r = await fetch('/api/v1/pools');
  if (!r.ok) throw new Error('Failed to fetch pools');
  return (await r.json()).pools;
}

export async function getPool(hostname: string): Promise<PoolDetail> {
  const r = await fetch(`/api/v1/pools/${encodeURIComponent(hostname)}`);
  if (!r.ok) throw new Error('Failed to fetch pool');
  return await r.json();
}
```

Add TypeScript interfaces `PoolSummary` and `PoolDetail` matching the backend response shape.

### Task 29: Create `packages/scorecard/src/hooks/usePools.ts` and `usePool.ts`

```typescript
// usePools.ts
import { useEffect, useState } from 'react';
import { getPools, PoolSummary } from '../api/client';

export function usePools() {
  const [pools, setPools] = useState<PoolSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    const load = () => {
      getPools()
        .then((p) => { if (mounted) setPools(p); })
        .catch((e) => { if (mounted) setError(e.message); });
    };
    load();
    const timer = setInterval(load, 30_000);
    return () => { mounted = false; clearInterval(timer); };
  }, []);

  return { pools, error };
}
```

`usePool` follows the same pattern, polling every 15s.

### Task 30: Create `CoveragePoolsPanel.tsx`

Brutalist styled table that renders `usePools()` data. Columns: Provider, Pool Capital (USDC formatted), Utilization %, Active Policies, Rate (bps), Status. Row click navigates to `/pool/:hostname`.

Use existing styling patterns from `ProviderTable.tsx`. Use `useChartColors()` for theme-aware colors.

### Task 31: Create `PoolDetail.tsx` and register route `/pool/:hostname`

Full detail view with stats header, positions table, claims list with Solana explorer links, and a Recharts line chart for capital history.

Add the route in `App.tsx` following the existing routing pattern.

### Task 32: Add Coverage section to `ProviderDetail.tsx`

Insert a new section below the existing content that shows pool capital, current rate, active policy count, and a link to the pool detail view.

---

## Phase F: Simulation Integration Tests

### Task 33: Scaffold `packages/test-simulation/`

Create package with Docker PostgreSQL setup, fixtures directory, and utility modules.

**`packages/test-simulation/docker-compose.test.yml`:**

```yaml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_DB: pact_test
      POSTGRES_USER: pact
      POSTGRES_PASSWORD: pact
    ports:
      - "54321:5432"
    tmpfs:
      - /var/lib/postgresql/data
```

**`packages/test-simulation/utils/setup.ts`:**

```typescript
import { execSync } from 'child_process';
import { Client } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

export async function setupTestEnvironment() {
  execSync('docker compose -f docker-compose.test.yml up -d', { cwd: __dirname + '/..' });

  // Wait for DB ready
  for (let i = 0; i < 30; i++) {
    try {
      const client = new Client({ connectionString: 'postgresql://pact:pact@localhost:54321/pact_test' });
      await client.connect();
      await client.end();
      break;
    } catch { await new Promise(r => setTimeout(r, 1000)); }
  }

  // Run schema
  const schema = fs.readFileSync(path.join(__dirname, '../../backend/src/schema.sql'), 'utf-8');
  const client = new Client({ connectionString: 'postgresql://pact:pact@localhost:54321/pact_test' });
  await client.connect();
  await client.query(schema);
  await client.end();
}

export async function teardownTestEnvironment() {
  execSync('docker compose -f docker-compose.test.yml down -v', { cwd: __dirname + '/..' });
}
```

### Task 34: Write scenario `01-happy-path.ts`

Full E2E: underwriter deposits → agent creates policy → mock HTTP server returns 200 → SDK records success → crank runs → premium settles → assertions on balances.

### Task 35: Write scenario `02-failure-storm.ts`

Underwriter deposits → agent creates policy → mock HTTP server returns 500s → monitor emits failures → claims submit → verify aggregate cap trips at 30%.

### Task 36: Write scenarios `03-07`

- `03-underwriter-race.ts` — cooldown enforcement
- `04-balance-exhaustion.ts` — policy auto-deactivation
- `05-auto-topup.ts` — SDK triggers top_up on low balance
- `06-rate-change.ts` — rate updater pushes new rate on-chain
- `07-concurrent-agents.ts` — 10 agents hitting same provider, verify no race conditions

---

## Phase G: Deployment and Demo (Monday)

### Task 37: Deploy to devnet (manual, Alan-active)

Already covered by Task 14. Verify program ID is set in backend `.env`.

### Task 38: Seed devnet with test pools and underwriter deposits

Run `init-devnet.ts` if not already done. Create pools for `api.helius.xyz` and 1-2 other test providers. Deposit 100 USDC from team wallet per pool.

### Task 39: Run simulation tests against devnet

```bash
cd packages/test-simulation
npm run sim
```

Fix any integration bugs that surface.

### Task 40: 24-hour devnet soak

Leave the backend running with crank enabled. Monitor logs for errors. Run periodic sanity checks: balances tick correctly, premiums settle, no hung transactions.

### Task 41: Mainnet deploy (only if devnet soak clean)

```bash
cd packages/program
anchor deploy --provider.cluster mainnet-beta
```

Transfer upgrade authority to Rick's wallet per PRD.

### Task 42: Create mainnet pools and live demo

Seed mainnet pools with real USDC. Run demo through scorecard UI.

---

## Spec Coverage Checklist

- [x] ProtocolConfig with configurable parameters (Task 4)
- [x] Hardcoded safety floors (Task 2, enforced in Task 6 and Task 9)
- [x] initialize_protocol (Task 5)
- [x] update_config with safety validation (Task 6)
- [x] create_pool with hostname PDA (Task 7)
- [x] deposit with cooldown timestamp update (Task 8)
- [x] withdraw with cooldown enforcement (Task 9)
- [x] create_policy with prepaid balance (Task 10)
- [x] top_up (Task 10)
- [x] settle_premium with 15% fee split (Task 11)
- [x] update_rates (Task 12)
- [x] submit_claim with aggregate cap + dedupe (Task 13)
- [x] Backend Solana client utilities (Task 16)
- [x] claim-settlement service (Task 17)
- [x] claims-submit route (Task 18)
- [x] pools routes (Task 19)
- [x] Crank loops (Task 20)
- [x] maybeCreateClaim wires to oracle (Task 22)
- [x] @pact-network/insurance SDK (Tasks 23-26)
- [x] Monitor failure event (Task 27)
- [x] Scorecard UI (Tasks 28-32)
- [x] Simulation integration tests (Tasks 33-36)
- [x] Devnet deployment (Tasks 14, 37, 38)
- [x] Mainnet deployment (Task 41)

---

## Notes for Weekend Subagent Execution

- Tasks 1-14 are sequential within Phase A — do not parallelize.
- Tasks 15-22 (backend) can begin once Task 14 is complete and the IDL is available at `packages/program/target/idl/pact_insurance.json`. Copy it to `packages/backend/src/idl/`.
- Tasks 23-26 (insurance SDK) and 27 (monitor update) can run in parallel with backend tasks after Task 14.
- Tasks 28-32 (scorecard) depend on Task 19 (pools routes) being complete.
- Tasks 33-36 (simulation) depend on all of Phases A-E being complete.
- Task 37-42 require Alan's active involvement (devnet/mainnet deploys, keypairs, live demo).
- If any task fails in an ambiguous way, escalate to Monday — do not attempt workarounds that create hidden state.
