# Phase 3 Security Hardening — Audit Trail

**Date:** 2026-04-14
**Driving review:** https://github.com/solder-build/pact-monitor/pull/13#issuecomment-4236655255
**Branch:** `feature/phase3-security-hardening`
**Status:** PR #19 merged (backend + SDK); PR #20 open pending merge (Anchor program hardening + devnet redeploy)

---

## Summary

The Phase 3 review of PR #13 surfaced 3 backend findings that blocked merging, 6 Anchor program findings that block mainnet deployment, and several should-fix items across error handling, key management, and SDK hygiene. This document is the combined audit trail for both PRs that address everything.

PR #19 addressed all backend and SDK findings: binding `agent_pubkey` to API keys in the auth layer so client-supplied values cannot be spoofed, gating the claims-submit route behind `requireApiKey`, fixing a dead `NULL::text AS agent_pubkey` SELECT, and stripping `agent_pubkey` from the outgoing record wire type. PR #20 addresses all Anchor program mainnet blockers: the oracle/authority split (C-02), deployer-binding on `initialize_protocol` (C-01), locking the refund ATA to the policy's registered account (C-03), hashing the call_id PDA seed to remove the 32-byte ceiling (H-02), freezing `usdc_mint` and `treasury` post-init (H-03), bounding `update_rates` (H-04), and adding policy expiry and disable semantics (H-05). After the program hardening, a fresh devnet deploy was executed under a new program ID and smoke-tested end-to-end. Additional issues caught during live smoke testing — SDK flush re-entrancy, record idempotency, and demo script correctness — were fixed in the same PR as defense-in-depth.

---

## Key architectural change: oracle/authority split

### Before

`ProtocolConfig` stored one `authority: Pubkey`. The same key was used for both administrative operations (`update_config`, `update_rates`, key rotation) and claim submission (`submit_claim`). A compromise of the authority keypair — or any operator who had legitimate access to it — could fabricate claims against any pool and drain it via the oracle-signed transfer path.

### After

`ProtocolConfig` now stores two distinct keys:

```
authority: Pubkey   — admin operations only
oracle: Pubkey      — claim signing only (submit_claim)
```

`submit_claim` no longer accepts `authority` as a signer. It requires `oracle: Signer` constrained by `oracle.key() == config.oracle`. The authority key cannot submit claims. The oracle key cannot change protocol configuration. A new `update_oracle` instruction (authority-gated) enables key rotation without redeployment.

### Option A vs Option B

This PR ships **option A**: minimal single-key split. Two distinct keypairs, one oracle, no on-chain threshold logic. This eliminates the critical single-point-of-failure without introducing the complexity of Ed25519 precompile multisig verification.

**Option B** (deferred): full multisig oracle via Ed25519 precompile, requiring M-of-N oracle signatures before a claim passes. This is the correct architecture for any program holding real TVL on mainnet. See the Deferred Items section.

---

## New devnet program ID + redeploy state

The Anchor program was rebuilt with all hardening changes applied and deployed to devnet as a new program ID. The old program ID is orphaned on devnet (state intact but backend no longer points at it; can be closed with `solana program close` to recover approximately 3 SOL).

| Item | Value |
|---|---|
| Old program ID (orphaned) | `4Z1Y3W49U2Cn6bz9UpkahVP7LaeobQ4cAaEt3uNaqSob` |
| **New program ID** | **`2Go74eCvY8vCco3WPuteGzrhKz8v3R7Pcp5tjuFpcmN3`** |
| New ProtocolConfig PDA | `EDoHJLmyMx3nuBeKLssf9JppQAXJ1zKp7ZNJKVc8eGKt` |
| Authority (admin key) | `5XyGGyazg6rGJU3Hjkrx1PDM1rBE3FraRnMauSR46rW1` |
| Oracle (claim signer) | `JD3LFkN3QSMeYDuyFFTFRVKq2N5fg8nEjMj7M3g5pp23` |
| Test USDC mint | `5vcEdU8fBksfRH42wrebUV6dNEENPbdaBtAmw79ZNuSE` |
| Pools seeded | helius, quiknode, jupiter, coingecko, dexscreener — 100 USDC each |

