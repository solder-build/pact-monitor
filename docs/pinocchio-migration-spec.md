# Pinocchio Migration Specification — `pact_insurance`

Author: recon crew (read-only analysis)
Base commit: tip of `migrate/pinocchio` (this worktree)
Scope: port `packages/program/programs/pact-insurance/` from Anchor 1.0 to
Pinocchio 0.10 while preserving every current behavior, account layout intent,
and the `@q3labs/pact-insurance` SDK contract.

Out of scope: actually writing Pinocchio code, changing SDK/CI/backend, any
cargo/anchor build invocation.

Program ID (current, Anchor): `2Go74eCvY8vCco3WPuteGzrhKz8v3R7Pcp5tjuFpcmN3`
Anchor deps: `anchor-lang = 1.0.0`, `anchor-spl = 1.0.0`, `sha2 = 0.10`.
Feature gate: `enforce-deployer` pins deployer to
`5XyGGyazg6rGJU3Hjkrx1PDM1rBE3FraRnMauSR46rW1` at init time.

The port MUST keep the program ID identical so upgrade authority can be reused
and existing PDAs remain canonical. All seed strings MUST match bit-for-bit.

---

## 1. Program Inventory

Source root: `packages/program/programs/pact-insurance/src/`

| File | Role | Anchor constructs to unwind |
|---|---|---|
| `lib.rs` | `declare_id!`, `#[program]` module with 11 instruction wrappers, optional deployer gate | `#[program]`, `declare_id!`, deployer feature flag, re-export glob |
| `state.rs` | Five `#[account] #[derive(InitSpace)]` structs + two `#[derive(AnchorSerialize/Deserialize)]` enums; seed prefix constants | `#[account]` (auto 8-byte discriminator), `InitSpace`, `#[max_len(...)]`, Borsh serde for enums |
| `constants.rs` | 13 plain `pub const` values (pure data) | none — copy verbatim |
| `error.rs` | `PactError` enum with `#[error_code]`, 31 variants | `#[error_code]` macro — replace with `#[repr(u32)] enum + From<_> for ProgramError::Custom` |
| `instructions/mod.rs` | Plain `pub mod` + glob re-export | unchanged |
| `instructions/initialize_protocol.rs` | Creates `ProtocolConfig` PDA, writes defaults | `init` CreateAccount, `Signer`, feature-gated deployer check |
| `instructions/update_config.rs` | Authority-gated partial updates with safety floors; `treasury`/`usdc_mint` frozen | `has_one = authority` |
| `instructions/update_oracle.rs` | Authority rotates `config.oracle`; validates non-zero & not == authority | `has_one = authority` |
| `instructions/create_pool.rs` | Creates `CoveragePool` PDA + initializes token `vault` PDA (`token::authority = pool`) | `init` PDA, `init` token account via anchor-spl, `has_one`, `constraint = !paused` |
| `instructions/deposit.rs` | Underwriter deposits USDC to vault; `init_if_needed` `UnderwriterPosition` | `init_if_needed`, `Account<TokenAccount>`, `token::transfer` CPI |
| `instructions/withdraw.rs` | Underwriter withdraws from vault with cooldown + underfund checks; pool PDA signs token transfer | `Box<Account<>>`, PDA `invoke_signed` transfer |
| `instructions/enable_insurance.rs` | Agent creates `Policy` PDA; requires SPL `Approve` delegation to pool PDA | `init` with `#[instruction(args)]` seeds, delegation constraints |
| `instructions/disable_policy.rs` | Agent sets `policy.active = false`, decrements `pool.active_policies` | `has_one = agent` |
| `instructions/settle_premium.rs` | Oracle-signed crank: pulls gross premium from agent ATA using delegation; splits into `protocol_fee` → treasury, `pool_premium` → vault | 2 x CPI with PDA signer; clamp to delegated/balance; does not require `policy.active` |
| `instructions/submit_claim.rs` | Oracle-signed: creates `Claim` PDA (seed = `sha256(call_id)`), pays refund from vault to agent ATA, enforces aggregate cap window | `init` PDA with hashed seed, CPI signed by pool PDA |
| `instructions/update_rates.rs` | Oracle-signed rate update, clamped `[pool.min_premium_bps, 10_000]` | `constraint = oracle.key() == config.oracle` |

---

## 2. Account Model

All sizes below are **body size only**; Anchor's implicit 8-byte discriminator
must be replaced with an explicit 1-byte discriminator in Pinocchio. Each struct
also needs explicit `#[repr(C)]` padding to 8-byte alignment.

### 2.1 `ProtocolConfig`
- Seed: `[b"protocol"]`
- PDA owner: program
- Stored bump: `bump: u8` (canonical; Anchor stores `ctx.bumps.config`)
- Anchor layout (body, Borsh): 4×Pubkey (128) + 4×u16 (8) + 2×u64 (16) + 4×i64 (32) + u8 + bool + u8 = **187 bytes** + 8 disc = 195 on-chain.
- Pinocchio layout target: 1-byte disc + 4×[u8;32] (128) + 4×u16 (8) + 2×u64 (16) + 4×i64 (32) + 3×u8 + bool (~4) + padding → pack into `#[repr(C)]` struct, round up to 8-byte alignment. Exact LEN computed from `size_of::<Self>()`.
- Creator: `initialize_protocol` (deployer is payer; config pays 0 rent itself)
- Closer: none (permanent)
- Rent: rent-exempt

