# Phase 3 Security Hardening — Design Spec

**Date:** 2026-04-13
**Branch (planned):** `feature/phase3-security-hardening` (off `develop`, after PR #13 merges)
**Driving input:** Code review comment https://github.com/solder-build/pact-monitor/pull/13#issuecomment-4236655255
**Scope choice:** B — devnet merge-blockers + all Anchor mainnet-blocker findings
**C-02 variant:** A — minimal oracle/authority key split (single oracle keypair, distinct from admin authority; multisig deferred)

## Goal

Close every finding in the PR #13 review that blocks either (a) merging Phase 3 into `develop` or (b) running the program on mainnet with real TVL, with the single exception of full Ed25519 multisig for the oracle (deferred to a separate design cycle). Ship a fresh devnet deploy under a new program ID that passes smoke tests end-to-end.

## Non-goals

- Multisig oracle (C-02 option B) — separate future PR.
- H-01 withdraw-cooldown-reset — not in the "must-fix before mainnet" tier the reviewer called out as this PR's scope.
- M-04 (create_pool mint validation) and other medium-severity findings — follow-up.
- Formal verification (QEDGen invariants) — listed by reviewer as future work.
- Cloud Run / staging deploy operational steps — same as PR #13, handled separately after merge.

---

## Section 1 — Anchor program changes

### State additions (`state.rs`)

`ProtocolConfig` gains exactly one field:

```rust
pub struct ProtocolConfig {
    pub authority: Pubkey,
    pub oracle: Pubkey,       // NEW — claim-signing key, distinct from authority
    pub treasury: Pubkey,
    pub usdc_mint: Pubkey,
    // ... rest unchanged
}
```

`InitSpace` is re-derived automatically via `#[derive(InitSpace)]`. No other struct changes — `Policy.active` already exists (used by H-05), `Policy.expires_at` already exists (used by expiry checks).

### New instructions

**`update_oracle(new_oracle: Pubkey)`**
- Authority-gated (`has_one = authority`).
- Sets `config.oracle = new_oracle`.
- Enables key rotation without rebuilding the program.

**`disable_policy()`**
- Signed by the policy's agent (`has_one = agent`).
- Sets `policy.active = false`.
- Decrements `pool.active_policies`.
- Makes the policy permanently inert. A new one requires another `enable_insurance` call.
- Does NOT close the account (keeps historical trail intact).

### Instruction changes

**C-01 `initialize_protocol`**
- Add `deployer: Signer<'info>` account constrained by `address = crate::DEPLOYER_PUBKEY`.
- `DEPLOYER_PUBKEY` is a `pub const Pubkey` in `lib.rs` with a value baked in at compile time. The value is chosen and pasted into `lib.rs` before `anchor build`.
- `config.authority` and `config.oracle` both taken from `args`, but only after the deployer signer constraint has fired.
- Test: attempt to init with any other signer → `UnauthorizedDeployer`.

**C-02 `submit_claim`**
- Remove the old `authority: Signer` account.
- Add `oracle: Signer<'info>` constrained by `constraint = oracle.key() == config.oracle`.
- `has_one = authority` is removed from the `ProtocolConfig` account macro.
- The authority key is now completely uninvolved in the claim path.

**C-03 `submit_claim`**
- Add `constraint = agent_token_account.key() == policy.agent_token_account` to the `agent_token_account` account macro.
- Mirrors the pattern already at `settle_premium.rs:45`.

**H-02 `submit_claim`**
- Claim PDA seed changes from `args.call_id.as_bytes()` to `&hash(args.call_id.as_bytes()).to_bytes()` using `anchor_lang::solana_program::hash::hash`.
- Output is always exactly 32 bytes regardless of input length.
- Removes the 32-byte seed ceiling entirely. The hyphen-strip hack from yesterday's fix goes away — we pass the full canonical UUID (or any string up to `MAX_CALL_ID_LEN = 64`) and hash it.
- `Claim.call_id` storage retains the raw string for audit.
- Test: a 36-char UUID-with-hyphens must succeed (regression lock); a 64-char id must succeed (edge case).

**H-03 `update_config`**
- The `usdc_mint` and `treasury` fields become init-only. `update_config` no longer has branches for mutating them.
- Any attempt to pass non-default values for those fields → `FrozenConfigField`.
- Everything else (fee bps, coverage params, cooldowns, pause flag) stays mutable.

**H-04 `update_rates`**
- Add `require!(new_rate_bps <= 10_000, PactError::RateOutOfBounds)`.
- Add `require!(new_rate_bps >= pool.min_premium_bps, PactError::RateBelowFloor)`.
- Both checks happen before the mutation.

**H-05 `settle_premium` and `submit_claim`**
- Both add, at the top:
  ```rust
  require!(policy.active, PactError::PolicyInactive);
  let clock = Clock::get()?;
  require!(clock.unix_timestamp < policy.expires_at, PactError::PolicyExpired);
  ```
- `disable_policy` instruction (see above) is how an agent exits.

### Error enum additions (`error.rs`)

```rust
pub enum PactError {
    // ... existing
    UnauthorizedDeployer,
    UnauthorizedOracle,
    RateOutOfBounds,
    RateBelowFloor,
    PolicyInactive,
    PolicyExpired,
    FrozenConfigField,
}
```

### Files touched

| File | Change |
|---|---|
| `state.rs` | `oracle: Pubkey` field on `ProtocolConfig` |
| `lib.rs` | `DEPLOYER_PUBKEY` const + `update_oracle` + `disable_policy` entry points |
| `instructions/initialize_protocol.rs` | Deployer signer constraint |
| `instructions/submit_claim.rs` | Oracle signer, hashed seed, expiry/active checks, agent_token_account constraint |
| `instructions/settle_premium.rs` | Expiry + active checks |
| `instructions/update_config.rs` | Drop treasury/usdc_mint mutation branches |
| `instructions/update_rates.rs` | Bounds checks |
| `instructions/update_oracle.rs` | **NEW** |
| `instructions/disable_policy.rs` | **NEW** |
| `instructions/mod.rs` | Re-exports for the two new modules |
| `error.rs` | Seven new variants |

---

## Section 2 — Backend + SDK changes

### The 3 merge-blocker fixes

**`routes/claims-submit.ts:38`**
- Change `NULL::text AS agent_pubkey` to `cr.agent_pubkey`. The column exists (added in PR #13 migration).

**`routes/claims-submit.ts` registration**
- Add `{ preHandler: requireApiKey }` to the route options.
- Inside the handler, compare `request.agentId === row.agent_id`. Mismatch → 403.
- Closes the "anyone on the internet can trigger oracle-signed txs" hole.

**`routes/records.ts:75`**
- Stop reading `rec.agent_pubkey` from the request body.
- Read `request.agentPubkey` (decorated by middleware, see below) instead.
- Drop `agent_pubkey` from the SDK record payload wire type entirely.

### `api_keys` schema migration

```sql
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS agent_pubkey TEXT;
CREATE INDEX IF NOT EXISTS api_keys_agent_pubkey_idx ON api_keys(agent_pubkey);
```

- `auth.ts` middleware decorates `request.agentPubkey` alongside `request.agentId`.
- `generate-key` CLI accepts `--agent-pubkey <base58>` arg. Optional: if missing, the key authenticates records but `maybeCreateClaim` will skip on-chain submission (no pubkey → no policy lookup).

### Program-change ripple effects

**`services/claim-settlement.ts`**
1. Replace raw `.as_bytes()` seed derivation with sha256 hash to match H-02. Use `@noble/hashes/sha256` (already a transitive dep via Solana web3.js; verify before adding).
2. The `onChainCallId` hyphen-strip hack from yesterday's fix is removed. Pass the full canonical UUID to both the PDA derivation and the `callId` instruction arg; hashing happens inside the PDA derive only.
3. Submit_claim signer changes from `authority` to `oracle`. The keypair file path loaded here stays configurable via env; only the env-var name changes for clarity (`PACT_ORACLE_KEYPAIR`).
4. Module-scope memoization for the oracle keypair load — currently loaded twice per claim. Load once at module init; export as a cached reference.

**`config.ts` / env vars**
- `PACT_PROGRAM_ID` → new program ID post-redeploy.
- `PACT_ORACLE_KEYPAIR` → path to the new oracle keypair file.
- (No `PACT_AUTHORITY_KEYPAIR` introduced in this PR — authority key stays wherever it currently lives since this PR does not exercise admin-only instructions beyond `init_protocol`. Future PR can split further.)

**`routes/pools.ts`**
- Wrap `getSolanaConfig()` in a try/catch; return 503 with a sanitized `{ error: "Solana configuration unavailable" }` on missing env. Log the full cause server-side.
- Add 30-second in-memory cache for the `getProgramAccounts` result. Simple `{ cachedAt, data }` module-scope map keyed by cluster + program ID.

**Error message sanitization**
- `pools.ts:40,102` and `claims-submit.ts:99` stop echoing raw `err.message` to clients.
- Server-side: full error logged via `request.log.error({ err }, "...")` with a correlation ID (Fastify request ID).
- Client-side: generic `{ error: "...", correlationId }`.

### SDK changes (`packages/sdk`)

**`types.ts`**
- Remove `agent_pubkey` from the outgoing record payload wire type.
- Keep `PactConfig.agentPubkey` — it's used for *local* policy lookups by the SDK's insurance client, not for claiming identity on the wire.

**`wrapper.ts`**
- If `syncEnabled && apiKey` is true but `agentPubkey` is empty at construction time, emit `console.warn` once: `[pact-monitor] agentPubkey missing — on-chain claims will not be submitted for this agent.`

**`insurance` client (`PactInsurance.submitClaim`)**
- Once the route is authenticated, add `Authorization: Bearer <apiKey>` header to the request. Follows the same pattern the records client already uses.

### Tests added

*Backend (~8):*
- `auth.ts` middleware decorates `request.agentPubkey` from the api_keys column.
- `POST /api/v1/records` — client-supplied `agent_pubkey` in body is ignored; stored value comes from API-key binding.
- `POST /api/v1/claims/submit` without Authorization header → 401.
- `POST /api/v1/claims/submit` with mismatched api_key / call_record.agent_id → 403.
- `POST /api/v1/claims/submit` happy path → 200, DB row updated.
- `generate-key` CLI accepts `--agent-pubkey` arg and writes it to the row.
- `pools.ts` returns 503 (not 500) when Solana env is missing.
- `pools.ts` cache returns second request within 30s from memory (no second RPC call).

*Claim-settlement service (~2):*
- Keypair memoization: module-scope load count stays at 1 after N claims.
- PDA derivation uses sha256 of call_id, matching the program seed.

*SDK (~3):*
- Record payload wire type excludes `agent_pubkey`.
- `PactMonitor` ctor with `syncEnabled + apiKey + empty agentPubkey` emits `console.warn`.
- `PactInsurance.submitClaim()` sends `Authorization: Bearer <apiKey>` header.

---

## Section 3 — Deployment / migration plan

### Deploy sequence (devnet)

1. **Branch off `develop` AFTER PR #13 merges.** New branch: `feature/phase3-security-hardening`.
2. **Program build + test locally.** `cargo test` → `anchor test` with local validator. Existing tests must pass after state-field addition. New tests written during this phase.
3. **Generate a fresh oracle keypair.** `solana-keygen new -o oracle-v2.json`. Becomes the new on-chain oracle.
4. **Decide and bake `DEPLOYER_PUBKEY`.** Paste the chosen pubkey's base58 into `lib.rs` as a `pub const`. Commit. Build. Deploy. The pubkey is chosen and communicated by the engineer executing the plan (Alan).
5. **Anchor deploy to devnet → capture new program ID.** `anchor deploy --provider.cluster devnet`. Copy the new program ID into `Anchor.toml`, `lib.rs` (`declare_id!`), and `packages/backend/.env` (`PACT_PROGRAM_ID`). Rebuild once so `declare_id!` matches its deploy slot. (Anchor 1.0 quirk.)
6. **Re-init protocol.** Run `scripts/init-protocol.ts` with deployer signing and the new oracle pubkey + authority pubkey + treasury ATA in args.
7. **Re-seed pools.** `scripts/seed-devnet-pools.ts` — same 5 hostnames, same 100 USDC each. Pools end up at new PDAs (pool seeds derive through the program ID).
8. **Backend env update + restart.** New `PACT_PROGRAM_ID`, new `PACT_ORACLE_KEYPAIR` path.
9. **Smoke test.** Run in order: `trigger-claim-demo.ts`, `trigger-premium-demo.ts`, `samples/demo/insured-agent.ts`. All three must land successfully against the new program ID.
10. **Scorecard.** Loads via `/api/v1/pools` — no frontend change needed.

### State inventory after redeploy

| Artifact | Status |
|---|---|
| Old program ID deployment | Still on devnet, orphaned (backend no longer points at it) |
| Old `ProtocolConfig`, pools, policies, deposits, claims | Stranded on-chain at old PDAs, not readable via new backend |
| DB `call_records` and `claims` rows | Preserved. Historical aggregates still render correctly on scorecard. |
| DB `policies` rows | Preserved but reference old pool PDAs. Consider `DELETE FROM policies WHERE created_at < '<redeploy ts>'` if listings look confusing. Not required. |

### Rollback

- **Forward-fix preferred.** Program is Anchor-upgradeable; broken post-deploy → `anchor upgrade` with a patched .so.
- **Env flip fallback.** Set `PACT_PROGRAM_ID` back to the old ID in backend env; the old program still has its pools and state intact, so the pre-PR demo flow resumes.
- **Git rollback.** `git revert` the PR. DB schema changes are additive (`api_keys.agent_pubkey` column) — NULL doesn't break anything.

### Staging / Cloud Run

Out of scope for this PR. Operational deploy (GitHub Actions secrets, `CRANK_ENABLED` flag, `VITE_API_URL` rebuild) happens separately once this PR lands on `develop`, same model as PR #13.

---

## Section 4 — Testing strategy, acceptance criteria, task sizing

### Test matrix — Anchor program (`anchor test`)

**Regression baseline:**
- Every existing program test passes after the state-field addition.

**C-01:**
- `initialize_protocol` with wrong signer → `UnauthorizedDeployer`.
- `initialize_protocol` with correct deployer → `config.oracle` and `config.authority` both populated from args.

**C-02:**
- `update_oracle` happy path → oracle rotates.
- `update_oracle` with non-authority signer → authority constraint failure.
- `submit_claim` with wrong oracle → `UnauthorizedOracle`.
- `submit_claim` with correct oracle → happy path.

**C-03:**
- `submit_claim` with `agent_token_account` ≠ `policy.agent_token_account` → constraint failure.

**H-02:**
- `submit_claim` with a 36-char UUID-with-hyphens → succeeds (regression lock).
- `submit_claim` with a 64-char call_id → succeeds (edge case).

**H-03:**
- `update_config` attempting `usdc_mint` mutation → `FrozenConfigField`.
- `update_config` attempting `treasury` mutation → `FrozenConfigField`.

**H-04:**
- `update_rates` with `new_rate_bps = 10_001` → `RateOutOfBounds`.
- `update_rates` with `new_rate_bps < pool.min_premium_bps` → `RateBelowFloor`.

**H-05:**
- `disable_policy` happy path → policy.active false, pool.active_policies decremented.
- `submit_claim` after `disable_policy` → `PolicyInactive`.
- `submit_claim` past `expires_at` → `PolicyExpired`.
- `settle_premium` past `expires_at` → `PolicyExpired`.

### Test matrix — Backend + SDK

Covered in Section 2 "Tests added" block. Total: ~13 new tests across backend, claim-settlement service, and SDK.

### Acceptance criteria

The PR is ready to merge when ALL of the following are true:

1. Full test suite green across `program`, `backend`, `sdk`, and `scorecard` packages.
2. `trigger-claim-demo.ts` runs end-to-end against the redeployed devnet program and produces a settled claim row in the DB.
3. `trigger-premium-demo.ts` runs end-to-end, advances the watermark, and records a premium settlement.
4. `samples/demo/insured-agent.ts` runs end-to-end against the new program ID — creates a fresh agent, executes success + failure calls, and receives a refund on-chain.
5. Scorecard UI loads successfully against the redeployed pools (via `/api/v1/pools`).
6. `docs/PHASE3-SECURITY-HARDENING.md` written, listing each reviewer finding with the commit SHA that addresses it, documenting the new oracle/authority key split, and linking to reviewer comment #4236655255.

### Task breakdown

| # | Task | Size |
|---|---|---|
| 1 | Backend merge-blocker pack: `claims-submit.ts` SELECT fix, auth preHandler, `records.ts` agent_pubkey binding, `api_keys` migration, `generate-key` CLI arg, `auth.ts` middleware decorator | S |
| 2 | Backend should-fix pack: oracle keypair memoization, `pools.ts` cache + 503 env guard, error message sanitization | S |
| 3 | SDK wire-type cleanup + wrapper warn + insurance client auth header + tests | S |
| 4 | Program state change: add `oracle: Pubkey` to `ProtocolConfig` | XS |
| 5 | Program C-01: deployer const + `initialize_protocol` signer constraint + tests | S |
| 6 | Program C-02: `update_oracle` ix + `submit_claim` oracle signer swap + tests | M |
| 7 | Program C-03: `submit_claim` agent_token_account constraint + test | XS |
| 8 | Program H-02: hashed call_id seed + backend mirror in `claim-settlement.ts` + tests (program + backend) | S |
| 9 | Program H-03: `update_config` frozen fields + tests | XS |
| 10 | Program H-04: `update_rates` bounds + tests | XS |
| 11 | Program H-05: `disable_policy` ix + expiry/active checks in `submit_claim` and `settle_premium` + tests | M |
| 12 | Devnet redeploy ceremony: new keypairs, deploy, re-init, re-seed, backend env update, smoke test | M |
| 13 | `docs/PHASE3-SECURITY-HARDENING.md` + PR description with findings → commits map | XS |

**Total:** 13 tasks. 4×XS, 5×S, 3×M. Estimated wall-clock at subagent-driven pace: roughly one full day.

**Execution order:** 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12 → 13. Tasks 4–11 (program changes) must precede Task 12 (devnet redeploy). Tasks 1–3 (backend/SDK) are independent of program state and could technically run in parallel with 4–11, but serial is simpler and the full sequence fits in one day anyway.

---

## Findings coverage matrix

Cross-reference between the reviewer's PR #13 findings and where each one lands in this spec.

| Finding | Severity | Covered by task(s) |
|---|---|---|
| #1 `claims-submit.ts:38` DOA | Must-fix before merge | Task 1 |
| #2 `claims-submit.ts` no auth | Must-fix before merge | Task 1 |
| #3 `records.ts:75` untrusted `agent_pubkey` | Must-fix before merge | Task 1 |
| C-01 `initialize_protocol` ownership | Critical / mainnet blocker | Task 5 |
| C-02 `submit_claim` single-key oracle | Critical / mainnet blocker | Task 6 (option A — single-key split only) |
| C-03 `submit_claim` refund destination | Critical / mainnet blocker | Task 7 |
| H-02 `call_id` PDA seed length | High / mainnet blocker | Task 8 |
| H-03 `update_config` swap vectors | High / mainnet blocker | Task 9 |
| H-04 `update_rates` unbounded | High / mainnet blocker | Task 10 |
| H-05 policy disable/expiry | High / mainnet blocker | Task 11 |
| premium-settler watermark on zero-calls | Should-fix | Task 2 |
| `claim-settlement.ts` keypair re-load | Should-fix | Task 2 |
| `claim-settlement.ts` unvalidated PublicKey | Should-fix | Task 1 (handled at `records.ts` insert boundary) |
| `pools.ts` + `claims-submit.ts` raw error leak | Should-fix | Task 2 |
| `wrapper.ts:23` silent empty agentPubkey | Should-fix | Task 3 |
| demo-breaker: CORS | Demo-watch | (monitored during Task 12 smoke test; no code change unless it breaks) |
| demo-breaker: `pools.ts` 500 on missing env | Demo-watch | Task 2 |
| demo-breaker: `pools.ts` RPC rate limit | Demo-watch | Task 2 |
| H-01 withdraw cooldown reset | Mainnet / not in scope | Deferred (follow-up PR) |
| M-04 create_pool mint validation | Medium / not in scope | Deferred (follow-up PR) |
| C-02 multisig oracle | Critical / full fix | Deferred (separate design + PR) |
| QEDGen formal verification | Future | Deferred |