The authority and oracle are distinct keys as required by the C-02 fix. The authority keypair is the Phantom-style admin key baked in as `DEPLOYER_PUBKEY` at compile time (C-01 fix).

### H-03 / USDC mint operational gotcha

The H-03 fix freezes `usdc_mint` and `treasury` as init-only fields in `ProtocolConfig`. This broke the previous devnet bootstrap workflow, which called `update_config` after initialization to swap in a Phantom-controlled test mint.

**New workflow:** the test USDC mint must be created BEFORE `initialize_protocol` is called and its address must be baked into `init-devnet.ts` directly. A one-off script `packages/program/scripts/create-test-mint.mjs` was added that creates a stable Phantom-owned mint. Anyone re-running the devnet bootstrap must run `create-test-mint.mjs` first and update `init-devnet.ts` with the resulting mint address before calling init. The runtime mint swap via `update_config` is no longer possible.

---

## Findings map

### Backend must-fix findings (PR #19)

| # | Finding | What changed | Commit | GitHub issue |
|---|---|---|---|---|
| B-1 | `claims-submit.ts:38` SELECT always returned `NULL` for `agent_pubkey` — the ownership check that followed was dead code | Changed `NULL::text AS agent_pubkey` to `cr.agent_pubkey` in the SELECT; added `preHandler: requireApiKey` to the route registration | `b696133` | — |
| B-2 | `claims-submit.ts` had no auth — any unauthenticated caller could trigger oracle-signed on-chain transactions | Added `preHandler: requireApiKey` + agent ownership assertion (`request.agentId === row.agent_id`); mismatched caller gets 403 | `b696133` | — |
| B-3 | `records.ts:75` accepted `agent_pubkey` from the request body — a caller could submit records attributed to any on-chain identity | `records.ts` now reads `request.agentPubkey` (decorated by auth middleware from the `api_keys` row) and ignores any client-supplied value; `agent_pubkey` removed from the SDK outgoing wire type entirely | `d024b99`, `0822dc6`, `1fa9b6b` | — |

Additional backend hardening in PR #19:

| Description | Commit |
|---|---|
| `generate-key` CLI `--agent-pubkey` flag — binds a Solana pubkey to an API key at provisioning time; without it `maybeCreateClaim` skips on-chain submission | `7610397`, `1ef8416` |
| BONUS: cross-provider evidence substitution — reviewer caught that `claims-submit.ts` did not verify `providerHostname` matches the call record, allowing an attacker to use a legitimate call record from provider A as evidence for a claim against provider B | `9501ffd` |
| Oracle keypair cached at module scope — was re-loaded from disk on every claim | `c67c45c` |
| `pools.ts` 30-second in-memory cache; 503 response (not 500) when Solana env is missing; sanitized error messages to clients; cache key scoped to programId+rpcUrl | `1d586a0`, `1604202` |
| Validate oracle keypair file content and `USDC_MINT` presence at startup | `64a8002` |
| `pools.ts` test uses `try/finally` for env + handle cleanup | `ef53a5f` |
| `pools.ts` cache test exercises the 502 RPC error path | `4ba99f4` |
| SDK `PactMonitor` constructor warns when `syncEnabled` and `apiKey` are set but `agentPubkey` is empty | `138b494` |
| Insurance client sends `Authorization: Bearer <apiKey>` header in `submitClaim` | `f67c5eb` |
| Insurance client trims `apiKey` and uses `globalThis.fetch` | `77ad617` |
| Backend cleanup from code review | `53569f4`, `fc39176` |

---

### Anchor program mainnet-blocker findings (PR #20)

