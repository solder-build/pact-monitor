# @q3labs/pact-protocol-v2-client

TypeScript client for the V2 Pinocchio program
(`packages/program/programs-pinocchio/pact-network-v2-pinocchio/`).

> **V2 is parametric/oracle insurance.** Most state-changing instructions
> are oracle- or `ProtocolConfig.authority`-signed. The per-pool
> `pool.authority` field is stored but **never checked by any V2 handler**
> — this package does not expose any "as pool authority" capability because
> none exists on chain.

## Status

V2 is **not yet deployed** at the time of this package's first publish.
The on-chain program lives at
`packages/program/programs-pinocchio/pact-network-v2-pinocchio/` with
`declare_id!("7i9zJMwaTRw4Tdy7SAfXJdDkYQD39xyKmkBhWuUSgDJU")`. This client
is verified against the program's Rust unit-test fixtures (PDA fixtures in
`pda.rs::tests::pinned_fixture_*`); there are no LiteSVM tests for V2 yet,
and no devnet/mainnet deploys. Once V2 deploys, the `PROGRAM_ID` constant
in `src/constants.ts` is the single source of truth and a follow-up bump
is a one-line PR.

## V1 vs V2

This package is **independent** of `@q3labs/pact-protocol-v1-client`:
different program, different PDAs, different state types, different error
codes. Do not import from V1 — the error codespaces share a base (`6000`)
but the *names* diverge (V2: `ProtocolPaused = 6000`, V1:
`InsufficientBalance = 6000`). Routing a V1-program error through V2's
`decodeProtocolError` will silently print the wrong message.

## Instructions

| # | Builder | Signer | Notes |
| --- | --- | --- | --- |
| 0 | `buildInitializeProtocolIx` | `DEPLOYER_PUBKEY` (C-01) | Cold-boot only. Hardcoded on chain. |
| 1 | `buildUpdateConfigIx` | `ProtocolConfig.authority` | `treasury` + `usdcMint` are frozen — NOT in the public param type. |
| 2 | `buildUpdateOracleIx` | `ProtocolConfig.authority` | Rejects oracle == authority (C-02). |
| 3 | `buildCreatePoolIx` | `ProtocolConfig.authority` | Enforces `pool_usdc_mint == config.usdc_mint`. |
| 4 | `buildDepositIx` | Underwriter | Underwriter-signed Transfer to vault. Cooldown resets. |
| 5 | `buildEnableInsuranceIx` | Agent | Snapshots referrer at creation (WP-12). **Fixed 35-byte referrer tail** — see note below. |
| 6 | `buildDisablePolicyIx` | Agent | Sets `policy.active = 0`. |
| 7 | `buildSettlePremiumIx` | `ProtocolConfig.oracle` (C-02) | 3-way split: pool, treasury, referrer (optional remaining account). |
| 8 | `buildWithdrawIx` | Underwriter | Cooldown-gated. Pool-PDA-signed Transfer. |
| 9 | `buildUpdateRatesIx` | `ProtocolConfig.oracle` (C-02) | Per-pool rate update. |
| 10 | `buildSubmitClaimIx` | `ProtocolConfig.oracle` (C-02) | Aggregate cap enforcement + window reset + sha256-keyed Claim PDA. |

### `enable_insurance` referrer encoding

The V2 decoder unconditionally reads a 35-byte trailer after `expires_at`:
`[u8; 32] referrer`, `u8 referrer_present`, `u16 LE referrer_share_bps`.
There is no Borsh Option tag. The TS builder takes
`referrer?: { destination, shareBps }` for API ergonomics but the encoder
always writes 35 bytes — zero-fills when undefined. Sending a no-referrer
payload that omits the trailer is the most common silent-fail trap.

### `submit_claim` and the Claim PDA

`Claim.call_id` on chain is the 32-byte SHA-256 digest of the raw
`call_id` UTF-8 bytes (WP-4 addendum #9), not the raw string. Use
`hashCallId(callId)` to compute the digest and reconcile against the
decoded `claim.call_id` field. The Claim PDA's third seed is the same
digest; `getClaimPda(programId, policyPda, callId | digest)` handles both.

## Accounts

5 accounts, all `repr(C) + bytemuck::Pod`, discriminator byte at offset 0
with 7-byte pad and first domain field at offset 8. Trailing
`reserved: [u8; 64]` is intentionally omitted from decoded TS types.

| Decoder | Bytes | Discriminator |
| --- | --- | --- |
| `decodeProtocolConfig` | 256 | 0 |
| `decodeCoveragePool` | 320 | 1 |
| `decodeUnderwriterPosition` | 184 | 2 |
| `decodePolicy` | 320 | 3 (referrer tail at offsets 216/248/250) |
| `decodeClaim` | 288 | 4 (`call_id` is 32-byte digest) |

## Multisig

V2 will rotate `ProtocolConfig.authority` to a Squads multisig before
mainnet (per CLAUDE.md "Authority rotation before mainnet"). This client
takes `PublicKey` for all signer params, NOT `Keypair` — caller wraps the
returned `TransactionInstruction` via `@sqds/multisig`
`vaultTransactionCreate` → `proposalCreate` → `proposalApprove` × N →
`vaultTransactionExecute` when the authority is a multisig.

## Errors

`PROTOCOL_V2_ERRORS` maps codes 6000..=6030 contiguously. Highlights:

| Code | Name |
| --- | --- |
| 6000 | ProtocolPaused |
| 6005 | TokenAccountMismatch |
| 6011 | AggregateCapExceeded |
| 6013 | DuplicateClaim |
| 6018 | Unauthorized |
| 6024 | UnauthorizedDeployer (C-01) |
| 6025 | UnauthorizedOracle (C-02) |
| 6026 | FrozenConfigField (treasury / usdc_mint) |
| 6029 | PolicyExpired |
| 6030 | InvalidOracleKey |

Use `tryExtractProtocolError(err)` against `SendTransactionError` /
`InstructionError` shapes to pull out a typed `{ code, name, message }`.

## Why no Codama / IDL

Pinocchio emits no IDL; Shank expects Borsh state and `#[derive(ShankAccount)]`
annotations — incompatible with V2's `repr(C) + bytemuck::Pod` accounts.
Codama can be hand-authored without an IDL but produces code less ergonomic
than this hand-rolled client for a 6-PDA / 11-instruction program. Do not
migrate to Codama for marginal gain.

## SHA-256 in PDAs

`getClaimPda(programId, policyPda, callId)` needs SHA-256 to derive the
PDA — the on-chain seed is `sha256(call_id_utf8)`. We use `@noble/hashes/sha2`
(sync, isomorphic, audited, ~3 KB) so PDA helpers stay sync. The alternative
— `crypto.subtle.digest` — would force every `getXPda` to return a Promise,
which is an ergonomic regression vs V1's sync helpers.

## Verification

```bash
pnpm --filter @q3labs/pact-protocol-v2-client build && \
pnpm --filter @q3labs/pact-protocol-v2-client typecheck && \
pnpm --filter @q3labs/pact-protocol-v2-client test
```

Cross-language verification gate: PDA tests pin against the exact base58
fixtures from `pda.rs::tests::pinned_fixture_*`. A drift in any seed
literal fails loudly.
