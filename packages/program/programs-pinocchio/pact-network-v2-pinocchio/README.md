# pact-network-v2-pinocchio — tests

LiteSVM integration tests for the V2 program, running under vitest + Node.
Local-only at the time of this commit — no CI workflow is wired yet (same as
V1's `pact-network-v1-pinocchio/tests/`).

## Requirements

- Solana SBF toolchain on PATH (`cargo build-sbf` available)
- Node ≥ 18 (Node 22 LTS validated)
- pnpm

## Build

Two binary variants are needed:

```bash
# Most tests use the bypass binary so any signer can call initialize_protocol.
# C-01 deployer guard is disabled by this Cargo feature.
cargo build-sbf --manifest-path Cargo.toml --features bpf-entrypoint,unsafe-bypass-deployer
# Copies to: ../../../target/deploy/pact_network_v2_pinocchio.so

# The C-01 enforcement test (11-c01-deployer-guard.test.ts) needs the no-bypass
# binary. Build it and copy under a distinct filename so both variants coexist:
cargo build-sbf --manifest-path Cargo.toml --features bpf-entrypoint
cp ../../../target/deploy/pact_network_v2_pinocchio.so \
   ../../../target/deploy/pact_network_v2_pinocchio_no_bypass.so
# Then rebuild the bypass variant so the canonical filename is the bypass one:
cargo build-sbf --manifest-path Cargo.toml --features bpf-entrypoint,unsafe-bypass-deployer
```

This dance is necessary because both variants must exist on disk
simultaneously and `cargo build-sbf` always writes to the same target path.
A future Cargo workspace refactor that emits the no-bypass binary under a
distinct package name would eliminate the copy step.

> **Production safety**: the `unsafe-bypass-deployer` feature MUST NEVER ship
> in a deployed artifact. The mainnet / devnet `.so` is the default-features
> build. CI artifact jobs for production deploys explicitly avoid this flag.

## Run

```bash
pnpm install
pnpm test           # one-shot
pnpm test:watch     # watch mode
pnpm typecheck      # TS-only check, no LiteSVM invocation
```

## Layout

- `tests/helpers.ts` — `loadProgram(svm, { bypass })`, SPL Token mocking,
  `advanceClock`, account readers, `sendAndExtractCode`.
- `tests/fixtures.ts` — composable `setupProtocol`, `setupPool`,
  `setupUnderwriter`, `setupPolicy`.
- `tests/00-...test.ts` through `tests/11-...test.ts` — one file per
  instruction (00-10) plus a dedicated C-01 deployer-guard file (11).

All instruction-data composition goes through `@q3labs/pact-protocol-v2-client`
builders. Hand-rolled byte payloads are forbidden in tests (locked decision —
the `enable_insurance` 35-byte tail is the canonical silent-fail surface;
keeping the client as the single source of truth closes that loop).

## Why vitest, not bun:test

V1 uses bun:test. V2 diverges to vitest for repo-wide consistency (every
other TS package uses vitest) and to run on any box (`cargo build-sbf`
still needed, but no bun runtime dependency). `litesvm` is a NAPI-RS native
addon and works identically under both runners; Vitest's `forks` pool
(the 2.x+ default, pinned here in `vitest.config.ts`) is the correct
isolation level for native addons.

## CI

Not wired. Both V1 and V2 LiteSVM tests run locally only at the time of
this commit. A future PR will land a single CI workflow that builds the
SBF artifact (with the production-default features) and runs the test
suites for both program versions.