| Finding | Severity | Description | Fix | Commit(s) | GitHub issue |
|---|---|---|---|---|---|
| C-01 | Critical | `initialize_protocol` was permissionless — any caller could become protocol owner before the legitimate deployer, taking control of all admin instructions | Added `DEPLOYER_PUBKEY` constant baked at compile time; `initialize_protocol` requires a `deployer: Signer` with `address = crate::DEPLOYER_PUBKEY`; any other signer returns `UnauthorizedDeployer` | `820ddc5`, `31477e2` | #15 |
| C-02 | Critical | `submit_claim` required the `authority` signer — same key used for admin operations. A compromised authority could fabricate claims against any pool and drain it | Introduced `oracle: Pubkey` field on `ProtocolConfig`; `submit_claim` now requires `oracle: Signer` constrained by `oracle.key() == config.oracle`; authority is completely uninvolved in the claim path; new `update_oracle(new_oracle: Pubkey)` instruction for key rotation | `8bf6993`, `ff742ed`, `e797680` | #14 |
| C-03 | Critical | `submit_claim` accepted a caller-supplied `agent_token_account` — an attacker could redirect the refund transfer to an account they control | Added `constraint = agent_token_account.key() == policy.agent_token_account` to the account macro; mirrors the existing pattern in `settle_premium.rs` | `ac18847` | #16 |
| H-02 | High | Claim PDA seed used `args.call_id.as_bytes()` directly — any call_id exceeding 32 bytes silently broke the PDA derivation, permanently preventing the claim from being submitted | Seed now uses `sha256(call_id.as_bytes())` — always exactly 32 bytes; backend `claim-settlement.ts` mirrors with `@noble/hashes/sha256`; raw string preserved in `Claim.call_id` for audit; backend byte-equality lock-in test added | `37cc2ec`, `931e1a2` | #17 |
| H-03 | High | `update_config` allowed mutating `usdc_mint` and `treasury` post-initialization — an attacker with authority access could redirect all premium and payout flows to attacker-controlled accounts | Both fields are now init-only; any attempt to pass non-default values via `update_config` returns `FrozenConfigField`; operational consequence documented above | `c40d8d0` | #18 (part 1) |
| H-04 | High | `update_rates` had no upper or lower bounds — authority could set a rate above 100% (10 000 bps) or below the pool's configured minimum, making the insurance economically incoherent | Added `require!(new_rate_bps <= 10_000)` and `require!(new_rate_bps >= pool.min_premium_bps)`; errors are `RateOutOfBounds` and `RateBelowFloor` | `f1b5beb` | #18 (part 2) |
| H-05 | High | No policy expiry or disable path — policies were effectively immortal; a policy belonging to a defunct agent continued to accumulate active_policies count and could be used to submit or settle indefinitely | Added `require!(policy.active)` and `require!(clock.unix_timestamp < policy.expires_at)` at the top of both `submit_claim` and `settle_premium`; new `disable_policy` instruction lets an agent permanently deactivate a policy (sets `active = false`, decrements `active_policies`); `enable_insurance` rejects past `expires_at`; account not closed to preserve historical trail | `a8b2e1f`, `08ee6d1` | #18 (part 3) |

---

### Fixes discovered during devnet smoke testing (PR #20, post-redeploy)

| Description | Detail | Commit |
|---|---|---|
| Demo scripts passed a past `expires_at` to `enable_insurance` | The H-05 fix made `enable_insurance` reject past timestamps; existing demo scripts hadn't been updated | `2189ada` |
| Demo scripts weren't binding `agent_pubkey` on api_keys insert; provider name used `hostname.split(".")[0]` which collapsed all providers to "api" | `maybeCreateClaim` was early-returning because `agent_pubkey` was null; duplicate "api"-named providers were being created instead of using the full hostname | `2a0ac6e`, `70cc238` |
| Idempotency: 1 failed call produced 12 settled claims during demo | Two compounding bugs: (1) `PactSync.flush()` had no in-flight guard — concurrent flushes (interval + shutdown + manual) double-posted records; (2) backend had no uniqueness constraint on `(agent_pubkey, timestamp, endpoint)`, so each duplicate POST created a fresh `call_records` UUID which hashed to a distinct claim PDA on-chain. Fix: SDK gets `flushInFlight` Promise guard; backend schema gets a partial unique index on `call_records`; backend records route uses `ON CONFLICT DO NOTHING` | `367adf6` |
| Admin endpoint for key provisioning; pg-free insured-agent demo | New `POST /api/v1/admin/keys` endpoint gated by `ADMIN_TOKEN`; `samples/demo/insured-agent.ts` no longer imports `pg` directly — demo is now a pure HTTP/SDK consumer matching the real production agent flow | `1df38f6` |
| Remaining demo scripts (`trigger-claim-demo`, `trigger-premium-demo`) still opened direct Postgres connections | Both scripts now use the admin HTTP endpoint and on-chain pool deltas for verification | `a8146b1` |
| SDK live integration tests | 5 new test cases in `packages/sdk/src/integration.test.ts`: happy path, bad path, golden rule (x2), idempotency regression lock; tests skip cleanly if the local stack is unreachable | `2081db2` |

