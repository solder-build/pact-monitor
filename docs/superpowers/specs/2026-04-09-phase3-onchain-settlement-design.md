# Phase 3: On-Chain Settlement Design

## Goal

Build the Solana on-chain insurance settlement layer for Pact Network. Two Anchor programs — Pool Program and Settlement Program — that enable underwriters to fund coverage pools, agents to buy policies, and the backend oracle to submit claims that settle refunds automatically on-chain. Deployed to devnet.

## Architecture

Two Anchor programs in `packages/program/`, connected via CPI. The existing Fastify backend acts as a trusted oracle, signing claim submission transactions. The SDK hot path is unchanged — all settlement happens backend-to-chain. The scorecard gains coverage pool visibility.

```
Agent SDK ──► Fastify Backend ──► Solana (Pool + Settlement Programs)
  (monitor)     (oracle)            (deposit, policy, claim, payout)
                   │
                   ▼
              PostgreSQL
           (existing claims table
            gains tx_hash, slot)
```

## Settlement Token

USDC as the default settlement token. The `mint` field on CoveragePool allows creating pools with any SPL token in the future without program changes.

## Pool Structure

Per-API provider. Each provider gets its own CoveragePool PDA with isolated capital. Underwriters choose which providers to back. Pool capital is capped at 20x monthly premium volume per the whitepaper.

## Coverage Tiers

All three tiers implemented from day one:

| Tier | Multiplier | Covers |
|------|-----------|--------|
| Basic | 1.0x (100 bps) | timeout, error |
| Standard | 1.3x (130 bps) | timeout, error, latency_sla |
| Premium | 1.6x (160 bps) | timeout, error, latency_sla, schema_mismatch |

Tier multiplier affects premium pricing: `premium = call_budget * base_rate * tier_multiplier`. Tier also determines which trigger types qualify for refund on a given policy.

## Oracle Mechanism

Trusted backend oracle for this phase. The backend's Solana keypair is set as `authority` on each CoveragePool. Only the authority can submit claims via the Settlement Program.

Upgrade path: replace the single keypair with a multisig of verifier nodes or a threshold signature scheme. The `authority` field on CoveragePool and the `submit_claim` instruction interface remain unchanged.

---

## On-Chain Account Structure

### Pool Program Accounts

**CoveragePool** — one per API provider
```
Seeds: ["pool", provider_pubkey]
Fields:
  authority: Pubkey          // backend oracle keypair (upgradeable to multisig)
  provider: Pubkey           // provider's wallet address
  mint: Pubkey               // USDC mint (extensible to other tokens)
  vault: Pubkey              // associated token account holding pool capital
  total_deposited: u64       // total underwriter capital
  total_premiums: u64        // lifetime premium revenue
  total_payouts: u64         // lifetime claim payouts
  reserve_balance: u64       // 2% reserve fund
  protocol_fees: u64         // 10% protocol fee accumulated
  pool_cap: u64              // 20x monthly premium volume
  is_active: bool            // circuit breaker flag
  payouts_this_window: u64   // rolling window payout tracker (aggregate cap)
  window_start: i64          // start of current aggregate cap window
  bump: u8
```

**UnderwriterPosition** — one per underwriter per pool
```
Seeds: ["position", pool_pubkey, underwriter_pubkey]
Fields:
  pool: Pubkey
  underwriter: Pubkey
  deposited: u64
  share_bps: u16             // basis points of pool ownership
  deposited_at: i64          // timestamp, for 7-day withdrawal cooldown
  bump: u8
```

**Policy** — one per agent per pool
```
Seeds: ["policy", pool_pubkey, agent_pubkey]
Fields:
  pool: Pubkey
  agent: Pubkey
  coverage_tier: u8          // 0=Basic, 1=Standard, 2=Premium
  tier_multiplier: u16       // 100, 130, 160 (basis points)
  premium_paid: u64          // total premium deposited
  coverage_remaining: u64    // remaining coverage balance
  max_coverage: u64          // original coverage limit
  is_active: bool
  claims_this_hour: u16      // anti-abuse counter
  claims_today: u16          // anti-abuse counter
  last_hour_reset: i64       // clock timestamp
  last_day_reset: i64        // clock timestamp
  created_at: i64
  bump: u8
```

### Settlement Program Accounts

**Claim** — one per claim event
```
Seeds: ["claim", pool_pubkey, call_record_id_bytes]
Fields:
  pool: Pubkey
  policy: Pubkey
  agent: Pubkey
  trigger_type: u8           // 0=timeout, 1=error, 2=schema_mismatch, 3=latency_sla
  refund_pct: u8             // 100, 100, 75, 50
  call_cost: u64
  refund_amount: u64
  status: u8                 // 0=submitted, 1=settled, 2=rejected
  call_record_id: [u8; 16]  // UUID bytes from backend
  settled_at: i64            // 0 until settled
  bump: u8
```

