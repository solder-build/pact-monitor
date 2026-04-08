# Pact Network

Pact Network is a parametric micro-insurance system for AI agent API payments on Solana. It monitors API provider reliability in real-time, computes actuarially-derived insurance rates from observed failure data, and publishes those rates on a public scorecard. The insurance rate is the product — everything else exists to make that number real, accurate, and public.

## Tech Stack

- **Language:** TypeScript (all packages)
- **Backend:** Fastify (API server), PostgreSQL (database)
- **Scorecard:** Vite + React + Tailwind CSS + Recharts (SPA dashboard)
- **SDK:** Wraps fetch(), JSON file local storage, x402/MPP header extraction
- **Deployment:** Docker Compose + Caddy (same-origin on pactnetwork.io)

## Monorepo Structure

```
packages/
  sdk/        — @pact-network/monitor: TypeScript SDK wrapping fetch() to monitor API reliability
  backend/    — @pact-network/backend: Fastify API server aggregating monitoring data
  scorecard/  — @pact-network/scorecard: Vite+React dashboard showing provider reliability rankings
deploy/       — Docker Compose + Caddyfile
docs/         — PRD, design spec, implementation plan
```

## Design System

- **Background:** #151311 (dark)
- **Copper:** #B87333 (financial values, insurance rates)
- **Burnt Sienna:** #C9553D (failures, violations, HIGH RISK)
- **Slate:** #5A6B7A (healthy, RELIABLE states)
- **Fonts:** Inria Serif (headlines), Inria Sans (body), JetBrains Mono (data)
- **Aesthetic:** Brutalist — zero/minimal border radius, no gradients, no emojis in code or UI

## Build & Run

```bash
# Install all workspace dependencies
npm install

# SDK
cd packages/sdk && npm run build

# Backend (needs PostgreSQL running)
cd packages/backend && npm run dev

# Scorecard
cd packages/scorecard && npm run dev

# Seed data
cd packages/backend && npm run seed

# Generate API key
cd packages/backend && npm run generate-key <label>
```

## API Endpoints

- `POST /api/v1/records` — batch ingest call records (authenticated)
- `GET /api/v1/providers` — list all providers ranked by insurance rate (public)
- `GET /api/v1/providers/:id` — provider detail with percentiles and breakdown (public)
- `GET /api/v1/providers/:id/timeseries` — failure rate over time (public)
- `GET /health` — server health check

## Conventions

- No emojis in code or UI
- All technical decisions are Alan's (the developer)
- Deadline: April 12, 2026 (Colosseum hackathon)
