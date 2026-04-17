# Repo Structure

A map of the monorepo. If you're new and trying to figure out "where do I look to change X", start here.

For *what* the system does and how the pieces fit together at runtime, read [`docs/PHASE3.md`](./PHASE3.md) — this file is just the file-tree reference.

---

## Top-level layout

```
pact-network/
├── packages/
│   ├── program/              Anchor program (Rust, on-chain)
│   ├── backend/              Fastify API + Postgres + Solana crank (Node.js)
│   ├── sdk/                  @pact-network/monitor — fetch wrapper for agents
│   ├── insurance/            @pact-network/insurance — agent-side Solana client
│   └── scorecard/            Vite + React + Tailwind dashboard
│
├── docs/
│   ├── PHASE3.md             Phase 3 handbook + operator runbook (read first)
│   ├── STRUCTURE.md          This file
│   ├── prd-phases-1-2.pdf    Original PRD
│   └── superpowers/          Design specs, implementation plans, agent skills
│       ├── specs/            Design docs (one per phase)
│       └── plans/            Implementation plans (one per phase / pivot)
│
├── deploy/                   Docker Compose + GCP Cloud Run config
├── scripts/                  Repo-level scripts (smoke.sh, sdk-roundtrip.ts)
├── .github/workflows/        CI: build.yaml, deploy.yaml
├── README.md                 Top-level project intro + quick start
├── package.json              pnpm workspace root
└── pnpm-workspace.yaml
```

---

## `packages/program/` — Anchor program (Rust)

The on-chain insurance protocol. Holds the money. Doesn't trust anyone.

```
program/
├── programs/pact-insurance/
│   ├── Cargo.toml
│   └── src/
│       ├── lib.rs                          Instruction dispatch (entry points)
│       ├── state.rs                        Account structs (ProtocolConfig, CoveragePool,
│       │                                   UnderwriterPosition, Policy, Claim,
│       │                                   TriggerType, ClaimStatus enums)
│       ├── error.rs                        PactError enum (all custom errors)
│       ├── constants.rs                    Hardcoded safety floors + defaults
│       └── instructions/
│           ├── mod.rs                      Module re-exports
│           ├── initialize_protocol.rs      [#1] Create ProtocolConfig PDA
│           ├── update_config.rs            [#2] Mutate config (with safety floors)
│           ├── create_pool.rs              [#3] Create CoveragePool + vault
│           ├── deposit.rs                  [#4] Underwriter LP deposit
│           ├── withdraw.rs                 [#5] Underwriter LP withdraw (cooldown)
│           ├── enable_insurance.rs         [#6] Agent: validate SPL approve + create Policy
│           ├── settle_premium.rs           [#7] Crank: pull premium via SPL delegate
│           ├── update_rates.rs             [#8] Crank: write new insurance rate to pool
│           └── submit_claim.rs             [#9] Oracle: submit + auto-pay parametric claim
│
├── tests/                                  Anchor tests (24 total, all passing)
│   ├── protocol.ts                         initialize_protocol + update_config tests
│   ├── pool.ts                             create_pool + update_rates tests
│   ├── underwriter.ts                      deposit + withdraw tests
│   ├── policy.ts                           enable_insurance tests (delegation flow)
│   ├── settlement.ts                       settle_premium tests (delegate transfer math)
│   └── claims.ts                           submit_claim tests (dedupe, window, cap)
│
├── test-utils/
│   └── setup.ts                            Shared mocha test fixture: shared authority
│                                           Keypair, getOrInitProtocol() helper
│
├── scripts/                                Devnet operator scripts
│   ├── init-devnet.ts                      Initialize protocol on devnet (idempotent)
│   ├── seed-devnet-pools.ts                Create 5 pools + seed each with 100 USDC
│   ├── devnet-smoke.ts                     End-to-end E2E flow against devnet
│   └── import-phantom.mjs                  Convert Phantom base58 key → Solana CLI JSON
│
├── migrations/deploy.ts                    Anchor deploy hook
├── target/                                 Build output (gitignored)
│   ├── deploy/pact_insurance.so            Compiled BPF binary
│   ├── idl/pact_insurance.json             Generated IDL (consumed by backend + insurance SDK)
│   └── types/pact_insurance.ts             Generated TS types
├── Anchor.toml                             Anchor config (cluster, wallet, test cmd)
├── Cargo.toml / Cargo.lock
└── package.json
```

**Key file to start reading**: `programs/pact-insurance/src/lib.rs` — it's the dispatch table that lists every instruction. Each instruction has its own file under `instructions/`.

---

## `packages/backend/` — Fastify + Postgres + Solana crank

The trusted oracle. Ingests SDK call records. Submits on-chain claims. Runs the crank loops.