---

## Test coverage

| Suite | Command | Result |
|---|---|---|
| Anchor program | `anchor test` in `packages/program` | 40/40 passing (1 skipped — see note below) |
| Backend | `npm test` in `packages/backend` | 46/46 passing |
| SDK | `npm test` in `packages/sdk` | 41/41 passing (36 unit + 5 integration) |
| Insurance package | `npm test` in `packages/insurance` | 3/3 passing |

**Skipped program test:** The C-01 deployer constraint test requires building with `--features enforce-deployer` and the baked `DEPLOYER_PUBKEY` matching the signing wallet. It cannot run in the default `anchor test` invocation without those conditions. The test is present in the suite and documents the runtime invariant; it was manually verified at the time of devnet deploy.

**End-to-end smoke test (manual, devnet):** `samples/demo/insured-agent.ts api.coingecko.com` — 3 success calls + 1 failure call produced exactly 1 submitted and settled claim, with 1 USDC refund received by the agent. Agent USDC balance moved from 20 to 21 USDC on-chain.

---

## Deferred items

These findings are known and acknowledged. None block the current PR from merging. Each should be filed as a follow-up issue before mainnet launch with real TVL.

- **C-02 option B — multisig oracle:** This PR ships option A (single oracle keypair distinct from authority). Before any program deployment holding real TVL, the oracle path should be upgraded to M-of-N Ed25519 precompile verification so no single compromised keypair can authorize claims. This is a separate design cycle.

- **H-01 — withdraw cooldown reset on top-up:** The reviewer flagged that depositing additional funds resets the withdrawal cooldown timer, which could be exploited to prevent liquidity withdrawal indefinitely. Not in the must-fix tier for this PR.

- **M-04 — `create_pool` does not validate `usdc_mint == config.usdc_mint`:** A pool could be initialized with a different mint than the protocol's registered USDC mint. Medium severity.

- **QEDGen formal verification:** Conservation invariants (vault balance == `pool.total_available` + in-flight claims, etc.) are not formally verified. The reviewer noted this as future work.

---

## For mainnet (next steps)

The following steps are required to take this program from devnet-ready to mainnet-ready. None of them are code changes in this PR — they are operational decisions and deployment steps.

1. **Deploy with `--features enforce-deployer`** and ensure `DEPLOYER_PUBKEY` in `lib.rs` matches the keypair that will sign `initialize_protocol`. Verify the skipped C-01 test passes against the deployed binary before calling init.

2. **Use a real, distinct oracle keypair — consider HSM or multisig.** The devnet oracle (`JD3LFkN3QSMeYDuyFFTFRVKq2N5fg8nEjMj7M3g5pp23`) is a file-based keypair acceptable for testing. For mainnet, the oracle keypair should be stored in a hardware security module or replaced entirely with option B (multisig) before TVL accumulates.

3. **Generate a real mainnet treasury.** The devnet treasury is a Phantom-controlled ATA. Mainnet treasury should be a multisig-controlled account with explicit withdrawal governance.

