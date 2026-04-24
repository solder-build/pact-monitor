# Pinocchio Port — Execution Plan

Companion to [`docs/pinocchio-migration-spec.md`](./pinocchio-migration-spec.md).
The recon spec is the **source of truth** for account layouts, CPI signer-seeds, discriminator assignment, error-code preservation and the cut-over mechanics. This document only says **in what order we ship PRs, what each PR's exit bar is, and who can run in parallel**. Do not duplicate the spec's contents — always reference sections (e.g. "see spec §3.6").

## Binding constraints (Alan — locked)

These are repeated at the top of every per-WP spawn prompt in Section C. Violating any of them is a spec violation:

1. **Fixed-size strings.** `CoveragePool.provider_hostname` and `Policy.agent_id` are `[u8; 64]` on-disk (not Borsh `String`). Use bytemuck zero-copy. *(Note: spec §2.2 mentions 128 bytes for hostname; Alan's decision is 64 — Section G documents this so we flag it before WP-2 starts.)*
2. **No state migration.** Only devnet is deployed; no mainnet state. Layout is fresh; devnet is wiped and redeployed post-port. Do NOT write a migration instruction.
3. **Preserve Anchor error codes `6000..=6030` (31 variants).** The Pinocchio `From<PactError> for ProgramError` must emit `ProgramError::Custom(6000..=6030)` with the identical semantic mapping Anchor generated. Variant order and names come from `packages/program/programs/pact-insurance/src/error.rs`. Backend/SDK regex depends on this. *(Updated post-WP-2: recon spec §6.1 said 31 variants / 6000..=6030 — stale. Commit `8084c41` added `RateBelowFloor`, `PolicyExpired`, `InvalidOracleKey` post-spec-freeze. Live source has 31. The rule "preserve Anchor numbering" overrides the stale numeric range.)*
4. **Fix `create_pool` mint bug.** The Pinocchio port of `create_pool` MUST add an explicit `pool_usdc_mint.key() == config.usdc_mint` check. This was missing in the Anchor original (spec §8.2) — fixing it during the port is in scope.
5. **Cooldown-resets-on-every-deposit.** Preserve exactly (spec §8.3). Do not "fix."
6. **Test harness migrates during the port.** Each instruction PR includes: handler + account validators + Codama-regenerated TS client surface for just that instruction + the migrated Codama/`@solana/kit` test. No "rewrite tests after the port" step.

## Structure

- **Section A — Work Packages** (one PR per WP, 20 WPs total)
- **Section B — Parallelization map**
- **Section C — Per-WP spawning prompts** (copy-paste ready)
- **Section D — CI / build-system changes**
- **Section E — Downstream package impact**
- **Section F — Per-WP go/no-go gate**
- **Section G — Open items for Alan**

## WP-1 post-mortem — conventions locked in by reality (Apr 22, 2026)

WP-1 landed at commit `2524cae` (SBF size 5.4 KiB vs Anchor's 461 KiB). Five deviations from the original plan that now apply to WP-2..WP-20:

1. **Crate directory** is `packages/program/programs-pinocchio/pact-insurance-pinocchio/`, NOT `packages/program/programs/pact-insurance-pinocchio/`. Reason: Anchor 1.0's workspace auto-scans `programs/*` as Anchor crates and fails the test build if any subdir isn't Anchor. WP-17 collapses to a single `programs/` at cut-over.
2. **`pinocchio-system` and `pinocchio-token` are NOT yet in `Cargo.toml`.** Version alignment: `pinocchio = "0.10"` is incompatible with both `pinocchio-system 0.4` (requires 0.9) and `0.6` (requires 0.11). The first CPI-touching WP (WP-8 `create_pool`) must either pin a git commit of those helpers that aligns with 0.10 or drop to hand-rolled CPI via `pinocchio::cpi::invoke_signed`. Flag as a mini-blocker for WP-8 planner.
3. **`declare_id!`** comes from `solana-address = { version = "2", features = ["decode"] }` (added as direct dep), NOT from `pinocchio` or `pinocchio-pubkey`. Pinocchio 0.10 dropped `declare_id!`; `pinocchio-pubkey 0.3` targets the 0.9 Pubkey API. All instruction handlers should `use solana_address::Address` (which is what `pinocchio 0.10`'s `account::AccountView::key()` returns anyway).
4. **Pinocchio 0.10 API paths** differ from the skill docs:
   - `pinocchio::account_info::AccountInfo` → `pinocchio::account::AccountView`
   - `pinocchio::pubkey::Pubkey` → `solana_address::Address` (via the new dep)
   - `pinocchio::program_error::ProgramError` → `pinocchio::error::ProgramError`
   The skill's `migration-from-anchor.md` still shows the 0.9 paths. Future WP agents: use the 0.10 paths; do not copy skill paths verbatim.
5. **Entrypoint gating.** `entrypoint!(process_instruction)` is gated on the `bpf-entrypoint` feature (default OFF). This lets `cargo test`/`cargo check` on the library work without the SBF linker. `cargo build-sbf --features bpf-entrypoint` is the SBF-build invocation. Library-mode `cargo check` is the default.

### Addendum from WP-4 (Apr 22, 2026)

6. **No `pinocchio::pubkey` module in 0.10.** PDA derivation uses `solana_address::Address::find_program_address(&[...], &ID)` — NOT `pinocchio::pubkey::find_program_address`. The `pinocchio-pubkey` 0.3 crate targets the 0.9 API and is not a substitute.
7. **`solana-address` is target-split.** Host builds need `features = ["curve25519"]` for `find_program_address` (PDA test support). SBF builds omit the feature. Handled in `pact-insurance-pinocchio/Cargo.toml` via `[target.'cfg(...)'.dependencies]` sections.
8. **Policy PDA seed truth.** Anchor's `enable_insurance.rs` uses `agent.key().as_ref()` — i.e., the agent signer's 32-byte Pubkey, NOT a hashed `agent_id` string. Recon spec's "agent_id bytes" wording was ambiguous; follow Anchor source. Same principle applies to every other "what is this seed?" question: **Anchor source trumps spec paraphrasing.**
9. **Claim PDA seed = `[b"claim", policy.as_ref(), sha256(call_id)]`** — caller pre-hashes the `call_id` to 32 bytes. Pool seed is `[b"pool", hostname_bytes]` where `hostname_bytes` is a `&[u8]` slice into the fixed `[u8; 64]` (trimmed at the `\0` terminator to match `String::as_bytes()` length in Anchor).

### Addendum from WP-5 (Apr 22, 2026)

10. **CreateAccount CPI is hand-rolled** at `src/system.rs`. No `pinocchio-system` dep added (version conflict with pinocchio 0.10 per #2). The encoder writes a 53-byte System Program payload (u32 discriminant + u64 lamports + u64 space + 32-byte owner). Stable across System Program versions. WP-8 (`create_pool`) extended with SPL-Token InitializeAccount3 — see WP-8 addendum #14.
11. **IDL is hand-written**, not Shank-generated. `packages/program/idl/pact_insurance.json` — WP-5 added instruction 0; each subsequent WP extends the same file (add to `instructions[]`, accounts tables, types). Spec §10 allows this fallback. Cheaper than fighting Shank/Pinocchio-0.10 compat.
12. **"Codama regen" is manual through WP-15.** `packages/insurance/scripts/codama-generate.mjs` is a stub with `USE_CODAMA = false`. TS client files under `packages/insurance/src/generated/` are HAND-WRITTEN in Codama-style layout (matching `@codama/renderers-js` output). Every WP-6..WP-15 crew: **hand-write** the instruction builder + account decoder + types under the same directory structure. WP-17 flips `USE_CODAMA = true`, runs real Codama against the complete IDL, and reconciles any drift (should be minimal if layout mirrored carefully).
13. **Test harness split.** Pinocchio-targeting TS tests live under `packages/program/tests-pinocchio/` (new dir, own `tsconfig.json`) and spawn `solana-test-validator` pre-loaded with `pact_insurance_pinocchio.so`. The Anchor test suite at `tests/` is untouched until WP-17. Each instruction WP moves its own tests from `tests/` to `tests-pinocchio/`.

### Addendum from WP-8 (Apr 24, 2026)

14. **SPL Token InitializeAccount3 CPI is hand-rolled** at `src/token.rs` (sibling of `src/system.rs`). Same version-conflict reason — no `pinocchio-token` dep. Instruction data: `[disc=18 u8, owner: [u8; 32]]`. Accounts: `[vault (writable), mint, rent sysvar]`. SPL Token program ID `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`.
15. **Vault PDA must be owned by `spl_token::ID` at CreateAccount time.** Spec §8.7 footgun. The `create_pool` handler creates the vault with `owner = spl_token::ID`, THEN invokes InitializeAccount3. Do not set owner to our program ID.
16. **`CoveragePool.vault_bump` is stashed in `_pad_tail[0]`** — WP-8 reused the first byte of the state struct's 6-byte trailing pad instead of adding a named field (WP-3's compile-time size/offset asserts pin the layout). **WP-9 (`deposit`), WP-10 (`withdraw`), WP-12 (`enable_insurance`), WP-14 (`settle_premium`) read `pool._pad_tail[0]` to get the vault bump** for their pool-authority signer seeds. Document this inline in each handler. If Phase 5 F1 lands `reserved: [u8; 64]` on CoveragePool as project-wide convention, the vault_bump can be promoted to a named field inside the reserved pad — re-evaluate then.

---

## Section A — Work Packages

Naming: new Pinocchio crate begins life as `pact_insurance_pinocchio` at `packages/program/programs-pinocchio/pact-insurance-pinocchio/`, parallel to the existing Anchor crate. At cut-over (WP-17) it is renamed to `pact_insurance` and the Anchor crate is deleted.

### WP-1: Scaffolding — parallel Pinocchio crate

- **Scope:** create `packages/program/programs-pinocchio/pact-insurance-pinocchio/` with `Cargo.toml`, `src/lib.rs`, `src/entrypoint.rs`, `src/discriminator.rs`, `src/error.rs` (stub). Empty `process_instruction` that matches 1-byte disc 0..=10 and returns `ProgramError::Custom(u32::MAX)` ("unimplemented") for each. `declare_id!` matches existing Anchor ID `2Go74eCvY8vCco3WPuteGzrhKz8v3R7Pcp5tjuFpcmN3` (spec §0). Add the new crate to the root workspace `packages/program/Cargo.toml`. Do NOT touch `Anchor.toml` yet — both crates coexist.
- **Dependencies:** none.
- **Exit criteria:**
  - `cargo build-sbf --manifest-path packages/program/programs-pinocchio/pact-insurance-pinocchio/Cargo.toml` succeeds.
  - The existing `anchor build` in `packages/program/` still succeeds unchanged.
  - Binary size recorded in PR description (baseline for later WPs).
  - No TS/SDK/backend file modified.
- **Scope size:** S — new crate, no logic.
- **Risk flags:** first contact with Pinocchio toolchain; confirm Rust toolchain from `packages/program/rust-toolchain.toml` supports Pinocchio 0.10 on SBF target. If it doesn't, bump `rust-toolchain.toml` *inside* this PR and note it prominently.

### WP-2: Error module (numeric-preserving)

- **Scope:** port `packages/program/programs/pact-insurance/src/error.rs` to `packages/program/programs-pinocchio/pact-insurance-pinocchio/src/error.rs`. `#[repr(u32)] enum PactError` with variants in the **identical source order** as the Anchor enum (variants 0..=30 → codes 6000..=6030). `impl From<PactError> for ProgramError { |e| ProgramError::Custom(6000 + e as u32) }`. Preserve variant names verbatim (SDK regex depends on name strings in logs — spec §6.1). Add unit test asserting `6000 + ProtocolPaused as u32 == 6000` and each well-known variant maps to its Anchor number.
- **Dependencies:** WP-1 merged.
- **Exit criteria:**
  - All 31 variants present in identical source order.
  - `cargo test --manifest-path packages/program/programs-pinocchio/pact-insurance-pinocchio/Cargo.toml` passes the numeric-preservation unit test.
  - No behavior change in Anchor crate.
- **Scope size:** S.
- **Risk flags:** off-by-one on variant order is silent and catastrophic. Include a table in the PR description mapping every variant → number, cross-checked against the Anchor enum.

### WP-3: State layout (bytemuck, zero-copy, memcmp-compatible)

- **Scope:** port all five account structs to `packages/program/programs-pinocchio/pact-insurance-pinocchio/src/state.rs` as `#[repr(C)] #[derive(Pod, Zeroable)]` structs. Explicit 1-byte `discriminator: u8` as first field, then **7-byte padding**, so the first domain Pubkey lands at **offset 8** in every struct (required by `listPolicies` memcmp query — spec §7.2). Field order per spec §7.2: `ProtocolConfig.authority`, `CoveragePool.authority`, `UnderwriterPosition.pool`, `Policy.agent`, `Claim.policy` are all the first Pubkey after the 8-byte prefix. Use `[u8; 64]` + `u8 len` for `CoveragePool.provider_hostname` and `Policy.agent_id` (Alan's locked decision — constraint #1). Add `LEN` const via `core::mem::size_of::<Self>()`. Add `try_from_bytes` / `try_from_bytes_mut` helpers wrapping `bytemuck::try_from_bytes` with discriminator check. Add `DISCRIMINATOR: u8` const per struct (0..=4). **No handler logic yet** — structs, discriminators, helpers only.
- **Dependencies:** WP-1 merged. **Can run in parallel with WP-2.**
- **Exit criteria:**
  - `cargo test` (new crate) passes a round-trip test per struct: zero → fill → `bytes_of` → `try_from_bytes` → field equality.
  - A padding-offset test asserts the first domain Pubkey is at byte offset 8 for each struct.
  - No handler code in this PR.
- **Scope size:** M.
- **Risk flags:** first introduction of bytemuck — expect compile churn around alignment. If a struct won't pack to an alignment bytemuck accepts, use explicit `[u8; N]` arrays for scalars and document in a one-line comment. Per-struct `size_of` numbers go in the PR description; compare against spec §2 sizes (they will differ — that's expected because of the 7-byte pad and the fixed string buffers).

### WP-4: Constants + seed helpers

- **Scope:** verbatim copy of `packages/program/programs/pact-insurance/src/constants.rs` to `packages/program/programs-pinocchio/pact-insurance-pinocchio/src/constants.rs`. Add `src/pda.rs` with helpers: `protocol_seeds()`, `pool_seeds(hostname_bytes)`, `vault_seeds(pool_pubkey)`, `position_seeds(pool, underwriter)`, `policy_seeds(pool, agent)`, `claim_seeds(policy, call_id_hash)`. These return `&[&[u8]]`-shaped slice constants suitable for `find_program_address` and `create_program_address`.
- **Dependencies:** WP-1. **Can run in parallel with WP-2 and WP-3.**
- **Exit criteria:**
  - Unit test per seed helper proving PDA derivation matches the Anchor Rust crate's derivation for at least one hard-coded input (cross-crate assertion — import `pact_insurance::ID` into the test).
- **Scope size:** S.
- **Risk flags:** seed-slice lifetime handling — spec §8.8. Exercising `invoke_signed` is deferred to WP-7+ but these helpers must return data whose lifetime the caller can extend on the stack. Document the borrow shape in a one-line comment.

### WP-5: `initialize_protocol` (disc 0)

- **Scope:** implement the instruction per spec §3.1 in `src/instructions/initialize_protocol.rs`. Wire into the `process_instruction` dispatcher. Add Shank annotations on the instruction enum entry (spec §10.1). Regenerate Shank IDL and Codama TS client for **disc 0 only** — place generated output under `packages/insurance/src/generated/` (gitignored-until-checked-in strategy TBD; for this PR commit the generated file under `packages/insurance/src/generated/initialize-protocol.ts` + minimal shared plumbing). Migrate `packages/program/tests/protocol.ts` tests that target initialize_protocol from `anchor.workspace.PactInsurance` to the Codama instruction builder + `@solana/kit` RPC. Backend/existing SDK surface untouched in this PR (still points at old Anchor client).
- **Dependencies:** WP-2, WP-3, WP-4.
- **Exit criteria:**
  - `cargo build-sbf` succeeds for the new crate.
  - New devnet-style test (solana-test-validator + Codama) runs and passes `initializes the protocol config` and `rejects second initialization` from `protocol.ts` — first 2 tests of §5.2.
  - Old Anchor test suite (42 tests) still passes in full against the still-existing Anchor crate.
  - `enforce-deployer` feature flag is wired (compile-time cfg gate), even if not exercised in default CI.
- **Scope size:** M.
- **Risk flags:** first end-to-end test of the Shank → Codama → `@solana/kit` toolchain. If Codama produces disc encoding that disagrees with the Rust dispatcher (wrong endianness, wrong offset), fix the Codama config here — every later WP rides on it.

### WP-6: `update_config` (disc 1)

- **Scope:** handler per spec §3.2 — 13-option Borsh-decoded `UpdateConfigArgs`, each option range-checked per `constants.rs`. Reject any `Some(_)` on `treasury` / `usdc_mint` with `FrozenConfigField`. Codama-regen the instruction builder + migrate `protocol.ts` tests for update_config and `security-hardening.ts` H-03 suite.
- **Dependencies:** WP-5 merged.
- **Exit criteria:**
  - `cargo build-sbf` green; new-crate binary size recorded.
  - Migrated tests: `updates protocol_fee_bps when authority calls update_config`, all 6 floor/cap rejection tests (§5.2), H-03 (treasury + usdc_mint frozen) all green.
  - Anchor test suite unchanged.
- **Scope size:** M.
- **Risk flags:** Borsh hand-decoding of 13 `Option<..>` fields is error-prone. Consider delegating to `borsh` crate with `default-features = false` if allocator-free decoding is feasible; otherwise decode manually and document each offset with a one-line comment near the decoder.

### WP-7: `update_oracle` (disc 2)

- **Scope:** handler per spec §3.3 — authority-gated single-Pubkey write, with `new_oracle != default && new_oracle != config.authority` checks. Codama-regen + migrate the C-02 `update_oracle` tests from `security-hardening.ts`.
- **Dependencies:** WP-6 merged.
- **Exit criteria:**
  - Migrated tests green: C-02 rotate/reject-non-authority/reject-zero-pubkey/reject-equal-to-authority.
- **Scope size:** S.
- **Risk flags:** none novel.

### WP-8: `create_pool` (disc 3) — **includes mint bug fix**

- **Scope:** handler per spec §3.4. **MUST include the `pool_usdc_mint.key() == config.usdc_mint` check (Alan's locked decision #4 — this is the bug-fix-during-port).** Exercises three CPIs: System CreateAccount (pool), System CreateAccount (vault with `owner = spl_token::ID`), SPL-Token `InitializeAccount3`. Store `vault_bump` in `CoveragePool` to eliminate runtime `find_program_address` cost on later instructions (spec §3.4 note). Codama-regen + migrate all 4 `pool.ts` tests except `update_rates` (that goes in WP-10). Add a new test asserting the mint-bug fix: creating a pool with a mismatched mint fails.
- **Dependencies:** WP-7 merged.
- **Exit criteria:**
  - `cargo build-sbf` green; binary size recorded vs WP-7 baseline.
  - Migrated tests pass: `creates a pool for a provider hostname`, `rejects duplicate pool creation`, **new test: create_pool rejects non-config USDC mint**.
  - `CoveragePool.vault_bump` is populated and read by downstream WPs.
- **Scope size:** L.
- **Risk flags:** spec §8.7 (the easy-to-forget `owner = spl_token::ID` on CreateAccount for the vault); spec §8.8 (signer-seed lifetime). The new mint check adds one more code path to test — make sure Alan's locked decision is called out in the PR description.

### WP-9: `deposit` (disc 4)

- **Scope:** handler per spec §3.5. `init_if_needed` pattern: branch on `position.data_is_empty()` — init path creates + zero-fills counters, re-open path verifies owner + discriminator and preserves counters. User-signed SPL-Token Transfer. Checked-add on `position.deposited`, `pool.total_deposited`, `pool.total_available`. **Preserve cooldown-reset-on-every-deposit (Alan's locked decision #5).** Codama-regen + migrate all 4 `underwriter.ts` tests.
- **Dependencies:** WP-8 merged.
- **Exit criteria:**
  - 4 underwriter tests pass.
  - Unit test (Rust) asserts re-open path does not wipe `deposited`/`total_*` counters.
- **Scope size:** M.
- **Risk flags:** spec §8.6 init_if_needed footgun. Write the Rust unit test for the re-open branch before integration.

### WP-10: `withdraw` (disc 8)

- **Scope:** handler per spec §3.9. First pool-PDA-signed CPI. Reuse `vault_bump` stored by WP-8. Share a `pool_signer_seeds(pool, hostname_bytes, bump)` helper in `src/pda.rs` — every later WP reuses it. Codama-regen + migrate the cooldown-related `underwriter.ts` test that targets withdraw.
- **Dependencies:** WP-9 merged.
- **Exit criteria:**
  - `rejects withdraw before cooldown elapsed` passes against Pinocchio.
  - Happy-path withdraw (added as a new test) passes.
- **Scope size:** M.
- **Risk flags:** spec §8.8 signer-seed lifetime — this is the first WP that actually invokes signed CPI with dynamic hostname bytes. Keep the seed slices as stack-locals bound to the handler's stack frame.

### WP-11: `update_rates` (disc 9)

- **Scope:** handler per spec §3.10 — oracle-signed rate clamp. Codama-regen + migrate `pool.ts` `update_rates` test + H-04 suite from `security-hardening.ts`.
- **Dependencies:** WP-10 merged. **Can run in parallel with WP-9/WP-10's test migration** once WP-8's state layout is final (it doesn't touch vault CPIs), but sequentially it's cleanest after WP-10 since both touch pool mutations.
- **Exit criteria:**
  - `updates pool insurance_rate_bps via update_rates`, `rejects update_rates from non-oracle signer`, H-04 rate>10_000 + rate<min_premium tests all green.
- **Scope size:** S.
- **Risk flags:** none novel.

### WP-12: `enable_insurance` (disc 5)

- **Scope:** handler per spec §3.6 — first SPL-Token account field reads (mint, owner, delegate, delegated_amount). Preserve seed strategy (agent wallet key, not agent_token_account key — spec §3.6 note). Codama-regen + migrate both `policy.ts` tests + H-05 `enable_insurance rejects expires_at in past`.
- **Dependencies:** WP-10 merged (for the `vault_bump` being populated) and WP-9 (position / user-facing state flows debugged). If downstream token-account-layout helper is needed, add it in this WP and share with WP-13/WP-14.
- **Exit criteria:**
  - `rejects enable_insurance without prior SPL approve`, `enables insurance after SPL approve to pool PDA`, H-05 expires-at-in-past green.
  - A `src/token_account.rs` helper module reads `mint` (bytes 0..32), `owner` (32..64), `amount` (64..72 LE), `delegate` (72..108 with Option discriminator), `delegated_amount` (spec §9 risk) — without pulling `spl-token` as a dep.
- **Scope size:** M.
- **Risk flags:** spec §9 — hand-coded SPL Token-account byte layout. Consider `pinocchio-token`'s `TokenAccount::from_account_info` helper if it exists in the pinned version; if not, ship the hand-coded helper.

### WP-13: `disable_policy` (disc 6)

- **Scope:** trivial flag flip per spec §3.7 with saturating decrement preserved. Codama-regen + migrate the H-05 `disable_policy sets active=false + decrements` test.
- **Dependencies:** WP-12 merged.
- **Exit criteria:**
  - H-05 disable test green.
- **Scope size:** XS.
- **Risk flags:** none.

### WP-14: `settle_premium` (disc 7)

- **Scope:** handler per spec §3.8 — two PDA-signed SPL-Token transfers via delegation, u128-intermediate premium math with saturating u64 cast. Critical: does NOT require `policy.active` (premium-evasion guard — spec §5.8 H-05). Codama-regen + migrate `settlement.ts` both tests + H-05 `settle_premium STILL collects on disabled policy` + `settle_premium rejects expired`.
- **Dependencies:** WP-13 merged.
- **Exit criteria:**
  - `settles premium by pulling from agent ATA`, `rejects settle_premium when oracle signer is wrong`, H-05 premium-evasion guard, H-05 rejects expired — all green.
  - Rust unit test for the `gross = min(call_value*bps/10_000, delegated_amount, ata_balance)` clamp with overflow-hostile inputs (u64::MAX etc.).
- **Scope size:** L.
- **Risk flags:** premium math overflow is a real hazard — use u128 intermediate as the spec says. Premium-evasion guard inversion (accidentally requiring `policy.active`) silently breaks H-05.

### WP-15: `submit_claim` (disc 10) — largest handler

- **Scope:** handler per spec §3.11 — `sha2::Sha256` over `call_id`, claim PDA with the hash as seed #3 (duplicate detection), aggregate-window math with cap reset, CreateAccount for `Claim`, PDA-signed SPL-Token Transfer(vault → agent_ata). Codama-regen + migrate all 3 `claims.ts` tests + C-03 + H-02 suite + H-05 `submit_claim rejects disabled/expired` from `security-hardening.ts`.
- **Dependencies:** WP-14 merged.
- **Exit criteria:**
  - `submits a claim and transfers refund`, `rejects duplicate claim (same call_id)`, `rejects claim outside window (old timestamp)`, C-03, H-02 (36-char UUID + 64-char max), H-05 disabled/expired — all green.
  - Rust unit test for the aggregate-cap-window reset logic.
- **Scope size:** L.
- **Risk flags:** spec §8.12 — confirm `sha2` builds no-std on SBF. If it doesn't, fall back to `solana_program::hash::hashv` or an in-crate implementation — flag in PR description.

### WP-16: Full-regression green on the Pinocchio crate

- **Scope:** no source changes in `pact-insurance-pinocchio`. Wire the remaining test files and sweep any migrated tests that were skipped because a dependency WP hadn't shipped. Run the complete 42-test suite against the Pinocchio program on `solana-test-validator`. Fix only flakes, timing, or harness issues. If a real Pinocchio bug surfaces, revert this PR and fix in the originating WP — do not patch forward.
- **Dependencies:** WP-5 through WP-15 all merged.
- **Exit criteria:**
  - 42/42 tests green against the Pinocchio crate in CI.
  - Anchor crate's test suite also still 42/42 green (both crates are live in parallel).
- **Scope size:** M.
- **Risk flags:** if a test fails in a way that implicates spec ambiguity, stop and escalate — do not edit the Pinocchio handler inside the regression-run PR.

### WP-17: Cut-over — rename Pinocchio crate, delete Anchor crate

- **Scope:** delete `packages/program/programs/pact-insurance/` (the Anchor crate). Rename `packages/program/programs-pinocchio/pact-insurance-pinocchio/` → `packages/program/programs/pact-insurance/`. Update crate name in `Cargo.toml` from `pact_insurance_pinocchio` to `pact_insurance`. Update the root workspace `packages/program/Cargo.toml`. Remove Anchor-specific `Anchor.toml` sections referencing anchor build steps; keep the deploy/cluster config. Delete old Anchor IDL shipping artifacts from `packages/insurance/src/idl/pact_insurance.json`. Finalize `packages/insurance/src/generated/` as the sole on-chain client surface. Delete `packages/insurance/src/anchor-client.ts`; replace with `packages/insurance/src/kit-client.ts` (Codama + `@solana/kit`). Update `packages/insurance/src/client.ts` and `packages/insurance/src/index.ts` so the exported `PactInsurance` class surface from spec §7.1 is **identical** — only the transport underneath changes.
- **Dependencies:** WP-16 merged.
- **Exit criteria:**
  - `packages/program/` has exactly one crate named `pact_insurance`.
  - `anchor build` command removed from CI; replaced by `cargo build-sbf`.
  - `@q3labs/pact-insurance` exports in `packages/insurance/src/index.ts` unchanged (public types + class surface byte-identical per spec §7.1).
  - Full 42-test suite green.
- **Scope size:** L.
- **Risk flags:** this is the destructive, hard-to-revert step. Two safeguards: (a) cut a tag `pre-pinocchio-cutover` immediately before merge; (b) do not run `solana program deploy` from this PR — that lives in WP-19.

### WP-18: Backend wiring — `packages/backend/`

- **Scope:** update backend's on-chain read paths to use Codama decoders instead of `@coral-xyz/anchor` `program.account.*.fetch` / `.all`. The error-code log regex already expects `6000..=6030` so it should not need updating — but ADD an explicit test asserting current backend error-string parsing still matches. If anything in `packages/backend/src/**` directly imported `anchor-client.ts`, retarget it at `kit-client.ts`.
- **Dependencies:** WP-17 merged.
- **Exit criteria:**
  - Backend unit tests green.
  - A new integration test confirms the `listPolicies`-equivalent backend query using `offset: 8` memcmp still works against the Pinocchio-produced Policy accounts.
- **Scope size:** M.
- **Risk flags:** if backend uses any Anchor-IDL-specific event decoding, that codepath needs re-architecting — flag in PR description and route to Alan.

### WP-19: Devnet redeploy + deploy-cost measurement

- **Scope:** wipe the devnet `2Go74...` program (upgrade is impossible given the account-layout break — we redeploy the same program ID if upgrade authority still holds it; if not, deploy a fresh program ID and update `declare_id!` + all env vars). Re-seed fresh state: protocol config, sample pool(s), sample underwriter positions. Record the actual `solana program deploy` + rent cost. Include in PR description a table: Anchor baseline 5.55 SOL vs Pinocchio actual. Target per Rick's reference was 3-4 SOL (LazyAccount) — we expect lower with raw Pinocchio.
- **Dependencies:** WP-17 merged (WP-18 not strictly required but preferred).
- **Exit criteria:**
  - Devnet deploy transaction confirmed.
  - `.env`/deployment docs updated with any new program ID (if applicable).
  - Deploy-cost delta documented. If cost regressed vs Anchor baseline, investigate before marking the WP green.
- **Scope size:** S — if program ID reuse succeeds; M — if a fresh ID is needed and every env config flip is in scope here.
- **Risk flags:** **Requires explicit user confirmation before running `solana program deploy`** — this is a destructive shared-state action. Do not let a crew agent run the deploy unattended.

### WP-20: Downstream samples + scorecard sweep

- **Scope:** sweep `samples/*` and `packages/scorecard/` for any direct usage of the old Anchor client or IDL path. Retarget imports to the Codama client. Samples that embed the program ID should read it from a shared constant so WP-19's potential ID change ripples out in one place.
- **Dependencies:** WP-17. Can run in parallel with WP-18 and WP-19.
- **Exit criteria:**
  - `samples/*` that compile in CI all compile.
  - Scorecard loads in dev mode and renders without type errors.
- **Scope size:** S-M.
- **Risk flags:** none novel.

---

## Section B — Parallelization map

Arrows point at dependencies (`A → B` means B needs A merged). Nodes with no arrow between them are parallelizable.

```
WP-1 ──┬──> WP-2 ──┐
       │            │
       ├──> WP-3 ──┼──> WP-5 ──> WP-6 ──> WP-7 ──> WP-8 ──> WP-9 ──> WP-10 ──> WP-11 ──> WP-12 ──> WP-13 ──> WP-14 ──> WP-15 ──> WP-16 ──> WP-17 ──┬──> WP-18
       │            │                                                                                                                            │
       └──> WP-4 ──┘                                                                                                                              ├──> WP-19
                                                                                                                                                  │
                                                                                                                                                  └──> WP-20
```

**Parallel clusters:**
- **Cluster 1 (after WP-1 merges):** WP-2, WP-3, WP-4 are independent — three crew agents can run concurrently.
- **Cluster 2 (after WP-17 merges):** WP-18, WP-19, WP-20 are independent — three crew agents can run concurrently. WP-19 has the deploy-confirmation gate.
- **All instruction WPs (WP-5 .. WP-15) are sequential** because each depends on the prior Codama client surface being valid (they all share the `src/generated/` directory). Attempting to parallelize them causes merge conflicts in generated TS.

**Critical path length (longest chain of dependent WPs):** **17** — WP-1 → WP-2 → WP-5 → WP-6 → WP-7 → WP-8 → WP-9 → WP-10 → WP-11 → WP-12 → WP-13 → WP-14 → WP-15 → WP-16 → WP-17 → WP-18 (and in parallel WP-19/WP-20 after WP-17). Shortest-dependency view of WP-5 is WP-2+WP-3+WP-4, but WP-2 is on the critical path alone since WP-3/WP-4 can run alongside it.

---

## Section C — Per-WP spawning prompts

Each prompt below is a self-contained delegation the captain pastes into `Agent(...)`. Each includes: WP title, skills to invoke, required reading, exit criteria, Alan's binding constraints reminder. The boilerplate "binding constraints" section is repeated verbatim so the crew agent always sees it even if they don't read the plan's top matter.

---

### PROMPT WP-1: Scaffolding

```
You are porting `packages/program/programs/pact-insurance/` from Anchor 1.0 to Pinocchio 0.10. This is WP-1 of a 20-WP plan.

Invoke these skills before starting:
- pinocchio-development
- safe-solana-builder

Read these files first:
- docs/pinocchio-migration-spec.md §0, §1, §9 (port order step 1)
- docs/pinocchio-port-plan.md Section A, WP-1 row
- .claude/skills/pinocchio-development/SKILL.md
- .claude/skills/pinocchio-development/docs/migration-from-anchor.md
- packages/program/rust-toolchain.toml
- packages/program/Cargo.toml (root workspace manifest)

Your scope:
- Create `packages/program/programs-pinocchio/pact-insurance-pinocchio/` parallel to the existing Anchor crate.
- Stub: `Cargo.toml`, `src/lib.rs` with `declare_id!("2Go74eCvY8vCco3WPuteGzrhKz8v3R7Pcp5tjuFpcmN3")`, `src/entrypoint.rs` using Pinocchio's default entrypoint (NOT `no_allocator!` — spec §8.10), empty `process_instruction` that matches 1-byte disc 0..=10 and returns `ProgramError::Custom(u32::MAX)`.
- Wire the crate into the workspace.
- Do NOT modify `Anchor.toml`. Both crates must build side-by-side.

Exit criteria:
- `cargo build-sbf --manifest-path packages/program/programs-pinocchio/pact-insurance-pinocchio/Cargo.toml` succeeds.
- `anchor build` in `packages/program/` still succeeds.
- PR description records the Pinocchio-crate SBF binary size (baseline for later WPs).

Alan's locked decisions (BINDING — do not violate):
1. Fixed-size [u8; 64] for provider_hostname and agent_id. (WP-3 concern, but note now.)
2. No migration instruction.
3. Preserve Anchor error codes 6000..=6030.
4. Fix create_pool mint bug — but that lands in WP-8, not here.
5. Cooldown-resets-on-every-deposit preserved.
6. Tests migrate alongside handlers (not relevant to WP-1 — no handler).

Commit prefix: `feat(program): WP-1 Pinocchio scaffolding crate`.
```

---

### PROMPT WP-2: Error module

```
You are porting error.rs from Anchor #[error_code] to Pinocchio Custom codes. WP-2 of 20.

Invoke these skills:
- pinocchio-development
- safe-solana-builder

Read first:
- docs/pinocchio-migration-spec.md §6.1 (error code mapping)
- packages/program/programs/pact-insurance/src/error.rs (source of truth for variants and order)
- docs/pinocchio-port-plan.md WP-2

Scope:
- Port every variant from the Anchor enum to a `#[repr(u32)] pub enum PactError` in `packages/program/programs-pinocchio/pact-insurance-pinocchio/src/error.rs` in **IDENTICAL source order**.
- Implement `From<PactError> for ProgramError` emitting `ProgramError::Custom(6000 + variant as u32)`.
- Preserve variant NAMES verbatim — SDK regex depends on them in log output.
- Add a unit test cross-checking at least 5 well-known variants (ProtocolPaused=6000, Unauthorized, FrozenConfigField, InvalidOracleKey=6027, and one other) against their Anchor numbers.

Exit criteria:
- Rust unit test asserts `6000 + ProtocolPaused as u32 == 6000` and `6000 + InvalidOracleKey as u32 == 6027`.
- `cargo test --manifest-path packages/program/programs-pinocchio/pact-insurance-pinocchio/Cargo.toml` green.
- PR description includes a full variant-to-number table.

Alan's locked decisions (reminder):
1. [u8; 64] fixed strings.
2. No migration.
3. **THIS WP — preserve 6000..=6030 mapping.**
4. create_pool mint check — WP-8.
5. Cooldown-reset preserved.
6. Tests alongside — no tests for this WP beyond the Rust unit check.

Commit prefix: `feat(program): WP-2 port PactError with numeric-preserved mapping`.
```

---

### PROMPT WP-3: State layout

```
WP-3 of 20 — port all five account structs to bytemuck zero-copy.

Invoke:
- pinocchio-development
- safe-solana-builder

Read first:
- docs/pinocchio-migration-spec.md §2, §6, §7.2 (memcmp offset invariant)
- packages/program/programs/pact-insurance/src/state.rs (source field order is load-bearing)
- .claude/skills/pinocchio-development/docs/migration-from-anchor.md (zero-copy/bytemuck patterns)
- .claude/skills/pinocchio-development/docs/edge-cases.md

Scope:
- Create `packages/program/programs-pinocchio/pact-insurance-pinocchio/src/state.rs`.
- Five structs: ProtocolConfig, CoveragePool, UnderwriterPosition, Policy, Claim. All `#[repr(C)] #[derive(Pod, Zeroable, Copy, Clone)]`.
- First field of EVERY struct: `pub discriminator: u8`, then `pub _pad: [u8; 7]` — this keeps the first domain Pubkey at byte offset 8 for SDK memcmp compatibility (spec §7.2).
- Ordering after the padding (per spec §7.2): ProtocolConfig → authority first; CoveragePool → authority first; UnderwriterPosition → pool first; Policy → agent first; Claim → policy first.
- `CoveragePool.provider_hostname: [u8; 64]` + `provider_hostname_len: u8` — Alan's locked decision, not [u8; 128].
- `Policy.agent_id: [u8; 64]` + `agent_id_len: u8`.
- Every struct gets a `pub const DISCRIMINATOR: u8` (0..=4) and a `pub const LEN: usize = core::mem::size_of::<Self>()`.
- Helpers: `try_from_bytes`, `try_from_bytes_mut` that verify owner + discriminator + length before returning a typed reference.

NO HANDLER CODE. Structs + helpers + unit tests only.

Exit criteria:
- Per-struct round-trip test: zero → populate → bytes_of → try_from_bytes → field equality.
- Per-struct padding test: the first Pubkey-typed field is at offset 8.
- `cargo test --manifest-path packages/program/programs-pinocchio/pact-insurance-pinocchio/Cargo.toml` green.
- PR description records each struct's `size_of::<Self>()`.

Alan's locked decisions (reminder):
1. **THIS WP — [u8; 64] for provider_hostname and agent_id (NOT 128 as spec §2.2 mentions).**
2. No migration.
3. 6000..=6030 preserved — WP-2's concern.
4. create_pool mint check — WP-8.
5. Cooldown-reset preserved.
6. Tests alongside — N/A (pure Rust tests).

Commit prefix: `feat(program): WP-3 port account state to bytemuck zero-copy`.
```

---

### PROMPT WP-4: Constants + seed helpers

```
WP-4 of 20 — verbatim constants + PDA seed helpers.

Invoke:
- pinocchio-development

Read first:
- packages/program/programs/pact-insurance/src/constants.rs (copy verbatim)
- docs/pinocchio-migration-spec.md §2 (seed string literals) + §4 (CPI signer seeds)
- docs/pinocchio-port-plan.md WP-4

Scope:
- `packages/program/programs-pinocchio/pact-insurance-pinocchio/src/constants.rs` — exact verbatim copy.
- `packages/program/programs-pinocchio/pact-insurance-pinocchio/src/pda.rs` — seed helpers for protocol, pool (takes hostname bytes), vault (takes pool pubkey), position (takes pool+underwriter), policy (takes pool+agent), claim (takes policy + 32-byte hashed call_id).
- Seeds MUST match the Anchor crate's seed strings bit-for-bit.

Exit criteria:
- Cross-crate unit test that uses the existing `pact_insurance` Anchor crate's derivation to cross-check a hard-coded PDA derivation for each of the 5 PDA types.

Alan's locked decisions (reminder):
1. [u8; 64] strings (WP-3).
2. No migration.
3. 6000..=6030 (WP-2).
4. create_pool mint check (WP-8).
5. Cooldown-reset preserved.
6. Tests alongside — N/A here.

Commit prefix: `feat(program): WP-4 constants + PDA seed helpers`.
```

---

### PROMPT WP-5: initialize_protocol

```
WP-5 of 20 — first handler. This also validates the Shank → Codama → @solana/kit toolchain end-to-end.

Invoke:
- pinocchio-development
- safe-solana-builder
- solana-kit-migration

Read first:
- docs/pinocchio-migration-spec.md §3.1, §4, §6, §10 (IDL + Codama regen)
- packages/program/programs/pact-insurance/src/instructions/initialize_protocol.rs
- .claude/skills/pinocchio-development/examples/vault/README.md (CreateAccount + signer seeds pattern)
- docs/pinocchio-port-plan.md WP-5

Scope:
- Implement disc=0 in the dispatcher.
- `src/instructions/initialize_protocol.rs` per spec §3.1: validate system_program key, deployer is signer/writable, derive PDA [b"protocol"], assert `data_is_empty()`, optionally gate on DEPLOYER_PUBKEY when `enforce-deployer` feature active, System CreateAccount signed by `[b"protocol", &[bump]]`, write defaults + bump.
- Shank annotations so `shank idl` produces a Metaplex-flavored IDL covering disc 0.
- Codama regen: emit the `initialize_protocol` instruction builder under `packages/insurance/src/generated/`. Establish the generated-code directory layout and check it in.
- Migrate the first 2 tests of `packages/program/tests/protocol.ts` from `anchor.workspace.PactInsurance` to the Codama client + `@solana/kit` RPC. Keep the remaining tests running against Anchor for now.

Exit criteria:
- `cargo build-sbf` green for both crates.
- `initializes the protocol config with a separate authority and oracle` and `rejects second initialization` pass against Pinocchio.
- Full Anchor 42-test suite still green.
- PR description captures binary-size delta vs WP-1 baseline.

Alan's locked decisions (reminder):
1. [u8; 64] strings.
2. **No migration — fresh layout; do not write a migration instruction.**
3. 6000..=6030.
4. create_pool mint check (WP-8).
5. Cooldown-reset preserved.
6. **THIS WP — migrate tests for initialize_protocol to Codama/@solana/kit in the same PR.**

Commit prefix: `feat(program): WP-5 initialize_protocol Pinocchio handler`.
```

---

### PROMPT WP-6: update_config

```
WP-6 of 20 — authority-gated partial update. 13 Option<..> fields to Borsh-decode.

Invoke:
- pinocchio-development
- safe-solana-builder
- solana-kit-migration

Read first:
- docs/pinocchio-migration-spec.md §3.2
- packages/program/programs/pact-insurance/src/instructions/update_config.rs
- packages/program/tests/protocol.ts (safety-floor tests)
- packages/program/tests/security-hardening.ts (H-03 suite)

Scope:
- Handler per spec §3.2. Reject Some(_) on treasury/usdc_mint with FrozenConfigField (code 6000 + variant position).
- Every Some option enforces the constants.rs floors/caps.
- Codama-regen disc=1 instruction. Migrate protocol.ts update_config + floor/cap tests + H-03 suite to Codama/@solana/kit.

Exit criteria:
- Migrated tests green:
  - updates protocol_fee_bps when authority calls update_config
  - rejects protocol_fee_bps above ABSOLUTE_MAX (3000)
  - rejects withdrawal_cooldown below ABSOLUTE_MIN (3600)
  - rejects aggregate_cap_bps above ABSOLUTE_MAX (8000)
  - rejects update_config from non-authority
  - rejects min_pool_deposit below ABSOLUTE_MIN (1_000_000)
  - rejects claim_window_seconds below ABSOLUTE_MIN (60)
  - H-03: rejects treasury mutation; rejects usdc_mint mutation

Alan's locked decisions (reminder): same 6 bullets — especially treasury+usdc_mint frozen (locked by spec §3.2 and H-03 tests).

Commit prefix: `feat(program): WP-6 update_config Pinocchio handler`.
```

---

### PROMPT WP-7: update_oracle

```
WP-7 of 20 — single-Pubkey update, reject zero/authority collisions.

Invoke:
- pinocchio-development
- safe-solana-builder
- solana-kit-migration

Read first:
- docs/pinocchio-migration-spec.md §3.3
- packages/program/programs/pact-insurance/src/instructions/update_oracle.rs
- packages/program/tests/security-hardening.ts (C-02 suite)

Scope:
- Handler per spec §3.3. Assert `new_oracle != Pubkey::default()` and `new_oracle != config.authority`.
- Codama-regen disc=2. Migrate C-02 `update_oracle` tests (rotate, reject non-authority, reject zero pubkey, reject equal-to-authority).

Exit criteria:
- All 4 C-02 update_oracle tests green.

Alan's locked decisions: reminder boilerplate (same 6).

Commit prefix: `feat(program): WP-7 update_oracle Pinocchio handler`.
```

---

### PROMPT WP-8: create_pool + locked-in mint bug fix

```
WP-8 of 20 — first token-account creation. **Includes Alan's locked mint-bug fix.**

Invoke:
- pinocchio-development
- safe-solana-builder
- solana-kit-migration

Read first:
- docs/pinocchio-migration-spec.md §3.4, §4 (CPI matrix for create_pool), §8.7 (token-CreateAccount footgun), §8.2 (the mint bug context)
- packages/program/programs/pact-insurance/src/instructions/create_pool.rs
- packages/program/tests/pool.ts
- .claude/skills/pinocchio-development/examples/vault/README.md

Scope:
- Handler per spec §3.4. Three CPIs:
  1. System CreateAccount for pool PDA, signed by [b"pool", hostname, &[bump]]
  2. System CreateAccount for vault PDA with **owner = spl_token::ID** (easy to forget — spec §8.7)
  3. SPL Token InitializeAccount3 to bind vault.mint = usdc_mint, vault.authority = pool PDA
- **ADD the mint check `pool_usdc_mint.key() == config.usdc_mint` — Alan's locked decision #4. This was missing in the Anchor crate and is fixed during the port.**
- Store `vault_bump` into `CoveragePool` so downstream handlers don't pay `find_program_address` cost.
- Codama-regen disc=3. Migrate `pool.ts` tests: `creates a pool`, `rejects duplicate pool creation`. ADD a new test: `rejects create_pool when usdc_mint != config.usdc_mint` (validates the fix).

Exit criteria:
- Migrated pool.ts tests + new mint-check test all green.
- `cargo build-sbf` green; binary size recorded.

Alan's locked decisions: 6-bullet boilerplate — **#4 is this WP's headline.**

Commit prefix: `feat(program): WP-8 create_pool handler + fix missing mint check`.
```

---

### PROMPT WP-9: deposit

```
WP-9 of 20 — first user-signed SPL-Token transfer + init_if_needed branching. **Preserve cooldown-reset-on-every-deposit.**

Invoke:
- pinocchio-development
- safe-solana-builder
- solana-kit-migration

Read first:
- docs/pinocchio-migration-spec.md §3.5, §8.6 (init_if_needed footgun), §8.3 (cooldown reset intent)
- packages/program/programs/pact-insurance/src/instructions/deposit.rs (line ~92 does the cooldown reset — preserve exactly)
- packages/program/tests/underwriter.ts

Scope:
- Handler per spec §3.5.
- Init path: `if position.data_is_empty()` → CreateAccount signed by position seeds, zero-fill counters.
- Re-open path: verify position.owner == program_id AND position.discriminator == UNDERWRITER_POSITION_DISC. Preserve all counters.
- **On EVERY deposit: reset `position.deposit_timestamp = clock.unix_timestamp`** — Alan's locked decision #5, by design.
- Checked-add on `position.deposited`, `pool.total_deposited`, `pool.total_available`.
- Codama-regen disc=4. Migrate all 4 underwriter.ts tests.

Exit criteria:
- 4 underwriter.ts tests green.
- Rust unit test asserts re-open branch preserves deposited counters.

Alan's locked decisions: 6-bullet boilerplate — **#5 is this WP's headline.**

Commit prefix: `feat(program): WP-9 deposit handler with init_if_needed branch`.
```

---

### PROMPT WP-10: withdraw

```
WP-10 of 20 — first pool-PDA-signed SPL-Token transfer.

Invoke:
- pinocchio-development
- safe-solana-builder
- solana-kit-migration

Read first:
- docs/pinocchio-migration-spec.md §3.9, §8.8 (signer-seed lifetime)
- packages/program/programs/pact-insurance/src/instructions/withdraw.rs
- packages/program/tests/underwriter.ts (cooldown test)

Scope:
- Handler per spec §3.9. Use `pool.vault_bump` stored by WP-8 to avoid `find_program_address`.
- Add `src/pda.rs::pool_signer_seeds(pool_hostname_bytes, bump) -> [&[u8]; 3]` helper — every future WP reuses this.
- Signer seeds are stack-locals bound to the handler frame — do not pass `.to_vec()` pointers.
- Checked-sub on position.deposited, pool.total_deposited, pool.total_available.
- Codama-regen disc=8. Migrate `rejects withdraw before cooldown elapsed` + add a happy-path withdraw test.

Exit criteria:
- cooldown rejection test + new happy-path withdraw test both green.

Alan's locked decisions: 6-bullet boilerplate.

Commit prefix: `feat(program): WP-10 withdraw handler + shared pool signer seeds`.
```

---

### PROMPT WP-11: update_rates

```
WP-11 of 20 — oracle-signed rate clamp.

Invoke:
- pinocchio-development
- safe-solana-builder
- solana-kit-migration

Read first:
- docs/pinocchio-migration-spec.md §3.10
- packages/program/programs/pact-insurance/src/instructions/update_rates.rs
- packages/program/tests/pool.ts (update_rates tests) + tests/security-hardening.ts (H-04)

Scope:
- Handler per spec §3.10. `oracle.key() == config.oracle`, `new_rate_bps <= 10_000`, `new_rate_bps >= pool.min_premium_bps`.
- Codama-regen disc=9. Migrate `updates pool insurance_rate_bps`, `rejects update_rates from non-oracle`, H-04 rate>10_000 and rate<min_premium.

Exit criteria:
- 4 migrated tests green.

Alan's locked decisions: 6-bullet boilerplate.

Commit prefix: `feat(program): WP-11 update_rates handler`.
```

---

### PROMPT WP-12: enable_insurance

```
WP-12 of 20 — first SPL Token-account field reads (delegate, delegated_amount).

Invoke:
- pinocchio-development
- safe-solana-builder
- solana-kit-migration

Read first:
- docs/pinocchio-migration-spec.md §3.6, §8.9 (hand-coded token-account layout reads), §3.6 note (seed uses agent wallet not ATA)
- packages/program/programs/pact-insurance/src/instructions/enable_insurance.rs
- packages/program/tests/policy.ts

Scope:
- Handler per spec §3.6. Seeds MUST use agent.key() (wallet), not agent_token_account.key().
- Add `src/token_account.rs` helper reading mint (0..32), owner (32..64), amount (64..72 LE), delegate (72..108 with Option disc), delegated_amount (108..116 LE) — no `spl-token` dep.
- If `pinocchio-token::TokenAccount::from_account_info` exists in the pinned version, use it instead and delete the hand-coded helper.
- Codama-regen disc=5. Migrate both policy.ts tests + H-05 `enable_insurance rejects expires_at in past`.

Exit criteria:
- 3 tests green: rejects without SPL approve; enables after SPL approve; rejects expires_at in past.

Alan's locked decisions: 6-bullet boilerplate.

Commit prefix: `feat(program): WP-12 enable_insurance + SPL token-account helper`.
```

---

### PROMPT WP-13: disable_policy

```
WP-13 of 20 — trivial flag flip with saturating decrement.

Invoke:
- pinocchio-development
- safe-solana-builder
- solana-kit-migration

Read first:
- docs/pinocchio-migration-spec.md §3.7
- packages/program/programs/pact-insurance/src/instructions/disable_policy.rs
- packages/program/tests/security-hardening.ts (H-05 disable_policy test)

Scope:
- Handler per spec §3.7. policy.pool == pool.key(); policy.agent == agent.key(); policy.active == true.
- `policy.active = false`; `pool.active_policies = pool.active_policies.saturating_sub(1)` (Anchor behavior preserved).
- Codama-regen disc=6. Migrate H-05 disable_policy test.

Exit criteria:
- H-05 disable test green.

Alan's locked decisions: 6-bullet boilerplate.

Commit prefix: `feat(program): WP-13 disable_policy handler`.
```

---

### PROMPT WP-14: settle_premium

```
WP-14 of 20 — two PDA-signed SPL-Token transfers via delegation. Premium math in u128.

Invoke:
- pinocchio-development
- safe-solana-builder
- solana-kit-migration
- solana-vulnerability-scanner (before merging — run on this handler)

Read first:
- docs/pinocchio-migration-spec.md §3.8
- packages/program/programs/pact-insurance/src/instructions/settle_premium.rs
- packages/program/tests/settlement.ts + tests/security-hardening.ts (H-05 premium-evasion and rejects-expired)

Scope:
- Handler per spec §3.8. **Does NOT require `policy.active`** — this is the premium-evasion guard (H-05). Requires `now < policy.expires_at`.
- Premium math: u128 intermediate, `gross = min(call_value * pool.insurance_rate_bps / 10_000, agent_ata.delegated_amount, agent_ata.amount)`. If `gross == 0`: early return Ok.
- `protocol_fee = gross * config.protocol_fee_bps / 10_000`; `pool_premium = gross - protocol_fee`.
- Two SPL-Token Transfer CPIs signed by `[b"pool", hostname, &[pool.bump]]`: (a) agent_ata → vault (pool_premium) if > 0; (b) agent_ata → treasury_ata (protocol_fee) if > 0.
- Update: policy.total_premiums_paid += gross; pool.total_premiums_earned += pool_premium; pool.total_available += pool_premium.
- Codama-regen disc=7. Migrate both settlement.ts tests + H-05 premium-evasion + H-05 rejects-expired.

Exit criteria:
- 4 migrated tests green.
- Rust unit test for premium math clamp with u64::MAX inputs demonstrating no overflow.

Alan's locked decisions: 6-bullet boilerplate.

Commit prefix: `feat(program): WP-14 settle_premium handler with two-CPI split`.
```

---

### PROMPT WP-15: submit_claim

```
WP-15 of 20 — largest and most security-critical handler. sha256 seed + window/cap math + CreateAccount + vault-to-agent transfer.

Invoke:
- pinocchio-development
- safe-solana-builder
- solana-kit-migration
- solana-vulnerability-scanner (mandatory before merge)

Read first:
- docs/pinocchio-migration-spec.md §3.11, §8.12 (sha2 no-std on SBF check)
- packages/program/programs/pact-insurance/src/instructions/submit_claim.rs
- packages/program/tests/claims.ts + tests/security-hardening.ts (C-03, H-02, H-05 disabled/expired)

Scope:
- Handler per spec §3.11.
- Claim PDA seed #3 = sha256(call_id) via `sha2::Sha256` (confirm `sha2 = { version = "0.10", default-features = false }` compiles on SBF; if not, use `solana_program::hash::hashv`).
- Duplicate detection: assert claim.data_is_empty() before CreateAccount.
- Refund clamp: `min(payment_amount, pool.max_coverage_per_call, pool.total_available)`.
- Window reset: if `now - pool.window_start > config.aggregate_cap_window_seconds`, reset payouts_this_window=0, window_start=now.
- Cap check: `pool.payouts_this_window + refund <= pool.total_deposited * min(config.aggregate_cap_bps, ABSOLUTE_MAX_AGGREGATE_CAP_BPS) / 10_000`.
- CPIs: System CreateAccount (claim, oracle pays); SPL-Token Transfer(vault → agent_ata) signed by pool PDA.
- Post-state: claim populated (status=Approved, resolved_at=now); pool.total_claims_paid += refund; pool.total_available -= refund; pool.payouts_this_window += refund; policy.total_claims_received += refund; policy.calls_covered += 1.
- Codama-regen disc=10. Migrate all 3 claims.ts tests + C-03 + H-02 (36-char UUID + 64-char max) + H-05 disabled/expired.

Exit criteria:
- 7+ migrated tests green (3 claims.ts + 1 C-03 + 2 H-02 + 2 H-05).
- Rust unit test for the aggregate-cap-window reset.

Alan's locked decisions: 6-bullet boilerplate.

Commit prefix: `feat(program): WP-15 submit_claim handler with sha256 seed`.
```

---

### PROMPT WP-16: Full-regression run

```
WP-16 of 20 — no source changes; run all 42 tests against the Pinocchio crate.

Invoke:
- pinocchio-development
- solana-kit-migration

Read first:
- docs/pinocchio-migration-spec.md §5 (test matrix)
- packages/program/tests/*.ts

Scope:
- Ensure every test in packages/program/tests/*.ts targets the Codama client (i.e. the Pinocchio crate). If any still target `anchor.workspace.PactInsurance`, migrate them in this PR.
- Run the full suite on solana-test-validator.
- Fix only harness issues, timing, or flakes. If a real Pinocchio handler bug surfaces: STOP, DO NOT PATCH IN THIS PR — revert to the originating WP and submit a fix there.
- Also run the Anchor suite (still green) to confirm side-by-side invariant holds.

Exit criteria:
- 42/42 Pinocchio green.
- 42/42 Anchor green.
- PR description records total test runtime delta (should be similar).

Alan's locked decisions: boilerplate — no new constraints for this WP.

Commit prefix: `test(program): WP-16 full 42-test regression against Pinocchio`.
```

---

### PROMPT WP-17: Cut-over

```
WP-17 of 20 — destructive cut-over. Delete Anchor crate, rename Pinocchio crate, swap SDK transport. **Tag `pre-pinocchio-cutover` BEFORE opening this PR.**

Invoke:
- pinocchio-development
- solana-kit-migration

Read first:
- docs/pinocchio-migration-spec.md §7, §10
- docs/pinocchio-port-plan.md Sections D + E
- packages/insurance/src/index.ts (public exports are BYTE-IDENTICAL after the swap)
- packages/insurance/src/anchor-client.ts (delete this file)
- packages/insurance/src/client.ts (re-targets the transport under the hood)

Scope:
- Delete `packages/program/programs/pact-insurance/` (Anchor crate).
- Rename `packages/program/programs-pinocchio/pact-insurance-pinocchio/` → `packages/program/programs/pact-insurance/`.
- Rename crate identifier `pact_insurance_pinocchio` → `pact_insurance` in the new Cargo.toml.
- Remove the old Anchor crate's entry from the workspace root manifest.
- Remove `anchor build` references in CI workflows and deploy scripts; replace with `cargo build-sbf`.
- Delete `packages/insurance/src/idl/pact_insurance.json` (Anchor IDL is gone). Keep the Shank IDL in `packages/insurance/src/generated/idl.json`.
- Delete `packages/insurance/src/anchor-client.ts`; create `packages/insurance/src/kit-client.ts` wrapping Codama-generated builders + `@solana/kit` RPC.
- `packages/insurance/src/client.ts` still exports the `PactInsurance` class with the SAME public methods (spec §7.1) — only the transport changes.
- Bump `@q3labs/pact-insurance` version per semver judgment (likely major — note to Alan).

Exit criteria:
- Exactly one program crate named `pact_insurance` at `packages/program/programs/pact-insurance/`.
- `@q3labs/pact-insurance` index.ts exports byte-identical to pre-cut-over.
- Full 42-test suite green on the single crate.
- Tag `pre-pinocchio-cutover` exists before merge.

Alan's locked decisions: 6-bullet boilerplate. **#2 (no migration) is especially load-bearing here — this is the step that would tempt a crew member to write a migration; don't.**

Commit prefix: `refactor(program): WP-17 cut over to Pinocchio crate, retire Anchor`.
```

---

### PROMPT WP-18: Backend wiring

```
WP-18 of 20 — retarget `packages/backend/` from Anchor client to Codama + @solana/kit.

Invoke:
- solana-kit-migration

Read first:
- docs/pinocchio-migration-spec.md §7, §10.3
- packages/backend/src/** (sweep for @coral-xyz/anchor imports)

Scope:
- Replace `program.account.X.fetch` / `.all` with Codama decoders.
- Preserve error-string regex matching — 6000..=6030 log format is unchanged, but add an explicit test confirming this.
- If any backend module imports the retired `anchor-client.ts`, retarget to `kit-client.ts`.
- Add an integration test exercising a `listPolicies`-equivalent memcmp query with `offset: 8` to confirm the invariant from spec §7.2.

Exit criteria:
- Backend unit tests green.
- New memcmp integration test green.
- PR description explicitly confirms "no errorCode string in backend logs/regex changed."

Alan's locked decisions: 6-bullet boilerplate.

Commit prefix: `refactor(backend): WP-18 migrate to Codama + @solana/kit`.
```

---

### PROMPT WP-19: Devnet redeploy + deploy-cost measurement

```
WP-19 of 20 — DEPLOY TO DEVNET. Destructive shared-state action — REQUIRES EXPLICIT USER CONFIRMATION BEFORE RUNNING `solana program deploy`.

Invoke:
- pinocchio-development
- surfpool (if devnet simulation is wanted before the real redeploy)

Read first:
- docs/pinocchio-migration-spec.md §8.5 (program ID reuse question)
- packages/program/Anchor.toml (cluster/program ID config)
- Whatever deploy scripts live in `packages/program/scripts/`

Scope:
- Confirm with the user whether the existing program ID `2Go74eCvY8vCco3WPuteGzrhKz8v3R7Pcp5tjuFpcmN3` upgrade authority is still reachable.
  - Yes → `solana program deploy` to replace the bytecode. Wipe devnet accounts (they are unmigrateable by locked decision #2). Re-seed protocol config + sample pools.
  - No → generate a fresh program ID, update `declare_id!` in the crate source, rebuild, deploy, update `.env` + deployment docs + scorecard constants.
- Record actual deploy + rent cost in SOL.
- PR description table: Anchor baseline 5.55 SOL vs Pinocchio actual. Rick's LazyAccount reference target was 3–4 SOL; we expect lower.

Exit criteria:
- Devnet deploy confirmed on-chain.
- Deploy-cost delta documented.
- If cost regressed vs the Anchor baseline: STOP and investigate before marking WP green.

Alan's locked decisions: 6-bullet boilerplate.

Commit prefix: `chore(program): WP-19 devnet redeploy + deploy-cost measurement`.
```

---

### PROMPT WP-20: Samples + scorecard sweep

```
WP-20 of 20 — downstream sweep for any lingering Anchor-client imports.

Invoke:
- solana-kit-migration

Read first:
- samples/**
- packages/scorecard/src/**
- packages/insurance/src/index.ts (for the canonical export surface)

Scope:
- Retarget every `@coral-xyz/anchor` or `anchor-client` import to the new `kit-client.ts` / Codama builders.
- Move any hard-coded program ID into a shared constant so WP-19's potential ID swap lands in one place.

Exit criteria:
- `samples/*` that are CI-built compile.
- Scorecard `npm run dev` renders without type errors.

Alan's locked decisions: 6-bullet boilerplate.

Commit prefix: `refactor(samples): WP-20 retarget to Codama + @solana/kit`.
```

---

## Section D — CI and build-system changes

| File | WP | Change |
|---|---|---|
| `packages/program/Cargo.toml` (workspace root) | WP-1 | Add `pact-insurance-pinocchio` crate to `members`. |
| `packages/program/Cargo.toml` (workspace root) | WP-17 | Remove the old Anchor `pact-insurance` member; rename the Pinocchio member to `pact-insurance`. |
| `packages/program/rust-toolchain.toml` | WP-1 (if needed) | Bump if pinned toolchain doesn't support Pinocchio 0.10 on SBF. |
| `packages/program/Anchor.toml` | WP-17 | Remove Anchor-specific build steps; keep cluster/programId sections for deploy. |
| `packages/program/scripts/*` | WP-17 / WP-19 | Replace any `anchor build` invocation with `cargo build-sbf`. `anchor deploy` → `solana program deploy`. |
| `.github/workflows/*.yml` (if present) | WP-17 | Replace `anchor test` with the Codama+`@solana/kit` test runner; replace build steps. |
| `packages/insurance/package.json` | WP-5 (initial), WP-17 (final) | Add Codama + `@solana/kit` deps. Drop `@coral-xyz/anchor` at WP-17. |
| `packages/insurance/package.json` version field | WP-17 | Semver major bump (likely). Rick/Alan confirm. |

## Section E — Downstream package impact

| Package | Impact | Which WP | Notes |
|---|---|---|---|
| `packages/program/` | Total rewrite | WP-1 .. WP-17 | Pinocchio crate replaces Anchor crate. |
| `packages/insurance/` (`@q3labs/pact-insurance`) | Transport swap; public API preserved | WP-5 onward (generated/); WP-17 cut-over | `anchor-client.ts` deleted at WP-17. `client.ts` and `index.ts` export surface stays identical per spec §7.1. |
| `packages/backend/` | Fetch / decode path rewrite | WP-18 | Error-regex unchanged due to preserved 6000..=6030. memcmp offset unchanged (8). |
| `packages/scorecard/` | Possibly minor — only if it imports the client directly | WP-20 | Sweep; likely just a hard-coded program ID. |
| `packages/monitor/` | No change expected | — | Does not couple to the on-chain program. |
| `samples/*` | Transport swap | WP-20 | Any demo that uses the SDK needs retargeting. |

## Section F — Per-WP go/no-go gate

Every WP PR must clear ALL of these before merging to `develop`:

1. **Compile.** `cargo build-sbf` green for the active crate; `tsc --noEmit` green across TS workspaces touched by the WP.
2. **Tests.** All tests this WP claims to make pass ARE passing. All tests the previous WPs claimed to pass are STILL passing (no regression).
3. **Anchor suite parity.** Up to and including WP-16: the Anchor 42-test suite also still passes. From WP-17 on, only the unified suite runs.
4. **Binary size.** Pinocchio-crate `.so` size reported in PR description. If this WP grew it by more than 15% vs the previous WP's baseline, the PR author must explain why.
5. **Deploy-cost baseline.** Once WP-19 runs, later WPs that touch program source must re-measure if they grow `.so` size and report delta.
6. **Spec compliance checklist.** PR description copies the spec §3.N row for the instruction being ported and ticks each bullet.
7. **Alan's locked-decisions check.** PR description explicitly states "no binding constraint violated." If the WP intentionally affects one, call it out with justification.
8. **Linter / formatter.** `cargo fmt --check`, `cargo clippy`, and the project TS linter pass.
9. **Security-relevant WPs (WP-8, WP-9, WP-14, WP-15)** — run `solana-vulnerability-scanner` on the handler and paste summary in PR description.

## Section G — Open items for Alan

These are NEW items not already answered in the recon spec's blocker list. Alan already locked decisions on the 6 previous blockers (see top of this plan).

1. **PLAN ASSUMPTION — String size mismatch.** Spec §2.2 mentions a 128-byte hostname ceiling; Alan's locked decision in the task brief says `[u8; 64]`. Using 64 bytes matches `agent_id` and saves rent, but the current Anchor `#[max_len(128)]` means pools could already exist in devnet data with hostnames longer than 64 bytes. Since locked decision #2 says no migration and devnet will be wiped, this is safe. **Confirm before WP-3 starts that 64 bytes is sufficient for real provider hostnames (e.g. `api.openai.com` = 14, `api-inference.huggingface.co` = 28 — headroom looks fine, but check).**
2. **Program ID reuse.** Spec §8.5 was a blocker answered broadly ("devnet only, wipe-and-redeploy"). **Is the upgrade authority keypair for `2Go74...` still available?** If yes, WP-19 is a `solana program deploy --program-id ...`. If no, we generate a fresh ID at WP-17 and Section E's scorecard/samples/backend env var sweep becomes mandatory (not just cleanup).
3. **SDK semver bump.** WP-17 changes the internals of `@q3labs/pact-insurance` (Anchor `Program` → Codama client) but keeps the class surface per spec §7.1. Confirm this is a major bump even if call sites don't change — some consumers may have depended on `createAnchorClient` (spec §7.1). If yes to semver major: who else needs notification (Rick? external integrators?).
4. **Shank vs alternative IDL tool.** Spec §10.1 proposes Shank. If we hit blockers with Shank compatibility, is Codama IDL format (defined directly, no Shank roundtrip) acceptable? Would simplify — Shank's Metaplex-flavored IDL is one more moving part.
5. **Enforce-deployer feature in CI.** Spec §5.2 shows this test is skipped in default CI. Should WP-5 wire a CI job that builds with `--features enforce-deployer` and runs that specific test? Cost is small; signal is valuable for the mainnet path.
6. **Codama generated code — check in or regenerate at build time?** If checked in (simpler review), the `packages/insurance/src/generated/` directory grows by ~11 files. If regenerated at build time, PR diffs are cleaner but CI and contributor setup both need the Codama CLI. Recommend: check in, regenerate pre-commit via hook. Confirm.

---

*End of plan. The captain can begin spawning WP-1 immediately — no Section G item blocks it. WP-3 needs Section G.1 confirmation before starting.*