```
backend/
├── src/
│   ├── index.ts                    Fastify entry: registers routes + starts crank
│   ├── db.ts                       Postgres connection pool + initDb()
│   ├── schema.sql                  DDL (runs on startup, idempotent IF NOT EXISTS)
│   │
│   ├── routes/                     HTTP handlers
│   │   ├── health.ts               GET /health
│   │   ├── records.ts              POST /api/v1/records (auth, ingest, classify, maybeCreateClaim)
│   │   ├── providers.ts            GET /api/v1/providers, /:id, /:id/timeseries
│   │   ├── monitor.ts              GET /api/v1/monitor (status feed)
│   │   ├── analytics.ts            GET /api/v1/analytics/* (Rick's analytics endpoints)
│   │   ├── admin.ts                Admin endpoints (auth-gated)
│   │   ├── claims.ts               GET /api/v1/claims (list)
│   │   ├── claims-submit.ts        POST /api/v1/claims/submit (Phase 3, on-chain)
│   │   ├── pools.ts                GET /api/v1/pools, /:hostname (Phase 3, live from chain)
│   │   └── api.test.ts             Integration tests
│   │
│   ├── services/
│   │   └── claim-settlement.ts     submitClaimOnChain() + hasActiveOnChainPolicy()
│   │
│   ├── crank/                      Background loops (CRANK_ENABLED=false by default)
│   │   ├── index.ts                startCrank() / stopCrank() orchestrator
│   │   ├── premium-settler.ts      Every 15min: sweep policies, call settle_premium
│   │   ├── rate-updater.ts         Every 15min: compute new rates, call update_rates
│   │   └── policy-sweeper.ts       Hourly: no-op stub (pivot left this empty)
│   │
│   ├── middleware/
│   │   ├── auth.ts                 API key / admin auth
│   │   └── metrics.ts              Per-request latency → backend_metrics table
│   │
│   ├── utils/
│   │   ├── solana.ts               Anchor client + PDA helpers (createSolanaClient,
│   │   │                           deriveProtocolPda, derivePoolPda, etc.)
│   │   ├── claims.ts               maybeCreateClaim() — DB row + on-chain bridge
│   │   ├── insurance.ts            computeInsuranceRate(), computeTier()
│   │   └── *.test.ts               Unit tests
│   │
│   ├── scripts/
│   │   ├── seed.ts                 Seed Postgres with 5 providers + 7 days of fake calls
│   │   └── generate-key.ts         Generate a Pact API key
│   │
│   └── idl/
│       └── pact_insurance.json     Copied from program/target — consumed by Solana client
│
├── .secrets/                       gitignored — oracle keypair lives here
│   └── oracle-keypair.json         (DO NOT COMMIT)
│
├── .env / .env.example             DATABASE_URL, SOLANA_*, ORACLE_KEYPAIR_PATH, CRANK_*
├── Dockerfile / .dockerignore      Cloud Run container build
├── tsconfig.json / tsconfig.docker.json
└── package.json
```

**Key file to start reading**: `src/index.ts` — see what gets registered + when crank starts.

---

## `packages/monitor/` — `@pact-network/monitor`

Drop-in `fetch()` wrapper for AI agent apps. Records call metadata, syncs to backend.

```
sdk/
├── src/
│   ├── wrapper.ts                  PactMonitor class (extends EventEmitter behavior)
│   ├── classifier.ts               classify(statusCode, latency, body, schema) → Classification
│   ├── payment-extractor.ts        Parse x402/MPP headers from response
│   ├── storage.ts                  Local JSON file storage for unsynced records
│   ├── sync.ts                     PactSync — periodic flush to backend
│   ├── types.ts                    Public types (CallRecord, PactConfig, PactFetchOptions)
│   ├── index.ts                    Public exports
│   └── *.test.ts                   Unit tests (27 total)
│
├── dist/                           Build output (gitignored)
├── tsconfig.json
└── package.json
```

**Key file**: `src/wrapper.ts` — single class, ~160 lines, easy to read end-to-end.

---

## `packages/insurance/` — `@pact-network/insurance` (NEW in Phase 3)

Agent-side Solana client. Builds the `enable_insurance` transaction with SPL approve baked in. Wraps Policy / pool / claim queries.

```
insurance/
├── src/
│   ├── client.ts                   PactInsurance class:
│   │                                 enableInsurance(), topUpDelegation(),
│   │                                 getPolicy(), listPolicies(),
│   │                                 estimateCoverage(), submitClaim()
│   │                                 + EventEmitter (billed, low-balance events)
│   ├── anchor-client.ts            createAnchorClient() + derive*Pda helpers
│   ├── types.ts                    PactInsuranceConfig, PolicyInfo, etc.
│   └── index.ts                    Public exports
│
├── idl/
│   └── pact_insurance.json         Copied from program/target
│
├── tsconfig.json
└── package.json
```

**Key file**: `src/client.ts` — `enableInsurance` shows the delegation pattern in action.

---

## `packages/scorecard/` — Public dashboard

