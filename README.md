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
  sdk/        @pact-network/monitor   TypeScript SDK wrapping fetch()
  backend/    @pact-network/backend   Fastify API server + PostgreSQL
  scorecard/  @pact-network/scorecard Vite + React + Tailwind dashboard
deploy/       Docker Compose + Caddyfile (production)
docs/         PRD, design spec, implementation plan
scripts/      Setup automation
```

## Tech Stack

| Layer     | Technology                              |
| --------- | --------------------------------------- |
| Language  | TypeScript (strict, ES2022)             |
| Backend   | Fastify 5, PostgreSQL 16, pg            |
| Frontend  | React 19, Vite 6, Tailwind CSS, Recharts |
| SDK       | Zero dependencies, wraps native fetch() |
| Deploy    | Docker Compose, Caddy (reverse proxy)   |
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
| GET    | `/api/v1/providers/:id`           | Public   | Provider detail with percentiles     |
| GET    | `/api/v1/providers/:id/timeseries`| Public   | Failure rate over time (hourly/daily)|
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

The `deploy/` directory contains the production stack:

- **docker-compose.yml** runs PostgreSQL, backend, scorecard, and Caddy
- **Caddyfile** routes `/api/*` to the backend and everything else to the SPA
- HTTPS is auto-provisioned via Let's Encrypt

```bash
cd deploy
docker compose up -d
```

Production runs on [pactnetwork.io](https://pactnetwork.io) with same-origin routing (no CORS needed).

## Design

Brutalist aesthetic. No gradients, no rounded corners, no emojis.

- **Background:** #151311
- **Copper:** #B87333 (financial values, insurance rates)
- **Burnt Sienna:** #C9553D (failures, violations, HIGH RISK)
- **Slate:** #5A6B7A (healthy, RELIABLE)
- **Fonts:** Inria Serif (headlines), Inria Sans (body), JetBrains Mono (data)

## License

Proprietary. All rights reserved.