### 2.2 `CoveragePool`
- Seed: `[b"pool", provider_hostname.as_bytes()]`  → **variable-length seed** (up to 128 bytes)
- PDA owner: program
- Stored bump: `bump: u8`
- Fields: 2×Pubkey + String(max 128) + 2×Pubkey + 4×u64 + 3×u16 + u64 + u32 + u64 + 2×i64 + 2×i64 + u8 = **Anchor INIT_SPACE body ~ 313 bytes** (128 hostname + 4 length prefix + fixed).
- Pinocchio strategy: replace `String` with `[u8; MAX_HOSTNAME_LEN] + u8 len` to keep zero-copy; or keep a small header + manual copy on init. UNCLEAR — needs Alan's input: acceptable to fix `hostname` to exactly 128 bytes on disk (paying rent for unused) or keep variable-length and give up zero-copy for this struct?
- Creator: `create_pool` (authority pays)
- Closer: none
- Rent: rent-exempt

### 2.3 `UnderwriterPosition`
- Seed: `[b"position", pool.key().as_ref(), underwriter.key().as_ref()]`
- PDA owner: program
- Stored bump: `bump: u8`
- Fields: 2×Pubkey (64) + 3×u64 (24) + 2×i64 (16) + u8 = **105 bytes** body. Pad to 112 or 120.
- Creator: `deposit` (init_if_needed — Pinocchio equivalent: if `data_is_empty()` then `CreateAccount`; else verify owner+discriminator; see §6)
- Closer: none currently

### 2.4 `Policy`
- Seed: `[b"policy", pool.key().as_ref(), agent.key().as_ref()]`
- PDA owner: program
- Stored bump: `bump: u8`
- Fields: 2×Pubkey + String(max 64) + Pubkey + 3×u64 + bool + 2×i64 + u8 = body ~ 64 + 4 + 32 + 24 + 16 + 1 + 1 = 142. Pad per alignment rules.
- Same `String` issue as `CoveragePool`. UNCLEAR — needs Alan's input: fix `agent_id` to 64 bytes on-chain?
- Creator: `enable_insurance` (agent pays)
- Closer: none (currently `disable_policy` just flips a flag — no account close)

