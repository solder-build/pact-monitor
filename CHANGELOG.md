## Changelog

All notable changes to this repo land here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the repo uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html) per published package.

The repo is a workspace, so entries are grouped by package where it helps. Workspace-wide changes (CI, infra, gates) live under **Workspace**.

## [Unreleased]

### Added

- **Multi-network ChainAdapter** (PR #225, merged develop) — hexagonal ports-and-adapters (`ChainAdapter` port in `packages/shared/src/chain-adapter.ts`). `SolanaAdapter` and `EvmAdapter` let settler, indexer, and market-proxy speak to Solana and EVM chains through one interface. Adding a new chain requires only one new adapter. `PACT_ENABLED_NETWORKS` env var gates which chains each service activates.
- **Base mainnet EVM deployment** (2026-06-04, block 46880730) — PactRegistry `0x8cf7Dd…221D`, PactPool `0xA3245C…14A4`, PactSettler `0x21adb7…62A` on chain 8453. Baked into `packages/protocol-evm-v1-client/src/addresses.ts` `DEPLOYMENTS[8453]`. Fresh keys at `~/.pact-keys/base-mainnet/`; authority immutable, settler key rotatable.
- **Arbitrum Sepolia deployment** (PR #267, 2026-06-12) — full-stack EVM deployment for the Arbitrum Open House London buildathon. PactRegistry `0x79A91E…9edb` on chain 421614. Live Railway stack (3 services). E2E settle tx `0x4754ee52…` on-chain.
- **Verdict-integrity accept-and-monitor V1** (PRs #266 + #271) — `VerdictSource` provenance field (`pact_observed` vs `client_attested`) on every settlement event. Feature-flagged abuse gate (`PACT_VERDICT_ATTESTATION_GATE`) sampling `verdictSource='pact_observed'` population. C-1 imputed-cost cap (`perAgentRefundCapFor`) enforced in `computeEconomics`. Both `verdictSource` and cap persisted to the `Call` DB row. Agent-tasks#10.
- **SOL-01 fix: `verify_settlement_authority`** (PR #245, via #225) — `settle_batch` now verifies the `SettlementAuthority` PDA address and ownership before reading the signer/bump. New error `InvalidSettlementAuthority` (6033 / `0x1791`). Closes SOL-01 security finding. `packages/protocol-v1-client/src/errors.ts` updated with error 6033.
- **FS9 devnet fix: build-time `declare_id!`** (PR #269) — devnet binary now carries the devnet program ID at compile time (not the mainnet ID). Eliminates `InvalidSeeds` on devnet `settle_batch`. Operator must pass `createPact({ programId })` explicitly on devnet/localnet; mainnet default unchanged.
- **V2 double-coverage policy seam** (PR #273) — `pact-network-v2-pinocchio` `Policy` struct: `double_coverage` flag at offset 285, `linked_policy` slot at offset 256, `policy_kind` at 288, `discount_scope` (merchant-configurable, 0=unset/1=all-agents/2=opt-in) at 290. `Policy::LEN` stays 320; no migration instruction. Inert seam — the V2 runtime that reads these fields is a follow-up. Agent-tasks#17.
- **Classifier package extraction** (PR #250) — `@pact-network/classifier` extracted from `wrap`. Six outcome categories: `ok`, `client_error`, `server_error`, `timeout`, `network_error`, `other`. Golden-fixture regression suite in `packages/classifier/`.
- `packages/sdk/skills/pact-sdk/SKILL.md` — agent-skill teaching coding agents (Claude Code, Cursor, etc.) how to integrate `@q3labs/pact-sdk` into a project: install command, canonical fetch-replacement diff, signer cases, one-time `setup()` rules, B1 devnet/localnet caveat, and the golden-rule do-not-list. Mirrors the structure of `packages/cli/skills/pact-pay/SKILL.md`.
- `"./package.json"` subpath in the `exports` map of both `@q3labs/pact-sdk` and `@q3labs/pact-protocol-v1-client`. Lets build tooling read the package version programmatically (`require("@q3labs/pact-sdk/package.json")`) — previously threw `ERR_PACKAGE_PATH_NOT_EXPORTED`. Surfaced by the post-publish external smoke against the live `0.1.0` install.
- README + skill note on `pact.stats()` returning `bigint` counters. Naive `JSON.stringify(pact.stats())` throws `TypeError: Do not know how to serialize a BigInt`; both docs now show the replacer pattern. Also surfaced by the post-publish smoke. — agent-skill teaching coding agents (Claude Code, Cursor, etc.) how to integrate `@q3labs/pact-sdk` into a project: install command, canonical fetch-replacement diff, signer cases, one-time `setup()` rules, B1 devnet/localnet caveat, and the golden-rule do-not-list. Mirrors the structure of `packages/cli/skills/pact-pay/SKILL.md`.
- `"./package.json"` subpath in the `exports` map of both `@q3labs/pact-sdk` and `@q3labs/pact-protocol-v1-client`. Lets build tooling read the package version programmatically (`require("@q3labs/pact-sdk/package.json")`) — previously threw `ERR_PACKAGE_PATH_NOT_EXPORTED`. Surfaced by the post-publish external smoke against the live `0.1.0` install.
- README + skill note on `pact.stats()` returning `bigint` counters. Naive `JSON.stringify(pact.stats())` throws `TypeError: Do not know how to serialize a BigInt`; both docs now show the replacer pattern. Also surfaced by the post-publish smoke.

### Changed

- **Workspace: npm dependencies refreshed across all 20 packages.** `pnpm update -r` — in-range (semver-respecting) bumps plus a `pnpm-lock.yaml` refresh. No major versions were crossed. Notable floors moved: `typescript` 5.7/5.8 → 5.9.3, `viem` 2.21/2.48 → 2.55.16, `fastify` 5.3 → 5.12, `pg` 8.13/8.16 → 8.23, `next` 15.3 → 15.5.23, `react`/`react-dom` 19.0 → 19.2.8, `turbo` 2.3 → 2.10.10, `@nestjs/*` 10.4.0 → 10.4.22, `hono` 4.7 → 4.13.2, `tsx` 4.19 → 4.23.12. Build stays 18/18 green; indexer 170/170; all other suites 21/21.
- **Workspace: `rpc-websockets` pinned to `9.3.8` via `pnpm.overrides`.** `9.3.9` is a *patch* release that swapped its `uuid` dependency from `^11` to `^14`. `uuid@14` is ESM-only (`"type": "module"`, no `main`, no CJS `exports.require`), and the indexer's Jest runner is CJS, so every suite that transitively loads `@solana/web3.js` → `rpc-websockets` → `uuid` died with `SyntaxError: Unexpected token 'export'` — 7 of 22 indexer suites, 49 tests unrunnable. Pinning restores `uuid@11` (which ships CJS) and returns the indexer to 22/22 suites, 170/170 tests. Lift this pin only once the indexer can run ESM under Jest (or moves off Jest).

## 2026-05-20 — SDK 0.1.0 release

This is the first public release of the Pact Network agent SDK. The release PR (`develop` → `main`) is [#212](https://github.com/pactnetwork/pact-monitor/pull/212); on merge, `publish-sdk.yaml` publishes both packages to npm.

### Added

- `@q3labs/pact-sdk@0.1.0` — first release. Unified Pact Network agent SDK: `createPact()` returns a `pact.fetch()` that routes covered calls through the Pact Market proxy, manages the one-time global SPL approve, and surfaces typed events (`failure`, `refund`, `billed`, `low-balance`, `degraded`). Drop-in `fetch` replacement on Pact Network V1. Originally landed in [#210](https://github.com/pactnetwork/pact-monitor/pull/210).
- `@q3labs/pact-protocol-v1-client@0.2.0` — first publish under the `@q3labs` scope. TypeScript client for `pact-network-v1-pinocchio`: PDA derivers, account state decoders, instruction builders, SPL Token Approve/Revoke wrappers, fee-recipient helpers, error-code mapping, on-chain constants.
- `publish-sdk.yaml` GitHub Actions workflow. Two-step publish (protocol-client → sdk), `pnpm publish --dry-run` gating, monotonicity/idempotency guards, post-publish `npm view` verification with a 60s retry budget, and tag-after-verify ordering. Cuts a `sdk-v<version>` tag and a `gh release create` only after both packages resolve on the registry.
- Devnet Railway deploy scaffold — five services (`market-proxy`, `indexer`, `settler`, `dummy-upstream`, `facilitator`), env templates, smoke harness, and a runbook at `docs/devnet-railway-deploy.md` ([#202](https://github.com/pactnetwork/pact-monitor/pull/202)).
- Private beta gate — schema, backend, and `market-proxy` middleware ([#198](https://github.com/pactnetwork/pact-monitor/pull/198)).
- Redis Streams adapter for the proxy event sink and the settler consumer ([#199](https://github.com/pactnetwork/pact-monitor/pull/199)).
- SQL-first CRM layer on `beta_applicants` ([#208](https://github.com/pactnetwork/pact-monitor/pull/208)).
- Tally webhook integration — provisioner script and `why_pact` + `willing_to_feedback` capture ([#207](https://github.com/pactnetwork/pact-monitor/pull/207), [#203](https://github.com/pactnetwork/pact-monitor/pull/203)).
- Devnet on-chain init script with the USDC mint fix ([#205](https://github.com/pactnetwork/pact-monitor/pull/205)).
- PayAI-backed x402 settle for the dummy upstream ([#197](https://github.com/pactnetwork/pact-monitor/pull/197), reconciled via [#211](https://github.com/pactnetwork/pact-monitor/pull/211)).

### Changed

- npm scope rename: `@pact-network/*` → `@q3labs/*`. This aligns the SDK and protocol client with the rest of our publish surface (`@q3labs/pact-cli`, `@q3labs/pact-monitor`, `@q3labs/pact-insurance`). External callers must update both imports and `package.json` dependency entries.

### Removed

- Implicit devnet program ID default in `@q3labs/pact-protocol-v1-client`. The devnet deploy (`5jBQb7fL…`) is live for reads but its compiled `declare_id!` is the mainnet ID, so PDAs derived from `crate::ID` don't match the deploy address and `settle_batch` reverts `InvalidSeeds`. We will not ship a default that silently breaks settlement. On devnet and localnet, callers must pass `createPact({ programId })` explicitly. Mainnet still uses the canonical default `5bCJcdWdKLJ7arrMVMFh3z99rQDxV785fnD9XGcr3xwc`. This is the "B1" caveat — see the SDK README's *Operator notes* section.

### Notes

- `@q3labs/pact-sdk` is ESM-only. Node ≥18 for the package; browser via any ESM bundler (Vite, Webpack 5, esbuild, Rollup). There is no CJS export.
- `apiKey` on `PactConfig` is reserved and currently unused — the Pact Market proxy authenticates via ed25519 request signatures, not a bearer key.