### PDA Design Notes

- `call_record_id` as PDA seed ensures one claim per call record (idempotent — resubmitting the same claim is a no-op)
- `mint` on CoveragePool means supporting a new token is just creating a new pool with a different mint address
- Pool `authority` is the single upgrade point for decentralization

---

## Program Instructions

### Pool Program (7 instructions)

**`initialize_pool`** — creates a CoveragePool for a provider
- Signer: protocol authority (deploy keypair)
- Creates pool PDA, vault token account (ATA for pool PDA + mint)
- Sets authority (backend oracle), mint, provider, pool_cap
- Initializes aggregate cap window

**`deposit`** — underwriter adds USDC to a pool
- Signer: underwriter
- Transfers USDC from underwriter token account to pool vault
- Creates or updates UnderwriterPosition PDA
- Recalculates `share_bps` for all positions in that pool
- Updates `total_deposited`

**`withdraw`** — underwriter removes USDC from a pool
- Signer: underwriter
- Enforces 7-day cooldown: `Clock::get().unix_timestamp - deposited_at >= 604800`
- Cannot withdraw below pool's outstanding coverage obligations (sum of active policies' `coverage_remaining`)
- Transfers USDC from pool vault to underwriter
- Updates UnderwriterPosition, recalculates shares

**`create_policy`** — agent buys insurance coverage
- Signer: agent
- Transfers premium USDC from agent token account to pool vault
- Revenue split applied on deposit:
  - 45-55% reserved for claims (stays in vault)
  - 10% to `protocol_fees`
  - 2% to `reserve_balance`
  - Remainder adds to underwriter yield (stays in vault, tracked via share accounting)
- Creates Policy PDA with chosen coverage tier (0, 1, or 2)
- `max_coverage` = premium * 10 (fixed 10x leverage for initial launch; can be made dynamic based on pool loss ratio later)
- Initializes anti-abuse counters to 0

**`deactivate_policy`** — agent or authority closes a policy
- Signer: agent or pool authority
- Marks policy `is_active = false`
- If agent-initiated: refunds unused `coverage_remaining` pro-rata to agent
- If authority-initiated (e.g., anti-abuse): no refund

**`toggle_circuit_breaker`** — emergency halt/resume
- Signer: pool authority only
- Toggles `is_active` on pool
- When inactive: `create_policy` and `payout` instructions reject

