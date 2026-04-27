# tests-pinocchio — Codama + `@solana/kit` integration tests against the Pinocchio port

This directory holds the Pinocchio-target test migrations. Each WP (WP-5..WP-15)
ports a slice of `tests/*.ts` over to the Codama-generated builders from
`packages/insurance/src/generated/` and `@solana/kit` transport.

## Running

```bash
# From packages/program/
pnpm tsx tests-pinocchio/protocol.ts
```

The test harness launches a fresh `solana-test-validator` per invocation with
the Pinocchio-built `.so` pre-loaded at the program ID declared in
`programs-pinocchio/pact-insurance-pinocchio/src/lib.rs`. The Anchor test suite
(`anchor test`) is untouched and continues to pass.

## Prerequisites

- `solana-test-validator` on `$PATH` (Agave CLI install).
- `cargo build-sbf --manifest-path programs-pinocchio/pact-insurance-pinocchio/Cargo.toml --features bpf-entrypoint`
  has been run and produced `target/deploy/pact_insurance_pinocchio.so`.
