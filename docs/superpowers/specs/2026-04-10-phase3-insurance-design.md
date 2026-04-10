# Phase 3: On-Chain Parametric Insurance — Design Specification

**Status:** Final (pending Alan's review)
**Date:** 2026-04-10
**Author:** Alan (Engineering)
**Source of Truth:** Rick's PRD Phases 3 & 4 (2026-04-10, v1.0)
**Supersedes:** `2026-04-09-phase3-onchain-settlement-design.md`

## Goal

Build the Solana on-chain parametric insurance layer for Pact Network. A single Anchor program manages coverage pools, agent policies, and automatic claim settlement. The existing Fastify backend acts as a trusted oracle and runs crank loops for periodic premium settlement. A new `@pact-network/insurance` SDK provides agent-facing APIs with per-call UX on top of a batched settlement model. Deploy to devnet first; mainnet after 24 hours of clean devnet operation.

## Relationship to Rick's PRD

This spec follows Rick's PRD as the canonical source for architecture, account structures, and instruction set. Additions and deviations are explicitly flagged. Two safety features are added (withdrawal cooldown, aggregate payout cap) that do not appear in the PRD. All pricing, fee, timing, and safety parameters are configurable via a singleton `ProtocolConfig` account, with hardcoded absolute floors/ceilings in Rust code preventing dangerous misconfiguration.

## Non-Goals (Phase 3)

- Stripe MPP integration (Phase 4)
- Coverage tiers (single rate per pool)
- Split programs or CPI composability for external protocols
- Decentralized oracle / multi-party claim verification
- Governance token or DAO
- Provider self-service dashboard
- Mobile UI
- Data correctness disputes

---

## Architecture Overview

```
Agent (Node.js)
  │
  ├── @pact-network/monitor         (exists, Phase 1 — add 'failure' event)
  └── @pact-network/insurance       (NEW — PactInsurance class)
         │
         ▼
Pact Insurance Program (Anchor, single program)
  ├── ProtocolConfig PDA            (singleton, all configurable params)
  ├── CoveragePool PDAs             (one per provider hostname)
  ├── UnderwriterPosition PDAs
  ├── Policy PDAs                   (prepaid_balance + batched settlement)
  └── Claim PDAs                    (auto-approved, idempotent via call_id)
         │
         ▼
Pact Backend (existing Fastify + PostgreSQL)
  ├── Oracle signing                (existing role, new: signs submit_claim)
  ├── Crank loops (in-process)      (NEW — premium settler, rate updater, policy sweeper)
  ├── New routes                    (pools, policies, claims/submit)
  └── Existing routes               (unchanged)
         │
         ▼
Pact Scorecard (existing React + Vite)
  └── New views                     (CoveragePoolsPanel, PoolDetail)
```

### Trust Model

The backend holds the `config.authority` keypair and signs all privileged instructions (`update_config`, `create_pool`, `settle_premium`, `update_rates`, `submit_claim`, `toggle_pause`). Agents sign only instructions that move their own money (`create_policy`, `top_up`). Underwriters sign their own `deposit` and `withdraw`.

The backend authority is a single keypair for Phase 3, upgradeable to a multisig or governance PDA in Phase 4 without changing any instruction interfaces.

### Settlement Token

USDC on Solana. The `usdc_mint` field on `ProtocolConfig` allows swapping to a different SPL token via `update_config` without redeploying the program. Per-pool token support is a future extension (would require moving mint to `CoveragePool`).

---

## ProtocolConfig (Configurable Parameters)

Singleton PDA with `seeds = ["protocol"]`. All money, pricing, safety, and timing parameters live here and can be updated via `update_config`. Hardcoded constants in Rust code enforce absolute safety floors.

```rust
#[account]
pub struct ProtocolConfig {
    pub authority: Pubkey,
    pub treasury: Pubkey,
    pub usdc_mint: Pubkey,

    // Revenue split
    pub protocol_fee_bps: u16,              // default 1500 (15%)

    // Pool defaults (copied to CoveragePool on creation)
    pub min_pool_deposit: u64,              // default 100_000_000 (100 USDC)
    pub default_insurance_rate_bps: u16,    // default 25 (0.25%)
    pub default_max_coverage_per_call: u64, // default 1_000_000 (1 USDC)
    pub min_premium_bps: u16,               // default 5 (0.05%)

    // Safety: withdrawal cooldown
    pub withdrawal_cooldown_seconds: i64,   // default 604800 (7 days)

    // Safety: aggregate payout cap
    pub aggregate_cap_bps: u16,             // default 3000 (30%)
    pub aggregate_cap_window_seconds: i64,  // default 86400 (24h)

    // Claim validation
    pub claim_window_seconds: i64,          // default 3600 (1h staleness limit)
    pub max_claims_per_batch: u8,           // default 10

    // Circuit breaker
    pub paused: bool,                       // global emergency halt

    pub bump: u8,
}
```

### Hardcoded Safety Floors (constants.rs)

These are immutable without a program upgrade. `update_config` rejects any value that violates them.

```rust
pub const ABSOLUTE_MIN_WITHDRAWAL_COOLDOWN: i64 = 3600;     // 1 hour
pub const ABSOLUTE_MAX_AGGREGATE_CAP_BPS: u16 = 8000;       // 80%
pub const ABSOLUTE_MAX_PROTOCOL_FEE_BPS: u16 = 3000;        // 30%
pub const ABSOLUTE_MIN_CLAIM_WINDOW: i64 = 60;              // 1 minute
pub const ABSOLUTE_MIN_POOL_DEPOSIT: u64 = 1_000_000;       // 1 USDC
pub const MAX_HOSTNAME_LEN: usize = 128;
pub const MAX_AGENT_ID_LEN: usize = 64;
pub const MAX_CALL_ID_LEN: usize = 64;
```

**Rationale:** Configurable parameters let operators tune the system without redeployment. Hardcoded floors provide a last line of defense against compromised-authority scenarios — even if someone gains access to the authority keypair, they cannot set the cooldown to 0, disable the aggregate cap, or drain funds via a 100% protocol fee.

---

## Account Structures

### CoveragePool

One per provider hostname. `seeds = ["pool", hostname.as_bytes()]`.

```rust
#[account]
pub struct CoveragePool {
    pub authority: Pubkey,               // copied from ProtocolConfig at creation
    pub provider_hostname: String,       // max 128 chars
    pub usdc_mint: Pubkey,
    pub vault: Pubkey,                   // PDA token account

    // Capital
    pub total_deposited: u64,
    pub total_available: u64,            // deposited - obligations
    pub total_premiums_earned: u64,
    pub total_claims_paid: u64,

    // Pricing (per-pool, updateable via update_rates)
    pub insurance_rate_bps: u16,
    pub min_premium_bps: u16,
    pub max_coverage_per_call: u64,

    // Activity
    pub active_policies: u32,

    // Aggregate cap rolling window
    pub payouts_this_window: u64,
    pub window_start: i64,               // unix timestamp

    pub created_at: i64,
    pub updated_at: i64,
    pub bump: u8,
}
```

### UnderwriterPosition

Per-underwriter-per-pool. `seeds = ["position", pool.key(), underwriter.key()]`.

```rust
#[account]
pub struct UnderwriterPosition {
    pub pool: Pubkey,
    pub underwriter: Pubkey,
    pub deposited: u64,
    pub earned_premiums: u64,
    pub losses_absorbed: u64,
    pub deposit_timestamp: i64,          // used for withdrawal cooldown
    pub last_claim_timestamp: i64,
    pub bump: u8,
}
```

**Cooldown behavior:** Every `deposit` updates `deposit_timestamp = now`. Fresh capital restarts the cooldown window, preventing an underwriter from depositing-then-withdrawing to game the cooldown check on prior capital. This is conservative but safe.

### Policy

Per-agent-per-pool. `seeds = ["policy", pool.key(), agent.key()]`.

```rust
#[account]
pub struct Policy {
    pub agent: Pubkey,
    pub pool: Pubkey,
    pub agent_id: String,                // max 64 chars
    pub prepaid_balance: u64,            // agent's USDC, drained by crank
    pub total_premiums_paid: u64,
    pub total_claims_received: u64,
    pub calls_covered: u64,
    pub active: bool,
    pub created_at: i64,
    pub expires_at: i64,                 // 0 = never, otherwise unix ts
    pub bump: u8,
}
```

**Where is `prepaid_balance` physically held?** In the pool's vault token account, with `prepaid_balance` tracking the agent's claim on those funds. This avoids creating a separate token account per policy (rent cost + complexity). Settlement moves funds from "agent's claim" to "pool's claim" via internal accounting: the USDC stays in the vault, but `total_deposited`/`total_available` increase by the pool_premium portion and `prepaid_balance` decreases by the gross_premium. Protocol fees are transferred out to the treasury token account during settlement.

### Claim

Per call. `seeds = ["claim", policy.key(), call_id.as_bytes()]`.

```rust
#[account]
pub struct Claim {
    pub policy: Pubkey,
    pub pool: Pubkey,
    pub agent: Pubkey,
    pub call_id: String,                 // max 64 chars, dedupe key
    pub trigger_type: TriggerType,       // Timeout | Error | SchemaMismatch | LatencySla
    pub evidence_hash: [u8; 32],
    pub call_timestamp: i64,
    pub latency_ms: u32,
    pub status_code: u16,
    pub payment_amount: u64,
    pub refund_amount: u64,
    pub status: ClaimStatus,             // Approved in MVP (auto-settled)
    pub created_at: i64,
    pub resolved_at: i64,
    pub bump: u8,
}

pub enum TriggerType { Timeout, Error, SchemaMismatch, LatencySla }
pub enum ClaimStatus { Pending, Approved, Rejected }
```

---

## Program Instructions

### 1. `initialize_protocol`

**Signer:** deployer (becomes `authority` on creation).
**Creates:** `ProtocolConfig` PDA.
**Behavior:**
- Sets all default values from constants
- Sets `authority = ctx.accounts.deployer.key()`, `treasury` and `usdc_mint` from args
- Reverts if config already exists (idempotent safety)

### 2. `update_config`

**Signer:** `config.authority`.
**Args:** `UpdateConfigArgs` — all fields optional.
**Behavior:**
- For each provided field, validate against hardcoded floor/ceiling
- Rejects if: cooldown < `ABSOLUTE_MIN_WITHDRAWAL_COOLDOWN`, aggregate_cap > `ABSOLUTE_MAX_AGGREGATE_CAP_BPS`, protocol_fee > `ABSOLUTE_MAX_PROTOCOL_FEE_BPS`, claim_window < `ABSOLUTE_MIN_CLAIM_WINDOW`, min_pool_deposit < `ABSOLUTE_MIN_POOL_DEPOSIT`
- Writes updated fields to config

### 3. `create_pool`

**Signer:** `config.authority`.
**Args:** `provider_hostname: String`, optional overrides for rate/max_coverage.
**Behavior:**
- Rejects if pool for hostname already exists (PDA collision)
- Rejects if `config.paused`
- Creates `CoveragePool` PDA seeded by hostname
- Creates vault token account (ATA for pool PDA + `config.usdc_mint`)
- Copies rate/coverage defaults from config (or uses args if provided)
- Initializes `payouts_this_window = 0`, `window_start = now`

### 4. `deposit`

**Signer:** underwriter.
**Args:** `amount: u64`.
**Behavior:**
- Rejects if `amount < config.min_pool_deposit`
- Rejects if pool not active (`config.paused`)
- Transfers USDC from underwriter token account to vault
- Creates or updates `UnderwriterPosition`
- Sets `position.deposit_timestamp = now` (resets cooldown on every deposit)
- Updates `pool.total_deposited += amount`, `pool.total_available += amount`

### 5. `withdraw`

**Signer:** underwriter.
**Args:** `amount: u64`.
**Behavior:**
- **Cooldown check:** `now - position.deposit_timestamp >= max(ABSOLUTE_MIN_WITHDRAWAL_COOLDOWN, config.withdrawal_cooldown_seconds)`
- **Obligation check:** `pool.total_available - amount >= 0` (pool must retain enough to cover active obligations)
- Transfers USDC from vault to underwriter token account
- Updates `position.deposited`, `pool.total_deposited`, `pool.total_available`

### 6. `create_policy`

**Signer:** agent.
**Args:** `agent_id: String`, `prepaid_amount: u64`, `expires_at: i64`.
**Behavior:**
- Rejects if `config.paused`
- Rejects if policy already exists for this agent/pool pair (PDA collision)
- Transfers `prepaid_amount` USDC from agent to vault
- Creates `Policy` PDA with `prepaid_balance = prepaid_amount`, `active = true`

### 7. `top_up`

**Signer:** agent.
**Args:** `amount: u64`.
**Behavior:**
- Rejects if `config.paused`
- Rejects if `!policy.active`
- Transfers `amount` USDC from agent to vault
- `policy.prepaid_balance += amount`

### 8. `settle_premium`

**Signer:** `config.authority` (called by crank).
**Args:** `call_value: u64` (total x402 payment value since last settlement for this agent+pool).
**Behavior:**
- Rejects if `!policy.active`
- Compute `gross_premium = call_value * pool.insurance_rate_bps / 10000`
- If `gross_premium > policy.prepaid_balance`, cap to balance
- Compute `protocol_fee = gross_premium * config.protocol_fee_bps / 10000`
- Compute `pool_premium = gross_premium - protocol_fee`
- Transfer `protocol_fee` USDC from vault to treasury token account
- `policy.prepaid_balance -= gross_premium`
- `policy.total_premiums_paid += gross_premium`
- `pool.total_premiums_earned += pool_premium`
- `pool.total_available += pool_premium` (yield becomes underwriter capital)
- If `policy.prepaid_balance == 0`: mark `policy.active = false`

### 9. `update_rates`

**Signer:** `config.authority` (called by crank).
**Args:** `new_rate_bps: u16`.
**Behavior:**
- Updates `pool.insurance_rate_bps = new_rate_bps`
- Updates `pool.updated_at = now`

### 10. `submit_claim`

**Signer:** `config.authority` (backend oracle).
**Args:** `call_id: String`, `trigger_type: TriggerType`, `evidence_hash: [u8; 32]`, `call_timestamp: i64`, `latency_ms: u32`, `status_code: u16`, `payment_amount: u64`.
**Behavior:**
- Rejects if `config.paused`
- Rejects if `!policy.active`
- **Claim age check:** `now - call_timestamp <= config.claim_window_seconds`
- **PDA collision = dedupe:** Claim PDA creation fails if already exists
- **Window rollover:** if `now - pool.window_start > config.aggregate_cap_window_seconds`, reset `payouts_this_window = 0` and `window_start = now`
- **Aggregate cap check:** reject if `payouts_this_window + refund > pool.total_deposited * min(config.aggregate_cap_bps, ABSOLUTE_MAX_AGGREGATE_CAP_BPS) / 10000`
- **Refund math:** `refund = min(payment_amount, pool.max_coverage_per_call); refund = min(refund, pool.total_available)`
- Transfer `refund` USDC from vault to agent token account
- Create `Claim` PDA with `status = Approved`, `refund_amount = refund`, `resolved_at = now`
- Update `pool.total_claims_paid += refund`, `pool.total_available -= refund`, `pool.payouts_this_window += refund`
- Update `policy.total_claims_received += refund`, `policy.calls_covered += 1`

### Error Codes

```rust
#[error_code]
pub enum PactError {
    ProtocolPaused,
    PoolAlreadyExists,
    PolicyAlreadyExists,
    PolicyInactive,
    InsufficientPoolBalance,
    InsufficientPrepaidBalance,
    WithdrawalUnderCooldown,
    WithdrawalWouldUnderfund,
    AggregateCapExceeded,
    ClaimWindowExpired,
    DuplicateClaim,
    InvalidRate,
    HostnameTooLong,
    AgentIdTooLong,
    CallIdTooLong,
    Unauthorized,
    InvalidTriggerType,
    ZeroAmount,
    BelowMinimumDeposit,
    ConfigSafetyFloorViolation,
}
```

---

## Backend Integration

The existing Fastify backend gains three concerns:
1. Acting as the Solana oracle (signing privileged instructions)
2. Running crank loops (premium settlement, rate updates, policy sweep)
3. New API endpoints for scorecard and SDK consumption

No framework changes (Fastify, not NestJS — migration is a separate Phase 4 initiative if desired).

### New Files

**`packages/backend/src/utils/solana.ts`**
- Anchor `Program` client initialized at boot
- Oracle keypair loaded from env (`ORACLE_KEYPAIR_PATH` → JSON file path, or `ORACLE_KEYPAIR_BASE58` for inline)
- Helper functions: `buildSubmitClaimTx`, `buildSettlePremiumTx`, `buildUpdateRatesTx`, `signAndSend(tx)`, `confirmTransaction(sig)`
- Handles RPC retries with exponential backoff (max 5 attempts)

**`packages/backend/src/routes/pools.ts`**
- `GET /api/v1/pools` — list all pools with summary fields
- `GET /api/v1/pools/:hostname` — detail including positions and recent claims
- Data: reads on-chain state via Anchor `fetch`, joins with DB claims table for historical data

**`packages/backend/src/routes/policies.ts`**
- `GET /api/v1/policies/:agentId` — policy details for an agent across all pools

**`packages/backend/src/routes/claims-submit.ts`**
- `POST /api/v1/claims/submit` — accepts `{ providerHostname, callRecord }`
- Validates: call record exists, agent has active policy for this pool, call is within `claim_window_seconds`
- Builds and signs `submit_claim` tx with oracle keypair
- Awaits confirmation
- Updates DB `claims` row with `tx_hash`, `settlement_slot`, `status = 'settled'`
- Returns signature

**`packages/backend/src/crank/index.ts`** and loop files
- `premium-settler.ts` — every 15 minutes, reads call records since last settlement per pool per agent, builds `settle_premium` txs
- `rate-updater.ts` — every 15 minutes (after settlement), checks if pool rate diff > 5 bps, calls `update_rates`
- `policy-sweeper.ts` — hourly, deactivates expired policies via DB flag (no on-chain call; on-chain inactivation happens naturally when `prepaid_balance` hits 0)
- `index.ts` — starts all loops on backend boot using `setInterval`, each loop wrapped in `try/catch` so failures in one don't crash others

### Modified Files

**`packages/backend/src/claims.ts`**
- Extract claim-submission logic into a service function `submitClaimOnChain(callRecord, providerHostname)` in `packages/backend/src/services/claim-settlement.ts`. This function is callable both from the new `POST /api/v1/claims/submit` route handler AND from `maybeCreateClaim()` internally — no HTTP roundtrip, no route-handler reentry.
- `maybeCreateClaim()` gains a post-step: after creating the DB claim row, check if the agent has an active on-chain policy for this provider. If yes, call `submitClaimOnChain()`. If it returns a signature, update the claim row with `tx_hash`, `settlement_slot`, `status = 'settled'`. If it throws, leave the claim row at `status = 'simulated'` and log the error.
- Existing simulated claims behavior is untouched for agents without on-chain policies.

**`packages/backend/src/schema.sql`**
- No changes — SC-ready fields (`policy_id`, `tx_hash`, `settlement_slot`) already exist from PR #3

**`packages/backend/src/index.ts`**
- Register new routes (`pools`, `policies`, `claims-submit`)
- Start crank loops after DB connection is ready
- Load oracle keypair on boot; log warning (not fatal) if missing (dev mode without Solana)

### Environment Variables

```
SOLANA_RPC_URL                 # Helius or public RPC
SOLANA_PROGRAM_ID              # Deployed pact-insurance program ID
ORACLE_KEYPAIR_PATH            # Path to oracle keypair JSON (recommended)
ORACLE_KEYPAIR_BASE58          # Alternative: base58-encoded secret
TREASURY_PUBKEY                # Protocol treasury wallet
USDC_MINT                      # devnet test mint or mainnet mint
CRANK_INTERVAL_MS=900000       # 15 minutes
CRANK_ENABLED=true             # feature flag
```

---

## `@pact-network/insurance` SDK (New Package)

Location: `packages/insurance/`
Package name: `@pact-network/insurance`
Peer dependency: `@pact-network/monitor` (exists)

### Public API

```typescript
import { Connection, Keypair } from '@solana/web3.js';
import { PactInsurance } from '@pact-network/insurance';

const insurance = new PactInsurance({
  connection: new Connection(RPC_URL),
  wallet: agentKeypair,
  programId: PACT_PROGRAM_ID,
  backendUrl: 'https://pactnetwork.io',
  lowBalanceThreshold: 1_000_000,  // 1 USDC, triggers 'low-balance' event
});

// One-time policy creation (agent signs on-chain)
await insurance.createPolicy({
  providerHostname: 'api.helius.xyz',
  prepaidUsdc: 10,  // in whole USDC, SDK converts to lamports
  expiresAt: 0,     // 0 = never
});

// Top up existing policy (agent signs on-chain)
await insurance.topUp({ providerHostname: 'api.helius.xyz', amountUsdc: 5 });

// Get policy state (read-only)
const policy = await insurance.getPolicy('api.helius.xyz');
// {
//   active: true,
//   prepaidBalance: 9.98,
//   projectedBalance: 9.95,   // includes pending local settlements
//   callsCovered: 342,
//   totalPremiumsPaid: 0.02,
//   totalClaimsReceived: 0.005,
// }

// List all policies for this wallet
const policies = await insurance.listPolicies();

// Submit claim (usually called automatically via monitor event)
// This POSTs to backend, which signs and submits on-chain
await insurance.submitClaim({
  providerHostname: 'api.helius.xyz',
  callRecord: failedRecord,
});
```

### Auto-Claim Wiring

```typescript
monitor.on('failure', async (record) => {
  const policy = await insurance.getPolicy(record.apiProvider);
  if (policy?.active) {
    await insurance.submitClaim({
      providerHostname: record.apiProvider,
      callRecord: record,
    });
  }
});
```

### Per-Call UX Requirements

The SDK presents a per-call experience even though settlement is batched:

1. **`'billed'` event** — fires on every `monitor.fetch()` completion with `{ callCost, premium, remainingBalance }`. Apps can display per-call info in real time.
2. **Local balance projection** — SDK tracks pending (not yet settled on-chain) premiums locally. `getPolicy().projectedBalance` returns `on_chain_balance - pending_local_premiums`.
3. **`'low-balance'` event** — fires when `projectedBalance < lowBalanceThreshold`. Apps can trigger `topUp()` in response, or the SDK can auto-invoke it if `autoTopup: true` is set.
4. **First-use helper** — `PactInsurance.estimateCoverage(providerHostname, usdcAmount)` returns `{ estimatedCalls, rateBps }` for onboarding UX.
5. **User-facing strings** — logs, errors, and docs refer to "coverage wallet" rather than "prepaid balance" (product team framing).

### Signing Split (Summary)

| Operation | Who Signs | How |
|---|---|---|
| `create_policy` | Agent | SDK builds tx, wallet signs, SDK submits directly to RPC |
| `top_up` | Agent | Same as above |
| `submit_claim` | Oracle | SDK POSTs to backend, backend signs and submits |
| `settle_premium` | Oracle (crank) | Agent not involved |
| `update_rates` | Oracle (crank) | Agent not involved |

### Monitor SDK Change (Backward Compatible)

`@pact-network/monitor` adds an `EventEmitter` base (or `mitt` for lightweight alternative). `wrapper.ts` emits a `'failure'` event whenever the classifier marks a call as failed. Emits after the call record has been stored, so listeners see a complete record. Existing consumers that don't listen to events are unaffected.

---

## Scorecard UI Additions

### New Components

**`CoveragePoolsPanel.tsx`** — table on main page below NetworkActivity
- Columns: Provider hostname, Pool capital (USDC), Utilization %, Active policies, Rate (bps), Status
- Brutalist styling, copper for financial values, JetBrains Mono for data
- Click row → navigate to pool detail route

**`PoolDetail.tsx`** — new route `/pool/:hostname`
- Pool stats header: total deposited, available, premiums earned, claims paid, aggregate cap status
- Underwriter positions table: address (truncated), deposited, earned, share %, deposit date
- Settled claims list: agent (truncated), trigger type, refund amount, tx_hash (Solana explorer link), slot
- Capital history line chart (Recharts): deposits / premiums / payouts over time

**`ProviderDetail.tsx` enhancement** (existing file)
- New "Coverage" section: pool capital, current rate, active policy count
- Link to the corresponding pool detail view

### New Hooks + API Client

- `usePools()` — fetches all pools, auto-refreshes every 30s
- `usePool(hostname)` — fetches single pool detail, auto-refreshes every 15s
- `getPool(hostname)`, `getPools()` in `src/api/client.ts`
- Follows existing `useProviders` / `useAnalytics` patterns

### Not Changing

- ProviderTable, NetworkActivity, FailureTimeline, FailureBreakdown
- Theme system, `useChartColors()` hook
- Existing routes

### Not in Phase 3

- Agent-facing policy management UI (agents use SDK programmatically)
- Underwriter onboarding flow
- Provider self-registration

---

## Testing Strategy

### Tier 1: Anchor Unit Tests (localnet)

Per-instruction coverage in `packages/program/tests/`:

- **`protocol.ts`** — `initialize_protocol` idempotency, `update_config` authority check, every safety floor enforced (cooldown, aggregate_cap, protocol_fee, claim_window, min_pool_deposit)
- **`pool.ts`** — `create_pool` hostname uniqueness, vault creation, default copying
- **`underwriter.ts`** — `deposit` min enforcement, position creation, timestamp set; `withdraw` cooldown enforcement including ABSOLUTE_MIN floor, obligation check, partial withdrawal
- **`policy.ts`** — `create_policy` paused rejection, PDA collision, USDC transfer; `top_up` balance increase
- **`settlement.ts`** — `settle_premium` math (15% fee split), balance deduction, inactivation on exhaustion, authority-only; `update_rates` authority check
- **`claims.ts`** — `submit_claim` aggregate cap across multiple claims in one window, window rollover, dedupe via PDA collision, claim age window, refund math (min of 3 values), authority-only

### Tier 2: Backend Unit Tests

Existing Vitest pattern extended:

- Oracle keypair loading from env
- `buildSubmitClaimTx` / `buildSettlePremiumTx` produce correct instructions
- `POST /api/v1/claims/submit` — happy path, policy-not-found, signing failure, confirmation failure
- `GET /api/v1/pools` — reads from chain, returns expected shape
- Crank loops: mocked Anchor client, verify correct instructions built for different scenarios (no active policy, prepaid exhausted, rate unchanged, rate changed)

### Tier 3: SDK Unit Tests

In `packages/insurance/tests/`:

- `createPolicy` builds correct tx, signs, submits
- `submitClaim` posts to backend with correct payload
- `'billed'` event fires on monitor success with correct values
- `'low-balance'` event fires at threshold
- Local balance projection stays consistent with on-chain state

### Tier 4: Simulation Integration Tests (NEW, Alan's preferred tier)

Located in `packages/test-simulation/`. Real infrastructure, scripted scenarios.

**Infrastructure:**
- Docker PostgreSQL per run (clean state)
- Shared devnet program ID with unique-PDA isolation (each scenario uses a fresh `test-${timestamp}.example.com` hostname)
- Mock HTTP server under our control for deterministic failure injection
- Real backend running locally
- Real SDK hitting real devnet

**Scenarios:**
1. **`01-happy-path.ts`** — underwriter deposits 100 USDC, agent creates policy with 1 USDC prepaid, makes 10 successful calls, crank settles premiums, verify balances
2. **`02-failure-storm.ts`** — 100 API failures in a row, verify aggregate cap trips at 30% of pool, remaining claims rejected
3. **`03-underwriter-race.ts`** — underwriter deposits, tries to withdraw immediately (rejected by cooldown), waits simulated 7 days, withdraws successfully
4. **`04-balance-exhaustion.ts`** — agent balance drains to 0 over many calls, policy auto-deactivates, no more premium charges
5. **`05-auto-topup.ts`** — balance hits low threshold, SDK fires event, auto-topup executes, flow continues uninterrupted
6. **`06-rate-change.ts`** — push 100 failing calls to a provider, crank runs `update_rates`, verify new rate reflected in next premium settlement
7. **`07-concurrent-agents.ts`** — 10 agents hitting same provider simultaneously, verify no race conditions in premium accounting

**Running modes:**
- `npm run sim` — all scenarios sequentially
- `npm run sim -- --scenario happy-path` — single scenario
- CI integration: dedicated test devnet program ID, secrets injected from vault

### Tier 5: Manual Devnet Verification

Before mainnet:
1. Deploy program to devnet
2. Run `initialize_protocol`
3. Create pool for real provider (`api.helius.xyz`)
4. Seed 100 USDC test underwriter deposit
5. Create policy with 1 USDC prepaid balance
6. Run real SDK against devnet RPC, make ~10 calls to a test endpoint
7. Force a failure, verify auto-claim fires, refund lands in agent wallet, claim visible on explorer
8. Run crank for 24 continuous hours, verify all loops execute without errors, no drift in balances

Only after this completes cleanly do we deploy to mainnet.

---

## File Structure

```
packages/
  program/                                # NEW — Anchor program
    Anchor.toml
    Cargo.toml
    programs/
      pact-insurance/
        Cargo.toml
        src/
          lib.rs
          state.rs
          constants.rs
          error.rs
          utils.rs
          instructions/
            initialize_protocol.rs
            update_config.rs
            create_pool.rs
            deposit.rs
            withdraw.rs
            create_policy.rs
            top_up.rs
            settle_premium.rs
            update_rates.rs
            submit_claim.rs
    tests/
      protocol.ts
      pool.ts
      underwriter.ts
      policy.ts
      settlement.ts
      claims.ts
    migrations/deploy.ts

  insurance/                              # NEW — @pact-network/insurance
    src/
      index.ts
      client.ts
      anchor-client.ts
      types.ts
      errors.ts
      events.ts
    tests/
    package.json

  sdk/                                    # EXISTING — @pact-network/monitor
    src/
      wrapper.ts                          # MODIFY — emit 'failure' event
      events.ts                           # NEW — EventEmitter base
    (other files unchanged)

  backend/                                # EXISTING
    src/
      utils/solana.ts                     # NEW
      services/
        claim-settlement.ts               # NEW — submitClaimOnChain()
      routes/
        pools.ts                          # NEW
        policies.ts                       # NEW
        claims-submit.ts                  # NEW
      crank/                              # NEW
        index.ts
        premium-settler.ts
        rate-updater.ts
        policy-sweeper.ts
      claims.ts                           # MODIFY — wire oracle submit
      index.ts                            # MODIFY — start crank, register routes

  scorecard/                              # EXISTING
    src/
      api/client.ts                       # MODIFY
      hooks/
        usePool.ts                        # NEW
        usePools.ts                       # NEW
      components/
        CoveragePoolsPanel.tsx            # NEW
        PoolDetail.tsx                    # NEW
        ProviderDetail.tsx                # MODIFY — add Coverage section

  test-simulation/                        # NEW — simulation integration tests
    scenarios/
      01-happy-path.ts
      02-failure-storm.ts
      03-underwriter-race.ts
      04-balance-exhaustion.ts
      05-auto-topup.ts
      06-rate-change.ts
      07-concurrent-agents.ts
    fixtures/
    utils/
      setup.ts
      teardown.ts
      assertions.ts
    docker-compose.test.yml
    package.json
```

---

## Build Order (Friday → Monday)

Alan works actively on Friday evening and Monday. Saturday and Sunday are delegated to subagents running from the implementation plan. The implementation plan (next step after this spec) must be extra-detailed so subagents can execute without needing clarification.

### Friday Evening (Active — Alan + Claude)

1. Scaffold `packages/program/` with Anchor init
2. Write `state.rs` (all account structures), `constants.rs` (safety floors), `error.rs`
3. Implement and test `initialize_protocol` + `update_config` instructions
4. Verify scaffold builds and basic instructions work on localnet
5. Finalize implementation plan document for weekend subagent dispatch

### Saturday (Subagent-Delegated)

6. Implement `create_pool`, `deposit`, `withdraw` instructions + tests
7. Implement `create_policy`, `top_up` instructions + tests
8. Implement `settle_premium`, `update_rates` instructions + tests
9. Implement `submit_claim` instruction + tests (including aggregate cap window logic)

### Sunday (Subagent-Delegated)

10. Backend: `utils/solana.ts`, new routes (`pools.ts`, `policies.ts`, `claims-submit.ts`)
11. Backend: crank loops (`premium-settler.ts`, `rate-updater.ts`, `policy-sweeper.ts`)
12. Backend: wire `claims.ts` oracle submit path
13. `packages/insurance/` — `PactInsurance` class, anchor client, event emitters
14. `@pact-network/monitor` modification — add `'failure'` event
15. Scorecard: `CoveragePoolsPanel`, `PoolDetail`, hooks, `ProviderDetail` enhancement
16. `packages/test-simulation/` — scenarios 1-4 (core happy path and key safety features)

### Monday (Active — Alan + Claude)

17. Review all subagent output; fix integration issues
18. Deploy program to devnet, run `initialize_protocol` and seed a test pool
19. Run simulation scenarios 1-4 against real devnet + real backend, fix any integration bugs
20. Write and run scenarios 5-7
21. Monitor devnet for 24-hour stability check
22. Demo readiness check

### Post-Monday (Before Mainnet)

23. 24-hour continuous devnet run with crank active, verify no drift or errors
24. Mainnet deploy (`anchor deploy` with upgrade authority set to Rick's wallet per PRD)
25. Create mainnet pools for real providers
26. Seed real underwriter deposits (team USDC per PRD risk mitigation)
27. Live demo via scorecard

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Anchor program has critical bugs under real load | Medium | High | 24-hour devnet soak before mainnet. Simulation test scenarios cover edge cases. |
| Crank loop fails silently and premiums stop settling | Medium | Medium | Logs to stdout (Docker captures). Health endpoint. Claims still settle even if crank is down. Manual catch-up on next crank start. |
| Oracle keypair compromise | Low | Critical | Hardcoded safety floors prevent worst-case drain via config. Cooldown prevents instant underwriter rug. Aggregate cap caps single-window damage at 80% even if authority is fully hostile. Upgrade path to multisig in Phase 4. |
| Underwriter abandons pool during claim storm | Low | High | 7-day default cooldown (1-hour floor) means capital cannot flee instantly. Rate updater increases premiums as losses mount, rebalancing pool economics. |
| Insufficient underwriter capital at launch | High | High | Seed with team USDC per PRD. Recruit from Colosseum community. Start with low pool caps. |
| Solana fee spike erodes crank economics | Low | Medium | Crank txns are infrequent (15 min interval, one per active pool). Worst case: increase `CRANK_INTERVAL_MS` to reduce frequency. |
| Weekend subagent work produces bugs Alan finds Monday | High | Medium | Extra-detailed implementation plan with no ambiguity. Tasks designed to be independent so one bug doesn't block others. Simulation tests catch integration issues before demo. |
| Mainnet deploy issues (rent, program size) | Low | Medium | Test all deploy steps on devnet first. Budget SOL for rent. Keep program under 10KB code size. |

---

## Key Parameters Summary

| Parameter | Default | Hardcoded Floor/Ceiling | Configurable |
|---|---|---|---|
| `protocol_fee_bps` | 1500 (15%) | Ceiling: 3000 (30%) | Yes |
| `min_pool_deposit` | 100 USDC | Floor: 1 USDC | Yes |
| `default_insurance_rate_bps` | 25 (0.25%) | — | Yes |
| `default_max_coverage_per_call` | 1 USDC | — | Yes |
| `min_premium_bps` | 5 (0.05%) | — | Yes |
| `withdrawal_cooldown_seconds` | 604800 (7 days) | Floor: 3600 (1 hour) | Yes |
| `aggregate_cap_bps` | 3000 (30%) | Ceiling: 8000 (80%) | Yes |
| `aggregate_cap_window_seconds` | 86400 (24h) | — | Yes |
| `claim_window_seconds` | 3600 (1h) | Floor: 60 (1 min) | Yes |
| `max_claims_per_batch` | 10 | — | Yes |
| `paused` | false | — | Yes |
| `crank_interval_ms` | 900000 (15 min) | — | Env var |
| `low_balance_threshold` (SDK) | 1 USDC | — | SDK arg |

---

## Appendix: Premium Math Examples (from PRD)

All amounts in USDC (6 decimal places internally).

**Example 1: Normal operation**
Agent calls api.helius.xyz 1,000 times at 0.001 USDC/call. Total value: 1.0 USDC. Rate: 25 bps. Gross premium: 0.0025 USDC. Protocol fee (15%): 0.000375. Pool premium (85%): 0.002125.

**Example 2: Claim payout**
Agent pays 0.001 USDC via x402. API returns 500. Refund: `min(0.001, max_coverage_per_call) = 0.001 USDC` from pool vault to agent wallet.

**Example 3: Underwriter return**
Pool: 1,000 USDC. 30 days: 50,000 calls, 50 USDC total call value. Premium: 0.125 USDC (rate 25 bps). Protocol fee: 0.01875. Pool premium: 0.10625. Claims paid over month: 0.003 USDC. Net pool yield: 0.10325 USDC (~1.26% APR).

**Example 4: High-risk API**
Rate: 800 bps (8%). Agent pays 0.01 USDC/call. Premium: 0.0008 USDC/call. Higher rate reflects higher observed failure risk. Market prices quality.

---

Phase 1-2: Data. Phase 3: Protection. Phase 4: Ecosystem.
