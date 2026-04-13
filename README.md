# Pact Network

Parametric micro-insurance for AI agent API payments on Solana. Pact Network monitors API provider reliability in real-time, computes actuarially-derived insurance rates from observed failure data, and publishes those rates on a public scorecard. The insurance rate is the product.

## How It Works

1. **SDK** wraps `fetch()` in your AI agent, recording every API call (latency, status, payment headers)
2. **Backend** ingests call records, aggregates failure rates, and computes insurance pricing per provider
3. **Scorecard** displays a public, ranked dashboard of provider reliability and insurance rates

Insurance rate formula: `max(0.001, failureRate * 1.5 + 0.001)`

Provider tiers:
- **RELIABLE** — failure rate < 1%
- **ELEVATED** — failure rate 1%--5%
- **HIGH RISK** — failure rate > 5%

## Monorepo Structure

```
packages/
  sdk/        @pact-network/monitor    TypeScript SDK wrapping fetch()
  insurance/  @pact-network/insurance  Agent-side SDK for on-chain policies (Phase 3)
  backend/    @pact-network/backend    Fastify API server + PostgreSQL + Solana crank
  scorecard/  @pact-network/scorecard  Vite + React + Tailwind dashboard
  program/                             Anchor program (Solana on-chain insurance)
deploy/                                Docker Compose + GCP deployment configs
docs/                                  PRD, design spec, Phase 3 implementation plan
scripts/                               Setup automation
```

## Tech Stack

| Layer     | Technology                              |
| --------- | --------------------------------------- |
| Language  | TypeScript (strict, ES2022)             |
| Backend   | Fastify 5, PostgreSQL 16, pg            |
| Frontend  | React 19, Vite 6, Tailwind CSS, Recharts |
| SDK       | Zero dependencies, wraps native fetch() |
| Deploy    | Docker, GCP Cloud Run, GCR              |
| Tooling   | pnpm workspaces, tsx                    |

## Quick Start

Prerequisites: Node.js 20+, pnpm, Docker.

```bash
# One-command setup: install deps, start PostgreSQL, create .env, generate API key, seed data
pnpm run setup
```

Then start the dev servers:

```bash
pnpm dev:backend      # API server on port 3001
pnpm dev:scorecard    # Dashboard on port 5173
```

Open http://localhost:5173 to see the scorecard.

### Manual Setup

```bash
pnpm install

# Start PostgreSQL (port 5433)
pnpm run db:up

# Copy environment config
cp .env.example packages/backend/.env

# Generate an API key
pnpm run generate-key dev-agent

# Seed with realistic data for 5 Solana providers
pnpm run seed

# Start servers
pnpm dev:backend
pnpm dev:scorecard
```

## SDK Usage

```typescript
import { pactMonitor } from "@pact-network/monitor";

const monitor = pactMonitor({
  backendUrl: "https://pactnetwork.io/api/v1",
  apiKey: "pact_...",
});

// Use monitor.fetch() as a drop-in replacement for fetch()
const response = await monitor.fetch("https://api.helius.xyz/v0/...", {
  method: "POST",
  body: JSON.stringify({ jsonrpc: "2.0", method: "getBalance", params: [...] }),
});
```

The SDK silently records call metadata (latency, status, failure classification) and syncs it to the backend. If the monitor fails for any reason, the underlying API call still succeeds.

The SDK extracts x402/MPP payment headers when present, capturing payment data alongside reliability metrics.

## API Endpoints

| Method | Path                              | Auth     | Description                          |
| ------ | --------------------------------- | -------- | ------------------------------------ |
| POST   | `/api/v1/records`                 | Required | Batch ingest call records            |
| GET    | `/api/v1/providers`               | Public   | Ranked provider list with rates      |
| GET    | `/api/v1/providers/:id`           | Public   | Provider detail (incl. `hostname`)   |
| GET    | `/api/v1/providers/:id/timeseries`| Public   | Failure rate over time (hourly/daily)|
| GET    | `/api/v1/pools`                   | Public   | On-chain coverage pools (Phase 3)    |
| GET    | `/api/v1/pools/:hostname`         | Public   | Pool detail + positions + claims     |
| POST   | `/api/v1/claims/submit`           | Internal | Submit a claim on-chain via oracle   |
| GET    | `/health`                         | Public   | Server health check                  |