4. **Swap the USDC mint for mainnet USDC.** Replace the test mint (`5vcEdU8fBksfRH42wrebUV6dNEENPbdaBtAmw79ZNuSE`) with the mainnet USDC mint (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`) in `init-devnet.ts` (or its mainnet equivalent). Per H-03, this cannot be changed after `initialize_protocol` is called — get it right before init.

5. **Tighten `aggregate_cap_bps`.** Review the configured aggregate cap relative to expected TVL before opening the program to real user deposits.

6. **Close C-02 option B before TVL.** File and complete the multisig oracle PR before accepting any user-facing deposits. See Deferred Items above.

7. **Audit M-04** (`create_pool` mint validation) — the medium-severity finding that pools can be initialized with an arbitrary mint should be closed before open pool creation is enabled.

8. **Recover the orphaned old program ID.** `solana program close 4Z1Y3W49U2Cn6bz9UpkahVP7LaeobQ4cAaEt3uNaqSob` recovers approximately 3 SOL in rent. The old program has no active users and its state is stranded.

---

## Full commit reference

### PR #19 (merged) — backend + SDK

| Commit | Description |
|---|---|
| `0822dc6` | feat(backend): bind agent_pubkey to api_key in auth middleware |
| `d024b99` | fix(backend): bind agent_pubkey to api_key, ignore client body value |
| `b696133` | fix(backend): authenticate claims/submit and fix agent_pubkey SELECT |
| `7610397` | feat(backend): generate-key --agent-pubkey flag binds key to on-chain pubkey |
| `9501ffd` | fix(backend): verify providerHostname matches call record in claims/submit |
| `1ef8416` | fix(backend): generate-key errors if --agent-pubkey has no value |
| `53569f4` | chore(backend): cleanup from code review |
| `fc39176` | chore(backend): hoist agentLabel above INSERT in agent_pubkey binding test |
| `c67c45c` | perf(backend): cache oracle keypair at module scope |
| `1d586a0` | fix(backend): pools.ts 30s cache, 503 on missing env, sanitized errors |
| `ef53a5f` | test(backend): use try/finally for env+handle cleanup in pools tests |
| `1604202` | fix(backend): scope pools cache key to programId+rpcUrl |
| `64a8002` | fix(backend): validate oracle keypair file content + USDC_MINT presence |
| `4ba99f4` | test(backend): pools cache test now exercises 502 RPC error path |
| `1fa9b6b` | fix(sdk): remove agent_pubkey from outgoing record wire shape |
| `138b494` | feat(sdk): warn at construction when insurance config is incomplete |
| `f67c5eb` | feat(insurance): send Authorization header in submitClaim |
| `77ad617` | fix(insurance): trim apiKey and use globalThis.fetch in submitClaim |

### PR #20 (open) — Anchor program hardening + devnet redeploy + smoke-test fixes

| Commit | Description |
|---|---|
| `820ddc5` | feat(program): add oracle: Pubkey field to ProtocolConfig |
| `31477e2` | feat(program): C-01 deployer binding + explicit oracle init arg (closes #15) |
| `8bf6993` | feat(program): C-02 oracle/authority split + update_oracle ix (closes #14) |
| `ff742ed` | test(program): tighten C-02 wrong-oracle test to assert UnauthorizedOracle |
| `e797680` | test(program): tighten C-02 non-authority test regex to assert Unauthorized |
| `ac18847` | fix(program): C-03 lock submit_claim refund ATA to policy.agent_token_account (closes #16) |
| `37cc2ec` | fix(program,backend): H-02 hash call_id for PDA seed, drop 32-byte cap (closes #17) |
| `931e1a2` | test(backend): byte-equality lock for 64-char H-02 boundary case |
| `c40d8d0` | fix(program): H-03 freeze treasury and usdc_mint post-init (closes #18 part 1) |
| `f1b5beb` | fix(program): H-04 bound update_rates to [min_premium_bps, 10000] (closes #18 part 2) |
| `a8b2e1f` | feat(program): H-05 policy expiry/active checks + disable_policy ix (closes #18 part 3) |
| `08ee6d1` | fix(program): H-05 reject past expires_at on enable_insurance + test settle disabled path |
| `50721c6` | chore(program,backend): Task 12 devnet redeploy under hardened program ID |
| `2189ada` | fix(scripts,samples): pass future expires_at to enable_insurance |
| `2a0ac6e` | fix(scripts,samples): bind agent_pubkey on demo api_keys + use full hostname as provider name |
| `367adf6` | fix(sdk,backend): idempotent record ingestion (SDK flush re-entrancy + DB unique index) |
| `70cc238` | chore(scripts,samples): stop pre-inserting providers; rely on findOrCreateProvider |
| `1df38f6` | feat(backend,samples): admin endpoint for key provisioning + pg-free insured-agent demo |
| `a8146b1` | chore(scripts): remove pg from trigger-claim-demo and trigger-premium-demo |
| `2081db2` | test(sdk): live integration tests against local backend |