Vite + React + Tailwind. Lives at pactnetwork.io/scorecard (Rick's deploy, base path is `/scorecard/`).

```
scorecard/
├── src/
│   ├── App.tsx                     Router setup, header, layout
│   ├── main.tsx                    Vite entry
│   │
│   ├── api/
│   │   ├── client.ts               Public API client (providers, pools, analytics)
│   │   └── admin-client.ts         Admin endpoints
│   │
│   ├── components/
│   │   ├── ProviderTable.tsx       Main landing page (ranked provider list)
│   │   ├── ProviderDetail.tsx      Per-provider drilldown (now incl. Coverage section)
│   │   ├── CoveragePoolsPanel.tsx  Phase 3: pool list, rendered above provider table
│   │   ├── PoolDetail.tsx          Phase 3: per-pool detail page (/pool/:hostname)
│   │   ├── NetworkActivity.tsx     Live activity ticker
│   │   ├── AdminDashboard.tsx      /admin gated view
│   │   ├── ThemeToggle.tsx
│   │   └── Charts/                 Recharts wrappers
│   │
│   ├── hooks/
│   │   ├── useProviders.ts         Polls /api/v1/providers
│   │   ├── usePools.ts             Phase 3: polls /api/v1/pools every 30s
│   │   ├── usePool.ts              Phase 3: polls /api/v1/pools/:hostname every 15s
│   │   ├── useAnalytics.ts         Phase 1/2 analytics
│   │   ├── useAdminAnalytics.ts    Admin analytics
│   │   └── useChartColors.ts       Theme-aware chart colors
│   │
│   ├── analytics/
│   │   └── tracker.ts              Page-view tracker (Rick's analytics system)
│   │
│   ├── context/                    React context providers
│   ├── styles/                     Tailwind base
│   └── vite-env.d.ts               Vite env types (VITE_API_URL)
│
├── .env.development                VITE_API_URL=  (empty; uses Vite proxy)
├── .env.production                 VITE_API_URL=https://api.pactnetwork.io
├── vite.config.ts                  base: '/scorecard/', proxy config
├── tsconfig.json
└── package.json
```

**Key file**: `src/App.tsx` — see all routes and how the page tree is wired.

---

## `docs/`

```
docs/
├── PHASE3.md                       Phase 3 handbook (architecture, runbook, gotchas)
├── STRUCTURE.md                    This file
├── prd-phases-1-2.pdf              Original Rick PRD
│
└── superpowers/                    Skill-system artifacts (planning + execution)
    ├── specs/
    │   ├── 2026-04-09-phase3-onchain-settlement-design.md   First-pass design
    │   └── 2026-04-10-phase3-insurance-design.md            Final design (post-review)
    └── plans/
        ├── 2026-04-10-phase3-insurance-implementation.md    42-task implementation plan
        └── 2026-04-13-delegation-pivot.md                   Pivot from prepaid → delegation
```

The `superpowers/` files are the design history — read them when you need to understand *why* something looks the way it does. The `PHASE3.md` is the synthesized current-state handbook.

---

## Configuration / infrastructure

```
├── .env.example                    Top-level env example (copy to packages/backend/.env)
├── .github/workflows/
│   ├── build.yaml                  CI: tests + builds + Docker image
│   └── deploy.yaml                 CD: Cloud Run deploy
├── deploy/
│   ├── docker-compose.yaml         Local staging stack
│   └── Caddyfile                   Edge proxy reference
├── scripts/
│   ├── smoke.sh                    Backend smoke harness (Tier 1 integration)
│   └── sdk-roundtrip.ts            SDK round-trip integration test
└── pnpm-workspace.yaml             Lists packages/* as workspace members
```

---

## "Where do I look to change X?"

| If you want to... | Look at |
|---|---|
| Change premium math | `programs/pact-insurance/src/instructions/settle_premium.rs` |
| Change refund cap math | `programs/pact-insurance/src/instructions/submit_claim.rs` |
| Add a new safety floor | `programs/pact-insurance/src/constants.rs` + the relevant `update_config` check |
| Add a new instruction | `programs/pact-insurance/src/instructions/<new>.rs` + register in `mod.rs` + dispatch in `lib.rs` |
| Add a new backend route | `packages/backend/src/routes/<new>.ts` + register in `index.ts` |
| Change crank cadence | `packages/backend/src/crank/index.ts` (CRANK_INTERVAL_MS env var) |
| Add a new SDK event | `packages/monitor/src/wrapper.ts` (extend EventEmitter usage) |
| Add a new scorecard page | `packages/scorecard/src/components/<New>.tsx` + route in `App.tsx` |
| Change deployed program ID | `programs/pact-insurance/src/lib.rs` (`declare_id!`) + `Anchor.toml` |
| Update DB schema | `packages/backend/src/schema.sql` (idempotent IF NOT EXISTS only) |
| Add a new test fixture | `packages/program/test-utils/setup.ts` |

---

## Reading order if you're new

1. **`README.md`** — what is this product
2. **`docs/PHASE3.md`** — how Phase 3 works (architecture + runbook)
3. **This file** — file-tree reference
4. **`packages/program/programs/pact-insurance/src/lib.rs`** — the entry point of every on-chain instruction
5. **`packages/program/tests/protocol.ts`** — first test file, easy to follow
6. **`packages/backend/src/index.ts`** — backend wiring
7. **`packages/backend/src/crank/premium-settler.ts`** — see the on-chain client in action from Node.js
8. **`packages/insurance/src/client.ts`** — see the agent SDK side
9. **`packages/scorecard/src/components/PoolDetail.tsx`** — see the UI consume the chain data

That's a half-day onboarding loop and you'll have the whole stack in your head.