### 2.5 `Claim`
- Seed: `[b"claim", policy.key().as_ref(), sha256(call_id)]`  (seed #3 is the 32-byte SHA-256 digest, NOT the raw call_id — this is deliberate to sidestep seed length limits)
- PDA owner: program
- Stored bump: `bump: u8`
- Fields: 3×Pubkey + String(max 64) + enum + [u8;32] + i64 + u32 + u16 + 2×u64 + enum + 2×i64 + u8 = body ~ 96 + 68 + 1 + 32 + 8 + 4 + 2 + 16 + 1 + 16 + 1 = 245. Pad.
- Creator: `submit_claim` (oracle pays)
- Closer: none

### 2.6 Token vault (SPL Token account, not a program-owned data account)
- Seed: `[b"vault", pool.key().as_ref()]`
- PDA owner: SPL Token program
- Stored bump: **not stored** — derived fresh each instruction via `seeds` block in Anchor (bumps.vault isn't retained). The port MUST either store it in `CoveragePool` or re-derive on every use.
- `token::authority = pool`, `token::mint = usdc_mint` — this MUST be preserved; the pool PDA is the delegate authority for agent ATAs and the withdrawal/refund signer.
- Creator: `create_pool` (via anchor-spl `init` + SPL-Token `InitializeAccount3`) — in Pinocchio we must call System `CreateAccount` + SPL-Token `InitializeAccount3` ourselves, owner = Token Program, signer seeds = vault PDA.

### 2.7 Agent token accounts
- These are standard ATAs (SPL-Token Associated Token Account program). Not created by the program. Validated by ownership/mint/delegate fields at CPI time.

### Enum layouts to preserve

`TriggerType`: `Timeout | Error | SchemaMismatch | LatencySla` — serialized as 1-byte Borsh variant.
`ClaimStatus`: `Pending | Approved | Rejected` — 1 byte.

Port must keep the on-wire variant order identical; the SDK reads these via the
IDL.

---

## 3. Instruction Matrix

All wire layouts below are current Anchor Borsh encoding. The port MUST keep
compatibility. We assume 1-byte instruction discriminator (0..=10) prefixed to
the argument Borsh blob.

**Proposed discriminator assignment** (must match SDK regen):

| Disc | Instruction |
|---|---|
| 0 | `initialize_protocol` |
| 1 | `update_config` |
| 2 | `update_oracle` |
| 3 | `create_pool` |
| 4 | `deposit` |
| 5 | `enable_insurance` |
| 6 | `disable_policy` |
| 7 | `settle_premium` |
| 8 | `withdraw` |
| 9 | `update_rates` |
| 10 | `submit_claim` |

### 3.1 `initialize_protocol` (disc 0)
Accounts: `[config (PDA, writable), deployer (signer, writable), system_program]`
Args: `InitializeProtocolArgs { authority, oracle, treasury, usdc_mint }` → 4 × 32 = 128 bytes Borsh.
Checks:
- Pinocchio: assert `system_program.key() == system::ID`; assert deployer is signer/writable.
- Derive PDA `[b"protocol"]`, assert `config.key() == pda`, assert `config.data_is_empty()`.
- If `enforce-deployer` feature active: assert `deployer.key() == DEPLOYER_PUBKEY`.
CPIs: System `CreateAccount` signed by protocol-PDA seed.
Invariants: writes all defaults from `constants.rs`; sets `paused = false`, stores `bump`.
Post-cond: account owned by program, discriminated as `ProtocolConfig`.

### 3.2 `update_config` (disc 1)
Accounts: `[config (writable), authority (signer)]`
Args: `UpdateConfigArgs` with 13 `Option<..>` fields (Borsh: each option is 1 byte discriminator + payload if Some).
Checks:
- Validate config PDA + discriminator; assert `config.authority == authority.key()`; assert authority is signer.
- Range checks per option (per `constants.rs` floors/caps).
- Reject any `Some(_)` on `treasury` or `usdc_mint` → `FrozenConfigField`.
CPIs: none. Invariant: safety floors are enforced on every Some value.

### 3.3 `update_oracle` (disc 2)
Accounts: `[config (writable), authority (signer)]`
Args: `Pubkey` (32 bytes).
Checks: has_one(authority); `new_oracle != default && new_oracle != config.authority`.
Invariant: authority/oracle split is immutable — oracle can be rotated but cannot collapse back to authority.

### 3.4 `create_pool` (disc 3)
Accounts: `[config, pool (PDA, writable), vault (PDA SPL token, writable), usdc_mint, authority (signer, writable), system_program, token_program, rent]`
Args: `CreatePoolArgs { provider_hostname: String, insurance_rate_bps: Option<u16>, max_coverage_per_call: Option<u64> }`.
Checks:
- `!config.paused`, `config.authority == authority.key()`.
- `provider_hostname.len() <= MAX_HOSTNAME_LEN (128)`.
- Derive pool PDA with hostname bytes; assert empty; assert `usdc_mint.key() == config.usdc_mint` (UNCLEAR — see §8; Anchor currently does NOT enforce this).
- Derive vault PDA; assert empty.
CPIs: (a) `CreateAccount` for pool PDA, signed by pool seeds; (b) `CreateAccount` for vault with `owner = spl_token::ID`, signed by vault seeds; (c) SPL-Token `InitializeAccount3` to bind `vault.mint = usdc_mint` and `vault.owner = pool`.
Post-cond: pool is writable program-owned PDA, vault is SPL token account with `authority = pool_pda`.
Note: store `vault_bump` in `CoveragePool` to avoid `find_program_address` on hot path (currently Anchor pays that cost every withdraw/settle/claim).

### 3.5 `deposit` (disc 4)
Accounts: `[config, pool (writable), vault (writable), position (PDA, writable; init_if_needed), underwriter_token_account (writable), underwriter (signer, writable), token_program, system_program]`
Args: `u64` amount.
Checks: `!config.paused`; `amount > 0`; `amount >= config.min_pool_deposit`; `underwriter_token_account.owner == underwriter.key()`; `underwriter_token_account.mint == pool.usdc_mint`; `vault.mint == pool.usdc_mint` (held by Anchor via constraint, must be manual in Pinocchio).
CPIs: SPL-Token `Transfer { from = underwriter_ata, to = vault, authority = underwriter, amount }` (user-signed, no PDA).
State: on first deposit init the `position` PDA (CreateAccount signed by position seeds); on subsequent deposits preserve all counters except bump/pool/underwriter. Checked-add on `position.deposited`, `pool.total_deposited`, `pool.total_available`.

### 3.6 `enable_insurance` (disc 5)
Accounts: `[config, pool (writable), policy (PDA, writable), agent_token_account, agent (signer, writable), system_program]`
Args: `EnableInsuranceArgs { agent_id: String, expires_at: i64 }`.
Checks:
- `!config.paused`; `agent_id.len() <= 64`; `expires_at > now`.
- `agent_token_account.owner == agent.key()`; `.mint == pool.usdc_mint`; `.delegate == Some(pool.key())`; `.delegated_amount > 0`.
CPIs: `CreateAccount` for policy PDA, signed by policy seeds.
Post-cond: `active = true`, `pool.active_policies += 1`.
Note: Anchor seeds use `agent.key()` for the policy PDA (tied to wallet), NOT `agent_token_account.key()`. The port MUST preserve this — changing the seed strategy re-derives all existing policy addresses.

### 3.7 `disable_policy` (disc 6)
Accounts: `[pool (writable), policy (writable), agent (signer)]`
Args: none.
Checks: `policy.pool == pool.key()`; `policy.agent == agent.key()`; `policy.active == true`.
Mutation: `policy.active = false`; `pool.active_policies = saturating_sub(1)` (Anchor uses saturating; preserve that).

### 3.8 `settle_premium` (disc 7)
Accounts: `[config, pool (writable), vault (writable; used only for read of mint authority check), policy (writable), agent_token_account (writable), treasury_token_account (writable), oracle (signer), token_program]`
Args: `u64` call_value.
Checks: `call_value > 0`; `oracle.key() == config.oracle`; `policy.pool == pool.key()`; **does not** require `policy.active`; requires `now < policy.expires_at`; `agent_token_account.key() == policy.agent_token_account`; `.mint == pool.usdc_mint`; `.delegate == Some(pool)`; `treasury_token_account.mint == pool.usdc_mint`; `treasury_token_account.owner == config.treasury`.
Premium calc (u128 intermediate, saturating to u64 at end):
```
gross = min( call_value * pool.insurance_rate_bps / 10_000,
             agent_ata.delegated_amount,
             agent_ata.amount )
if gross == 0: no-op return Ok(())
protocol_fee = gross * config.protocol_fee_bps / 10_000
pool_premium = gross - protocol_fee
```
CPIs (both signed by pool PDA seeds `[b"pool", hostname, &[bump]]`):
- if `pool_premium > 0`: `Transfer(agent_ata -> vault, pool_premium)` authority=pool (uses SPL delegation)
- if `protocol_fee > 0`: `Transfer(agent_ata -> treasury_ata, protocol_fee)` authority=pool
Post-cond: `policy.total_premiums_paid += gross`, `pool.total_premiums_earned += pool_premium`, `pool.total_available += pool_premium`.
Pinocchio note: the `vault` account is fetched but its balance is not mutated here — it's just the destination of the pool-share transfer. Keep it mutable because the SPL-Token Transfer mutates token-account state.

### 3.9 `withdraw` (disc 8)
Accounts: `[config, pool (writable), vault (writable), position (writable), underwriter_token_account (writable), underwriter (signer), token_program]`
Args: `u64` amount.
Checks: `amount > 0`; `position.underwriter == underwriter.key()`; `underwriter_token_account.owner == underwriter.key()`; `.mint == pool.usdc_mint`; `now - position.deposit_timestamp >= max(config.withdrawal_cooldown_seconds, ABSOLUTE_MIN_WITHDRAWAL_COOLDOWN)`; `position.deposited >= amount`; `pool.total_available >= amount`.
CPIs: SPL-Token `Transfer(vault -> underwriter_ata, amount)`, authority = pool PDA, signer seeds `[b"pool", hostname, &[bump]]`.
Post-cond: checked-sub on `position.deposited`, `pool.total_deposited`, `pool.total_available`.
Note: `position.deposit_timestamp` is reset on every deposit (see `deposit.rs:92`); this means any new deposit restarts the cooldown clock even for previously vested funds. Preserve this behavior; flag for Alan in §8.

### 3.10 `update_rates` (disc 9)
Accounts: `[config, pool (writable), oracle (signer)]`
Args: `u16` new_rate_bps.
Checks: `oracle.key() == config.oracle`; `new_rate_bps <= 10_000`; `new_rate_bps >= pool.min_premium_bps`.

### 3.11 `submit_claim` (disc 10)
Accounts: `[config, pool (writable), vault (writable), policy (writable), claim (PDA, writable), agent_token_account (writable), oracle (signer, writable), token_program, system_program]`
Args: `SubmitClaimArgs { call_id: String, trigger_type: TriggerType (1 byte), evidence_hash: [u8;32], call_timestamp: i64, latency_ms: u32, status_code: u16, payment_amount: u64 }`.
Checks:
- `!config.paused`; `call_id.len() <= 64`; `payment_amount > 0`; `policy.active`; `now < policy.expires_at`; `(now - call_timestamp) <= config.claim_window_seconds`; `policy.pool == pool.key()`.
- `oracle.key() == config.oracle`; `agent_token_account.key() == policy.agent_token_account`, `.mint == pool.usdc_mint`, `.owner == policy.agent`.
- Claim PDA seed = `[b"claim", policy.key(), sha256(call_id)]` → computed on-chain with `sha2::Sha256`. Assert claim account is empty (duplicate detection).
Refund calc: `refund = min(payment_amount, pool.max_coverage_per_call, pool.total_available)`.
Aggregate window reset: if `now - pool.window_start > config.aggregate_cap_window_seconds` → reset `payouts_this_window = 0`, `window_start = now`.
Cap check: `pool.payouts_this_window + refund <= pool.total_deposited * min(config.aggregate_cap_bps, ABSOLUTE_MAX_AGGREGATE_CAP_BPS) / 10_000`.
CPIs: `CreateAccount` for `claim` PDA (oracle pays); SPL-Token `Transfer(vault -> agent_ata, refund)` signed by pool PDA.
Post-cond: claim populated with inputs + `status=Approved`, `resolved_at=now`; `pool.total_claims_paid += refund`; `pool.total_available -= refund`; `pool.payouts_this_window += refund`; `policy.total_claims_received += refund`; `policy.calls_covered += 1`.

---

## 4. Cross-Program Invocations

| Source | Target | Accounts | Signer | Anchor implicit behavior Pinocchio must do manually |
|---|---|---|---|---|
| `initialize_protocol` | System / `CreateAccount` | `[deployer, config_pda]` | signed by `[b"protocol", &[bump]]` | compute rent via `Rent::get()`, compute space from `Self::LEN`, pass owner = program id |
| `create_pool` | System / `CreateAccount` (pool) | `[authority, pool_pda]` | `[b"pool", hostname, &[bump]]` | same |
| `create_pool` | System / `CreateAccount` (vault) | `[authority, vault_pda]` | `[b"vault", pool_key, &[vault_bump]]`, owner = `spl_token::ID` | Anchor's `#[account(init, token::mint, token::authority)]` folds both CreateAccount and InitializeAccount3 |
| `create_pool` | SPL Token / `InitializeAccount3` | `[vault, mint, pool (authority)]` | none (token-program no-sign) | explicitly pass `InitializeAccount3` ix with pool PDA as authority |
| `deposit` | SPL Token / `Transfer` | `[underwriter_ata, vault, underwriter]` | underwriter (signed by tx) | |
| `enable_insurance` | System / `CreateAccount` (policy) | `[agent, policy_pda]` | `[b"policy", pool_key, agent_key, &[bump]]` | |
| `withdraw` | SPL Token / `Transfer` | `[vault, underwriter_ata, pool]` | `[b"pool", hostname, &[bump]]` | pool PDA must sign even though it has zero data mutation |
| `settle_premium` (pool share) | SPL Token / `Transfer` | `[agent_ata, vault, pool]` | `[b"pool", hostname, &[bump]]` | uses SPL delegation — `delegate = pool` authorizes the pull |
| `settle_premium` (treasury fee) | SPL Token / `Transfer` | `[agent_ata, treasury_ata, pool]` | `[b"pool", hostname, &[bump]]` | same delegation |
| `submit_claim` | System / `CreateAccount` (claim) | `[oracle, claim_pda]` | `[b"claim", policy_key, sha256(call_id), &[bump]]` | |
| `submit_claim` | SPL Token / `Transfer` | `[vault, agent_ata, pool]` | `[b"pool", hostname, &[bump]]` | |

Anchor also implicitly (1) checks each Program account's pubkey against its declared ID, (2) checks token-account ownership/mint/delegate via `Account<TokenAccount>` deserialization, (3) allocates a heap buffer for Borsh deserialization of PDA data. All three must be replaced with explicit Pinocchio checks — the first two by key comparison and raw-byte field reads, the third by `bytemuck::from_bytes` over the raw `data`.

---

## 5. Existing Test Matrix

Location: `packages/program/tests/*.ts` and `packages/program/test-utils/setup.ts`
Harness: `anchor test` (Mocha+Chai+TypeScript), `solana-test-validator` per repo CLAUDE.md note.

### 5.1 `test-utils/setup.ts`
- Module-global `authority`, `oracle`, `treasury` keypairs (generated once per mocha process).
- `getOrInitProtocol(program, provider)` — airdrops 10 SOL to authority, creates USDC mint with 6 decimals, calls `initialize_protocol` once, rejects if config PDA already on-chain.

### 5.2 `protocol.ts` (8 tests)
- `initializes the protocol config with a separate authority and oracle` — asserts defaults + that authority ≠ deployer and authority ≠ oracle.
- `rejects second initialization (PDA already exists)` — rejection on re-init.
- `[feature=enforce-deployer] rejects init from any signer other than DEPLOYER_PUBKEY` — skipped in default CI.
- `updates protocol_fee_bps when authority calls update_config` — happy path.
- `rejects protocol_fee_bps above ABSOLUTE_MAX (3000)` — safety floor.
- `rejects withdrawal_cooldown below ABSOLUTE_MIN (3600)`.
- `rejects aggregate_cap_bps above ABSOLUTE_MAX (8000)`.
- `rejects update_config from non-authority`.
- `rejects min_pool_deposit below ABSOLUTE_MIN (1_000_000)`.
- `rejects claim_window_seconds below ABSOLUTE_MIN (60)`.

### 5.3 `pool.ts` (4 tests)
- `creates a pool for a provider hostname`.
- `updates pool insurance_rate_bps via update_rates (oracle-signed)`.
- `rejects update_rates from non-oracle signer`.
- `rejects duplicate pool creation`.

### 5.4 `underwriter.ts` (4 tests)
- `allows underwriter to deposit above minimum`.
- `rejects withdraw before cooldown elapsed`.
- `rejects deposit below min_pool_deposit`.
- `rejects zero-amount deposit`.

### 5.5 `policy.ts` (2 tests)
- `rejects enable_insurance without prior SPL approve`.
- `enables insurance after SPL approve to pool PDA`.

### 5.6 `settlement.ts` (2 tests)
- `settles premium by pulling from agent ATA (not from a vault balance)`.
- `rejects settle_premium when oracle signer is wrong`.

### 5.7 `claims.ts` (3 tests)
- `submits a claim and transfers refund`.
- `rejects duplicate claim (same call_id)` (validates sha256 seed strategy).
- `rejects claim outside window (old timestamp)`.

### 5.8 `security-hardening.ts` (19 tests)
- C-02 suite: submit_claim oracle gating; update_oracle rotate/reject non-authority/reject zero pubkey/reject equal-to-authority; submit_claim rejects authority keypair as oracle.
- H-02 suite: submit_claim accepts 36-char UUID-with-hyphens and 64-char (MAX_CALL_ID_LEN) call ids.
- C-03: submit_claim rejects agent_token_account that is not policy.agent_token_account.
- H-03 suite: update_config rejects treasury mutation; rejects usdc_mint mutation.
- H-04 suite: update_rates rejects rate > 10_000 bps; rejects rate < pool.min_premium_bps.
- H-05 suite: disable_policy sets active=false + decrements; submit_claim rejects disabled/expired; settle_premium rejects expired; settle_premium STILL collects on disabled policy (premium-evasion guard); enable_insurance rejects expires_at in past.

**Total: 42 regression tests** — every one must pass against the Pinocchio port without logic modification. Any divergence is a spec violation.

### 5.9 Test plumbing the port MUST not break
- Anchor IDL is consumed by tests via `anchor.workspace.PactInsurance as Program<PactInsurance>`. The port produces a Shank-generated IDL that the TS harness cannot load as-is. See §10.
- `sha2 = "0.10"` is a dev+runtime dep; the port can keep `sha2` as a no-std dep (`default-features = false`) — it compiles to SBF.

---

## 6. Anchor → Pinocchio Mapping

| Anchor construct | Pinocchio implementation |
|---|---|
| `#[program] pub mod pact_insurance` with method signatures | `process_instruction(program_id, accounts, data)` + single-byte discriminator match |
| `declare_id!("2Go74...")` | `pinocchio::declare_id!("2Go74...")` — same address; program ID is signing identity for PDAs |
| `#[account] struct X` (8-byte sighash disc) | `#[repr(C)] #[derive(Pod,Zeroable)] struct X { discriminator: u8, ... }`; custom 1-byte disc table |
| `#[derive(InitSpace)]` | `pub const LEN: usize = core::mem::size_of::<Self>()` |
| `#[max_len(N)]` on String/Vec | Replace with fixed `[u8; N] + u8 len` for zero-copy OR manual Borsh encoding |
| `#[account(init, payer, space, seeds, bump)]` | `(pda, bump) = find_program_address(seeds, program_id)`; assert `acc.data_is_empty()`; `CreateAccount { from=payer, to=acc, lamports=Rent::get().minimum_balance(LEN), space=LEN as u64, owner=program_id }.invoke_signed(&[seeds, &[bump]])` |
| `#[account(init_if_needed, ...)]` | branch on `data_is_empty()` — init path OR re-open path that checks owner + discriminator |
| `#[account(mut)]` | `if !acc.is_writable() { return Err(...) }` |
| `Signer<'info>` | `if !acc.is_signer() { return Err(MissingRequiredSignature) }` |
| `has_one = authority` | `if state.authority != *authority.key() { return Err(Unauthorized) }` |
| `constraint = !config.paused` | explicit `if cfg.paused { return Err(ProtocolPaused) }` |
| `Account<'info, TokenAccount>` | owner check `acc.owner() == &spl_token::ID` + byte-offset read of mint(0..32), owner(32..64), amount(64..72), delegate(72+), delegated_amount — follow SPL Token account layout spec |
| `Account<'info, Mint>` | owner check + byte-offset read (mint_authority, supply, decimals, is_initialized, freeze_authority) |
| `Program<'info, Token>` | `if acc.key() != &spl_token::ID { return Err(IncorrectProgramId) }` |
| `Program<'info, System>` | `if acc.key() != &pinocchio_system::ID { return Err(IncorrectProgramId) }` |
| `CpiContext::new(...)` + `token::transfer(...)` | `pinocchio_token::instructions::Transfer { source, destination, authority, amount }.invoke()` / `.invoke_signed(seeds)` |
| `token::init_account` / `anchor-spl init` | manual SPL-Token `InitializeAccount3` ix construction + `invoke_signed` |
| `#[error_code] enum` | `#[derive(Debug)] #[repr(u32)] enum PactError { ... }` + `impl From<PactError> for ProgramError { fn from(e) = ProgramError::Custom(e as u32) }` |
| `require!(cond, Err)` | `if !cond { return Err(Err.into()) }` |
| `ctx.bumps.X` | bump captured from `find_program_address` at the init site; stored in the struct; reused via `create_program_address(seeds, program_id)` on later calls |
| `Clock::get()` | `pinocchio::sysvar::clock::Clock::get()` |
| Anchor events (`emit!`) | none currently used; no replacement needed |

### 6.1 Error code assignment

Anchor `#[error_code]` starts at `6000`. To avoid silently breaking SDK clients that parse error codes, map each `PactError` variant to the **same numeric value** Anchor emits today:

| Variant | Anchor code |
|---|---|
| `ProtocolPaused` | 6000 |
| `PoolAlreadyExists` | 6001 |
| ... continue in source order (total 31 variants up to `InvalidOracleKey` = 6027) | |

Pinocchio impl: `ProgramError::Custom(6000 + variant as u32)`. The SDK/backend currently string-matches error names (e.g. `/Unauthorized/`, `/ConfigSafetyFloorViolation/`), so preserving names is mandatory; preserving numbers is strongly preferred (`AnchorError` log parsing uses them).

### 6.2 Events

Anchor `emit!` is not used in the current program — no event replacement required.
Pinocchio logs via `msg!`/`pinocchio::msg!` can replace future audit logs. Flag for Alan if observability wants specific log lines.

---

## 7. SDK Interface Contract (`@q3labs/pact-insurance`)

Inspected `packages/insurance/src/`:
- `client.ts` — `PactInsurance` class extending `EventEmitter`.
- `anchor-client.ts` — wraps `@coral-xyz/anchor` `Program` around a bundled IDL (`../idl/pact_insurance.json`), overrides `idl.address` with caller-supplied programId.
- `types.ts` — public TS types.
- `index.ts` — named exports.

### 7.1 Exported surface (must remain compatible)

From `index.ts`:
- class `PactInsurance`
- types: `PactInsuranceConfig`, `PolicyInfo`, `ClaimSubmissionResult`, `EnableInsuranceArgs`, `TopUpDelegationArgs`, `CoverageEstimate`, `BilledEvent`, `LowBalanceEvent`

Methods of `PactInsurance`:
- `new PactInsurance(config, agentKeypair)`
- `get agentPubkey(): PublicKey`
- `async enableInsurance(args): Promise<string>`
- `async topUpDelegation(args): Promise<string>`
- `async getPolicy(providerHostname): Promise<PolicyInfo | null>`
- `async listPolicies(): Promise<PolicyInfo[]>`
- `async estimateCoverage(providerHostname, usdcAmount): Promise<CoverageEstimate>`
- `async submitClaim(providerHostname, callRecordId): Promise<ClaimSubmissionResult>` (backend HTTP — program-agnostic)
- `recordCall(providerHostname, callCost)` (local event emission)

From `anchor-client.ts` (package-internal but exported for tests/backend):
- `createAnchorClient(opts): AnchorClient`
- `deriveProtocolPda(programId)`
- `derivePoolPda(programId, hostname)`
- `deriveVaultPda(programId, poolPda)`
- `derivePolicyPda(programId, poolPda, agent)`

### 7.2 On-chain coupling

The SDK reads program state via Anchor fetchers:
- `program.account.protocolConfig.fetch(protocolPda)` — needs account disc bytes [0..8] to match Anchor's `sighash("account:ProtocolConfig")` for the Anchor client to parse it. **Pinocchio port breaks this by design** (1-byte disc).
- `program.account.policy.fetch(policyPda)` — same issue.
- `program.account.policy.all([{memcmp: {offset:8, bytes: agentKey}}])` — offset 8 assumes the 8-byte Anchor disc precedes the first `agent: Pubkey` field. A 1-byte disc + 7 bytes padding to keep `agent` at offset 8 would preserve this query. **This is the only place the SDK depends on layout offsets.**
- `program.account.coveragePool.fetch(poolPda)` — layout dependent.

Consequences for the port:
1. Anchor client cannot be used against Pinocchio data as-is — the TS decoder expects the 8-byte sighash disc.
2. **Two compatible options:**
   - **Option A (preferred):** design Pinocchio account layout so `disc: u8, _pad: [u8;7]` occupies the first 8 bytes — then regenerate IDL via Codama/Shank and replace `@coral-xyz/anchor` `Program` wrapper with a Codama-generated client. SDK surface stays the same.
   - **Option B:** keep shipping an `anchor-client.ts` for read, new Codama client for write — more complex, still requires layout alignment.

The `memcmp(offset:8)` query in `listPolicies` MUST survive — so in `Policy`, the first on-disk field after the 1-byte disc + 7-byte pad MUST be `agent: [u8;32]`. Mirror this invariant in `Claim` (first Pubkey is `policy`), `UnderwriterPosition` (first is `pool`), `CoveragePool` (first is `authority`), `ProtocolConfig` (first is `authority`). This matches the current Anchor field order — good.

Instruction encoding: Anchor encodes ix data as `[8-byte sighash][borsh args]`. Codama will regenerate instruction builders from the new Shank IDL with 1-byte disc + Borsh args. The backend and SDK will need a `npm run` regen step — see §10.

### 7.3 Cannot be preserved without work

- The backend (`packages/backend/src/**`) likely uses the same Anchor bindings. Out of scope here but flag for follow-up.
- Any third-party integrator who pinned `@q3labs/pact-insurance` and ALSO called `program.methods.X(...)` directly (bypassing the class) — not our problem per §7.1 (those aren't exported), but confirm with Alan whether any sample or agent integration did so.

---

## 8. Risks and Open Questions

1. **UNCLEAR — needs Alan's input:** `CoveragePool.provider_hostname` and `Policy.agent_id` are variable-length `String`s. Pinocchio zero-copy + bytemuck prefers fixed buffers (pay full rent always) vs. variable (no zero-copy). Recommendation: fix to `[u8; MAX_*]` + `u8 len`. Impact: slightly more rent per account (~128 bytes for pool, ~64 bytes for policy); simpler, faster code; preserves `memcmp` offsets.
2. **UNCLEAR — needs Alan's input:** `create_pool` currently does not assert `usdc_mint == config.usdc_mint`. An attacker with authority (or if authority is compromised) could create a pool for an arbitrary mint. Is this intentional (multi-asset roadmap) or an oversight we should tighten during the port? Security-hardening.ts does not cover it.
3. **UNCLEAR — needs Alan's input:** `deposit.rs` resets `position.deposit_timestamp` on every top-up, which restarts the withdrawal cooldown. Is this intended? (It looks like it's by design — incentivizes long deposits — but it's surprising UX.)
4. **UNCLEAR — needs Alan's input:** Error code numbers. Do we commit to keeping `6000..=6030` (Anchor baseline) or are we free to assign fresh `Custom(0..)` codes and patch the backend/SDK error parsing? Preferring to keep the Anchor codes for zero friction.
5. **UNCLEAR — needs Alan's input:** Is the program ID `2Go74eCvY8vCco3WPuteGzrhKz8v3R7Pcp5tjuFpcmN3` already deployed anywhere important (devnet with real underwriter positions)? If yes, the Pinocchio port is a program upgrade (same ID, upgrade authority redeploys the new `.so`). If no, we can re-deploy fresh. Affects whether existing PDAs must deserialize under the new layout (they won't — accounts would need migration, which is expensive).
6. **Risk:** `init_if_needed` in `deposit.rs` (position account) is an Anchor convenience that requires explicit two-branch handling in Pinocchio. Classic footgun: re-init must not wipe existing counters. The port must branch `if data_is_empty() { create + init fresh counters } else { verify owner+disc; leave counters untouched }`.
7. **Risk:** Anchor's `#[account(init, token::mint = X, token::authority = Y)]` fuses System CreateAccount + SPL InitializeAccount3 + ownership transfer. In Pinocchio these are three explicit steps (CreateAccount with owner=TokenProgram, then InitializeAccount3 where `authority=pool_pda`). Easy to forget the `owner=TokenProgram` on CreateAccount; tests will fail at the subsequent transfer CPI because the account will not be owned by Token Program.
8. **Risk:** Anchor normalizes signer-seed borrow lifetimes; Pinocchio's `invoke_signed` is strict about seed slice lifetimes. Hostname bytes in `withdraw`/`settle_premium`/`submit_claim` currently use `.to_vec()` to get an owned `Vec<u8>` for the seeds; the Pinocchio equivalent needs `&[u8]` slices whose lifetimes outlive the invoke. Straightforward but fiddly.
9. **Risk:** Zero-copy access to SPL Token account fields without pulling `spl-token` as a dep — we'd read bytes 0..32 (mint), 32..64 (owner), 64..72 (amount, little-endian), 72..76 (`delegate` option disc), 76..108 (delegate pubkey), 108..116 (state/is_initialized), 116..120 (is_native disc), etc. This is a well-known Solana Token account layout but hand-coding it in the program adds surface area. Consider `pinocchio-token`'s built-in `TokenAccount::from_account_info` helper if it exists in 0.4.
10. **Risk:** Heap allocator. Pinocchio's default entrypoint includes an allocator. The port should NOT use `no_allocator!` because `sha2` and potentially Borsh-encoded args need transient heap (can be avoided with stack buffers, but Borsh decoding of `UpdateConfigArgs` with 13 Options is fiddly by hand). Start with the default entrypoint; consider switching later.
11. **Risk:** Unaudited framework. Per skill notes, Pinocchio 0.10 is unaudited. Raise this with Alan / note in the security checklist — 🔴 Critical program risk-level demands care.
12. **Risk / UNCLEAR:** Claim PDA seed uses `sha256(call_id)`. Pinocchio SBF target must verify `sha2` crate still compiles with `default-features = false`. Already a dependency, but double-check there's no `std` leak post-port.

---

## 9. Suggested Port Order

1. **Scaffolding** — new `program-v2/` crate with Pinocchio deps; stub `entrypoint`, `declare_id!`, empty discriminator match returning `Unsupported`. Build to confirm toolchain.
2. **`state.rs` + `error.rs`** — port all five account structs with explicit discriminators, LEN constants, read/write helpers. Port `PactError` with numeric-preserving `From<_>`.
3. **`initialize_protocol`** — pure PDA-create with no token plumbing. Smallest happy path; exercises CreateAccount + signer seeds + constant defaults. Port and get `protocol.ts` tests passing (requires IDL regen — see §10).
4. **`update_config`** — authority-gated partial updates; tests live in `protocol.ts` + `security-hardening.ts (H-03)`.
5. **`update_oracle`** — single-field write; tests in `security-hardening.ts (C-02)`.
6. **`create_pool`** — first token-account creation. Exercises System CreateAccount for data PDA + System CreateAccount for token account + SPL InitializeAccount3. Cover `pool.ts` tests.
7. **`update_rates`** — oracle-gated. Small. Cover `pool.ts` + `security-hardening.ts (H-04)`.
8. **`deposit`** — first SPL-Token user-signed transfer + init_if_needed branching. Cover `underwriter.ts`.
9. **`withdraw`** — first pool-PDA-signed CPI. Share signer-seed helper with future instructions.
10. **`enable_insurance`** — first token-account field reads (delegate, delegated_amount). Cover `policy.ts`.
11. **`disable_policy`** — trivial flag flip.
12. **`settle_premium`** — two CPIs via delegation + premium math. Cover `settlement.ts` + `security-hardening.ts (H-05 premium-evasion)`.
13. **`submit_claim`** — largest and most critical: `sha256` seed, window/cap math, claim PDA init, vault-to-agent transfer. Cover `claims.ts` + `security-hardening.ts (C-03, H-02, H-05)`.
14. **Full regression run** — all 42 tests green against Pinocchio.
15. **CU benchmarking** — record before/after; update PR description with numbers to justify deploy cost reduction claim.
16. **Deploy cost measurement** — `solana program deploy` to devnet, measure actual SOL cost, compare to 5.55 SOL baseline.

---

## 10. IDL & Client Regen Strategy

### 10.1 IDL
- **Tool:** Shank (annotations on the Pinocchio crate). Anchor IDL format is not interchangeable with Shank format.
- **Action:** add `#[derive(ShankAccount)]` to each state struct and `#[derive(ShankInstruction)]` plus `#[account(...)]` attrs on an instruction enum. Keep the instruction enum adjacent to the discriminator constants in `lib.rs`.
- **Generator command:** `shank idl -o idl.json -p packages/program/programs/pact-insurance/` (dev-time, not shipped).
- **Output format:** Metaplex-flavored Shank IDL JSON — NOT Anchor IDL. Anchor `new Program(idl, provider)` WILL NOT load it.

### 10.2 Client regen
- **Tool:** Codama (`@codama/nodes-from-shank`, `@codama/renderers-js-umi`). Codama consumes Shank IDL and generates a tree-shakeable TS client.
- **Consumer:** replace `packages/insurance/src/anchor-client.ts`'s Anchor `Program` with a Codama-generated instruction-builder module. Keep public class API in `client.ts` stable.
- **Impact on `@q3labs/pact-insurance` SDK:**
  - `createAnchorClient` exported helper → replace with `createInsuranceClient` returning `{ rpc, programAddress, deriveXPda, ... }`. Flag as a semver-major change OR keep the old name as a thin shim.
  - PDA derivation helpers (`derive*Pda`) — keep identical signatures; they do not depend on IDL.
  - `program.account.X.fetch` / `.all` calls inside `client.ts` → replace with Codama's decoder functions (e.g. `fetchPolicy(rpc, pda)`).
  - Account memcmp offsets (`listPolicies`) — MUST be validated against the new layout. If first-Pubkey-at-offset-8 invariant is preserved (§7.2), query stays correct with `offset: 8`.
- **Instruction encoding check:** Codama instruction builders must produce `[disc: 1 byte][borsh args]` matching the Pinocchio dispatcher. Validate on each instruction's first test.

### 10.3 Backend coupling
Backend (`packages/backend/**`) is out of scope but likely uses Anchor bindings the same way. A backend follow-up task must regen its Anchor dep to Codama too, or the claim-submission endpoint will fail.

### 10.4 Test harness
- Current tests use `anchor.workspace.PactInsurance` — that workspace autoload depends on `Anchor.toml` + `anchor build`. After the port, `anchor build` no longer produces this program.
- **Recommendation:** migrate tests to LiteSVM (Rust) or to a TS harness using the Codama client + `@solana/web3.js` directly. Per repo stack, TS+Codama+`solana-test-validator` keeps the 42-test matrix readable without a rewrite. All assertions remain valid — only the dispatch layer changes.

---

## Summary checklist for Alan (BLOCKERS marked)

- [ ] **BLOCKER** §8.1 — fixed-size vs variable `String` decision for `CoveragePool.provider_hostname` and `Policy.agent_id`.
- [ ] **BLOCKER** §8.5 — is program ID `2Go74...` deployed anywhere with non-test state? Determines migration vs fresh-deploy strategy.
- [ ] **BLOCKER** §6.1 / §8.4 — commit to preserving Anchor error codes 6000..=6030 (recommended) or accept SDK/backend string-match regressions.
- [ ] §8.2 — should `create_pool` start enforcing `usdc_mint == config.usdc_mint` during the port, or preserve the looser behavior?
- [ ] §8.3 — confirm cooldown-reset-on-every-deposit is intended.
- [ ] §10.4 — green-light migrating tests from Anchor-TS to Codama-TS (recommended) vs LiteSVM-Rust.