**`payout`** — CPI-only, transfers USDC from vault to agent
- Caller validation: must be invoked via CPI from Settlement Program (Pool Program stores Settlement Program's program ID in a config account or as a constant, and validates `ctx.accounts.settlement_program.key() == SETTLEMENT_PROGRAM_ID`)
- Transfers `refund_amount` from pool vault to agent token account
- Updates `total_payouts` on pool
- Updates aggregate cap tracking: `payouts_this_window += refund_amount`
- Rejects if `payouts_this_window > total_deposited * 30 / 100` (30% aggregate cap)
- Rejects if circuit breaker is active

### Settlement Program (2 instructions)

**`submit_claim`** — oracle submits a claim and triggers settlement
- Signer: pool authority (backend oracle keypair)
- Validations:
  - Policy `is_active == true`
  - Trigger type is covered by policy's tier:
    - Basic (0): timeout (0), error (1) only
    - Standard (1): timeout (0), error (1), latency_sla (3)
    - Premium (2): all trigger types
  - `coverage_remaining >= refund_amount`
  - Claim PDA does not already exist (idempotent)
  - Anti-abuse: `claims_this_hour < 10`, `claims_today < 50` (resets counters if clock passed threshold)
- Creates Claim PDA with status `submitted` (0)
- CPI to Pool Program's `payout` instruction
- On success: updates Claim status to `settled` (1), sets `settled_at`
- Decrements `coverage_remaining` on Policy
- Increments anti-abuse counters on Policy

**`reject_claim`** — oracle records a rejected claim
- Signer: pool authority
- Creates Claim PDA with status `rejected` (2)
- No fund movement
- Used for audit trail when anti-abuse checks fail off-chain

---

## Backend Integration

### Oracle Setup

- New environment variable: `ORACLE_KEYPAIR_PATH` (path to Solana keypair JSON file)
- Backend loads keypair on startup, initializes Anchor client
- Keypair must be funded with SOL for transaction fees
- Keypair must match `authority` on each CoveragePool

### Claim Settlement Flow

```
1. SDK reports failed call → POST /api/v1/records        (existing, unchanged)
2. maybeCreateClaim() fires → claim row, status "detected"  (existing, unchanged)
3. NEW: claimSettler checks: does this agent have an active on-chain policy for this provider?
   - Query: SELECT policy_id FROM ... or check on-chain via RPC
4. If yes:
   a. Build submit_claim transaction with claim data
   b. Sign with oracle keypair
   c. Send to Solana, await confirmation
   d. Update claims table:
      - status: "detected" → "settled"
      - tx_hash: Solana transaction signature
      - settlement_slot: confirmed slot number
      - policy_id: on-chain policy PDA address
5. If no on-chain policy:
   - status stays "simulated" (existing behavior, unchanged)
```

Existing simulated claims flow is untouched. On-chain settlement is purely additive.

### New Backend Utility

**`packages/backend/src/utils/solana.ts`**
- Anchor client initialization (Connection, Provider, Program)
- Transaction builders for each instruction
- Oracle signing helper
- Confirmation polling

### New API Endpoints

**`GET /api/v1/pools`** — list all coverage pools
- Returns: provider name, pool capital, utilization %, estimated APY, active policy count, circuit breaker status

**`GET /api/v1/pools/:providerId`** — pool detail
- Returns: full pool state, underwriter positions, settled claims with tx hashes

**`POST /api/v1/policies`** — agent requests policy creation
- Backend builds the `create_policy` transaction
- Returns serialized transaction for agent to sign client-side
- Agent signs and submits (keeps agent's keypair off the backend)

### Changes to Existing Code

- `claims.ts` — `maybeCreateClaim()` gains a post-step: check for on-chain policy, call settlement if found
- `schema.sql` — no changes needed (SC-ready fields already exist: `policy_id`, `tx_hash`, `settlement_slot`)
- `index.ts` — register new pool/policy routes

---

## SDK Changes

### Minimal Impact

The SDK (`@pact-network/monitor`) hot path is unchanged. The golden rule holds: if anything fails internally, the API call still succeeds.

The agent does NOT submit claims. The backend oracle does. So:

- `wrapper.ts` — unchanged
- `classifier.ts` — unchanged
- `storage.ts` / `sync.ts` — unchanged

### Additions

- **Policy info helper** — utility to query `GET /api/v1/policies/:agentId` so agents can check their coverage status
- **Premium calculator** — utility that computes expected premium given a provider's insurance rate and desired coverage tier

These are convenience utilities, not part of the monitoring hot path.

---

## Scorecard UI Additions

### New Components

**Coverage Pools Panel** (main page, below NetworkActivity)
- Table: Provider name, Pool capital (USDC), Utilization %, Underwriter APY, Active policies, Circuit breaker status
- Brutalist styling, copper for financial values, JetBrains Mono for data

**Pool Detail View** (new route: `/pool/:providerId`)
- Pool stats: total deposited, premiums, payouts, reserve balance
- Underwriter positions table: address (truncated), amount, share %, deposit date
- Settled claims list: agent, trigger type, refund amount, tx_hash (Solana explorer link), slot
- Pool health chart (Recharts): capital vs payouts over time

**Provider Detail Enhancement** (existing `/provider/:id`)
- New "Coverage" section: pool capital, insurance rate, active policy count
- Link to pool detail view

### New Hooks and API Client

- `usePool(providerId)` — fetches pool detail, auto-refresh
- `usePools()` — fetches all pools for table
- `getPool()`, `getPools()` in API client
- Follow existing patterns (`useProviders`, `useAnalytics`)

### No Changes To

- ProviderTable, NetworkActivity, FailureTimeline, FailureBreakdown
- Theme system, `useChartColors()` hook
- Existing routes

---

## Anti-Abuse Mechanisms

### On-Chain (Settlement Program)

**Claim frequency limits** — on Policy account
- `claims_this_hour` max 10 per agent per API per hour
- `claims_today` max 50 per agent per API per day
- Counters reset based on `Clock::get().unix_timestamp` vs `last_hour_reset` / `last_day_reset`
- Enforced in `submit_claim` instruction

**Per-event aggregate cap** — on CoveragePool account
- `payouts_this_window` tracked against 30% of `total_deposited`
- Rolling window resets periodically (via `window_start`)
- Enforced in `payout` CPI instruction

**Coverage tier validation** — in `submit_claim`
- Basic: timeout, error
- Standard: timeout, error, latency_sla
- Premium: timeout, error, latency_sla, schema_mismatch
- Claim rejected if trigger type not covered

### Off-Chain (Backend)

**Circuit breaker**
- Backend monitors error rate per provider (existing data)
- >50% error rate in 5-minute window triggers `toggle_circuit_breaker` on-chain
- Pool halts until authority re-enables

**Volume caps**
- Per-agent insured call volume capped at 2x trailing 7-day average per API
- Checked before building `submit_claim` transaction
- Cheaper off-chain than storing 7 days of history in PDAs

**Payment verification**
- Existing: `maybeCreateClaim()` requires `payment_amount > 0`
- No payment = no claim = no on-chain submission

### Deferred

- Multi-observer validation (requires verifier network)
- Advanced withdrawal schedules

---

## Testing Strategy

### On-Chain (Anchor Tests)

**Rust unit tests** — per-instruction validation logic
- Invalid authority rejected
- Insufficient funds rejected
- Cooldown enforced on withdrawal
- Tier coverage checks (Basic policy + schema_mismatch trigger = rejected)
- Claim frequency limits enforced
- Aggregate cap enforced
- Circuit breaker blocks claims and policies

**TypeScript integration tests** (localnet) — end-to-end flows
1. Initialize pool → deposit → create policy → submit claim → verify refund
2. Duplicate claim (same call_record_id) → rejected (idempotent)
3. Basic policy + schema_mismatch trigger → rejected
4. Withdrawal before 7-day cooldown → rejected
5. Payout exceeding 30% aggregate cap → rejected
6. Circuit breaker active → claim rejected, policy creation rejected
7. Policy exhausted (coverage_remaining = 0) → claim rejected
8. Deactivate policy → refund unused coverage

### Backend Tests

- Oracle transaction building and signing (mock localnet)
- Claim settlement flow: policy exists → settled on-chain, no policy → stays simulated
- New pool/policy API endpoints return correct data
- Circuit breaker triggers correctly from error rate monitoring

### Devnet Testing

- Deploy both programs
- Seed pools with test USDC for existing providers
- Run full loop: deposit → policy → SDK triggers failure → backend settles claim on-chain
- Verify on Solana explorer (tx_hash, account state)

---

## Revenue Split (Whitepaper Parameters)

On premium deposit (`create_policy`):
- **50%** reserved for claims (stays in vault as available payout capital)
- **10%** protocol fee (tracked in `protocol_fees`, withdrawable by protocol authority)
- **2%** reserve fund (tracked in `reserve_balance`, emergency buffer)
- **38%** underwriter yield (stays in vault, distributed proportionally via `share_bps`)

These percentages are constants in the Pool Program (50/10/2/38). Can be made configurable via a protocol config PDA in a future upgrade.

---

## Key Parameters (from Whitepaper)

| Parameter | Value |
|-----------|-------|
| Premium range | 0.1% to 10% of call cost |
| Protocol fee | 10% of premiums |
| Reserve fund | 2% of premiums |
| Target loss ratio | 45-55% |
| Pool cap | 20x monthly premium volume |
| Max single-event loss | 30% of pool capital |
| Withdrawal cooldown | 7 days |
| Claim limit (hourly) | 10 per agent per API |
| Claim limit (daily) | 50 per agent per API |
| Volume cap | 2x trailing 7-day average |
| Circuit breaker threshold | 50% error rate in 5 minutes |
| Chain | Solana (devnet initially) |
| Settlement token | USDC (extensible via mint field) |

---

## File Structure

```
packages/program/
  Anchor.toml
  Cargo.toml
  programs/
    pact-pool/
      Cargo.toml
      src/
        lib.rs              // Pool Program entry point
        state.rs            // CoveragePool, UnderwriterPosition, Policy accounts
        instructions/
          initialize_pool.rs
          deposit.rs
          withdraw.rs
          create_policy.rs
          deactivate_policy.rs
          toggle_circuit_breaker.rs
          payout.rs         // CPI-only
        error.rs            // Custom error codes
    pact-settlement/
      Cargo.toml
      src/
        lib.rs              // Settlement Program entry point
        state.rs            // Claim account
        instructions/
          submit_claim.rs
          reject_claim.rs
        error.rs
  tests/
    pool.ts                 // Pool Program integration tests
    settlement.ts           // Settlement Program integration tests
    e2e.ts                  // Full flow tests
  migrations/
    deploy.ts

packages/backend/src/
  utils/solana.ts           // NEW: Anchor client, tx builders, oracle signing
  routes/pools.ts           // NEW: pool/policy API endpoints
  (existing files modified: claims.ts, index.ts)

packages/scorecard/src/
  api/client.ts             // ADD: getPool, getPools methods
  hooks/usePool.ts          // NEW: pool data fetching hook
  components/
    CoveragePoolsPanel.tsx  // NEW: pools table on main page
    PoolDetail.tsx          // NEW: /pool/:providerId view
  (existing modified: ProviderDetail.tsx — add Coverage section)
```