Authentication uses Bearer tokens: `Authorization: Bearer pact_...`

## Scripts

```bash
pnpm run setup          # Full dev environment setup
pnpm dev:backend        # Start backend in watch mode
pnpm dev:scorecard      # Start scorecard dev server
pnpm build              # Build all packages
pnpm test               # Run all tests (SDK + backend)
pnpm run seed           # Re-seed the database
pnpm run generate-key <label>  # Generate a new API key
pnpm run db:up          # Start PostgreSQL container
pnpm run db:down        # Stop PostgreSQL container
pnpm run db:reset       # Reset database (destroy + recreate)
```

## Testing

```bash
pnpm test               # All tests
pnpm test:sdk           # SDK unit tests (classifier, payment extraction, storage)
pnpm test:backend       # Backend tests (API routes, insurance formula)
```

## Production Deployment

Production services are containerized and deployed to **Google Cloud Platform**:

- **Container Registry (GCR)** hosts Docker images for the backend and scorecard
- **Cloud Run** runs the backend and scorecard as managed services
- **Cloud SQL (PostgreSQL 16)** for the production database

Each package has a Dockerfile for building production images. The `deploy/` directory contains orchestration configs for local staging and reference.

Production runs on [pactnetwork.io](https://pactnetwork.io).

## Design

Brutalist aesthetic. No gradients, no rounded corners, no emojis.

- **Background:** #151311
- **Copper:** #B87333 (financial values, insurance rates)
- **Burnt Sienna:** #C9553D (failures, violations, HIGH RISK)
- **Slate:** #5A6B7A (healthy, RELIABLE)
- **Fonts:** Inria Serif (headlines), Inria Sans (body), JetBrains Mono (data)

## Phase 3: On-Chain Insurance (Solana)

The Anchor program at `packages/program/` lifts the parametric insurance from a simulated DB row into a real on-chain market. See [`docs/PHASE3.md`](./docs/PHASE3.md) for the full design, devnet state, and operator runbook.

**Devnet program**: `4Z1Y3W49U2Cn6bz9UpkahVP7LaeobQ4cAaEt3uNaqSob`

**New here?** Read [`docs/STRUCTURE.md`](./docs/STRUCTURE.md) for a file-tree map of the whole monorepo, then [`docs/PHASE3.md`](./docs/PHASE3.md) for the architecture handbook.

**Highlights**:
- Per-provider `CoveragePool` PDAs with PDA-owned SPL token vaults
- Underwriters deposit USDC for yield; cooldown-enforced withdrawals
- **SPL token delegation** model — agents call `spl_token::approve` once and the protocol pulls premiums from their wallet per call. No prepaid balance, no upfront deposit.
- Backend crank (`packages/backend/src/crank/`) settles premiums and pushes rate updates
- Aggregate payout cap (default 30% / 24h) with hardcoded ceiling
- Auto-approved parametric claims with PDA-collision dedupe

## Roadmap

- **Multi-chain support** -- extend monitoring beyond Solana to EVM chains and cross-chain bridges
- **Agent-to-agent marketplace** -- allow AI agents to purchase insurance policies directly, settling in SOL or stablecoins
- **Historical analytics API** -- expose long-term provider reliability trends, seasonal patterns, and predictive risk scores
- **SDK plugins** -- framework-specific integrations (LangChain, CrewAI, AutoGPT) for zero-config monitoring
- **Webhook alerts** -- notify agent operators in real-time when provider reliability degrades past configurable thresholds
- **Provider self-service** -- allow API providers to register, view their own metrics, and dispute classifications

## License

Proprietary. All rights reserved.
