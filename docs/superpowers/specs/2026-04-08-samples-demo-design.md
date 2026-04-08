# Pact Network Samples & Demo — Design Spec

> v1.0 | 2026-04-08
> Branch: feature/samples (from develop)

## Overview

Three sample packages demonstrating Pact Monitor usage: a hackathon demo script, a browser-based playground, and copy-paste integration examples for developers.

## Structure

```
samples/
  demo/                     — Hackathon demo script
    monitor.ts              — Main script: calls real APIs through SDK
    .env.example            — Optional API keys for Helius, QuickNode
    README.md
  playground/               — Browser-based monitor playground
    index.html              — Standalone SPA (no build step)
    style.css               — Pact design system theme
    README.md
  agent-integration/        — Copy-paste examples for developers
    basic.ts                — Minimal 10-line integration
    with-schema-validation.ts — Expected schema checking
    with-x402.ts            — Monitoring alongside x402 payments
    README.md
  README.md                 — Overview listing all samples
```

## 1. Demo Script (`samples/demo/`)

### Purpose

Run during the 3-minute hackathon presentation while the scorecard is open. Shows live data flowing through the pipeline: agent calls API → SDK records → backend ingests → scorecard updates.

### Behavior

- Calls 4-5 real Solana ecosystem APIs through `monitor.fetch()`
- **Free (no key needed):** CoinGecko `/api/v3/simple/price`, DexScreener `/latest/dex/tokens`
- **Optional (key required):** Helius `/v0/addresses`, QuickNode `/getBalance`, Jupiter `/v6/quote`
- Skips APIs whose keys aren't set in `.env` (logs: "Skipping Helius — no API key configured")
- Runs in a loop: calls each provider once per round, configurable rounds (default: 5)
- Prints live terminal output per call: provider, endpoint, status, latency, classification
- Syncs to backend after each round (syncIntervalMs: 5000 for demo speed)
- Prints summary at end: total calls, failures, avg latency by provider

### .env.example

```env
# Required
PACT_API_KEY=pact_your_key_here
PACT_BACKEND_URL=http://localhost:3001

# Optional — skip if not available
HELIUS_API_KEY=
QUICKNODE_RPC_URL=
```

### Run

```bash
cd samples/demo
cp .env.example .env
# Edit .env with your keys
pnpm tsx monitor.ts
```

## 2. Playground (`samples/playground/`)

### Purpose

A browser-based tool where you paste a URL, click "Monitor", and see the result — status, latency, classification, payment data. Calls appear on the scorecard in real-time.

### Architecture

- Standalone HTML page, no build step. Open `index.html` directly or serve from any static server.
- Calls a new backend endpoint: `POST /api/v1/monitor`
- Backend receives the URL, calls it through the SDK, returns the call record to the browser
- The call record is also stored in the database (like any SDK call)

### New Backend Endpoint

`POST /api/v1/monitor` (authenticated — requires API key)

Request:
```json
{
  "url": "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
  "method": "GET"
}
```

Response:
```json
{
  "status_code": 200,
  "latency_ms": 234,
  "classification": "success",
  "provider": "api.coingecko.com",
  "payment": null
}
```

### UI

- Dark background (#151311), copper accents (#B87333)
- Fonts: Inria Serif (title), Inria Sans (labels), JetBrains Mono (data)
- Input: URL text field + method dropdown (GET/POST) + "Monitor" button
- Result card: status code, latency, classification, payment protocol (if detected)
- History list below: last 20 calls with timestamp, provider, status, latency
- Link to scorecard: "View on Scorecard →"

### Design Rules

- Zero border radius (brutalist)
- No emojis, no gradients
- Classification colors: success=#5A6B7A, timeout=#B87333, error=#C9553D, schema_mismatch=#C9553D

## 3. Agent Integration Examples (`samples/agent-integration/`)

### `basic.ts` — Minimal Integration

```typescript
import { pactMonitor } from '@pact-network/monitor'

const monitor = pactMonitor({
  apiKey: process.env.PACT_API_KEY,
  backendUrl: process.env.PACT_BACKEND_URL || 'http://localhost:3001',
  syncEnabled: true,
})

// Replace fetch() with monitor.fetch() — same API, now monitored
const res = await monitor.fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd')
const data = await res.json()
console.log('Price:', data.solana.usd)
console.log('Stats:', monitor.getStats())

monitor.shutdown()
```

### `with-schema-validation.ts` — Schema Checking

Shows how to detect API responses that return 200 but have unexpected body structure. Uses `expectedSchema` option on `monitor.fetch()`.

### `with-x402.ts` — x402 Payment Monitoring

Shows monitoring alongside a paid API call. Uses `usdcAmount` manual override since we're not making real x402 payments in the example. Demonstrates how payment data appears in the call record.

## Backend Changes

One new endpoint added to `packages/backend/`:

### `POST /api/v1/monitor`

- File: `packages/backend/src/routes/monitor.ts`
- Authenticated (requires API key, same as POST /records)
- Receives a URL + method
- Uses the SDK internally to call the URL through `monitor.fetch()`
- Records the call in the database
- Returns the call record to the caller

This is ~30 lines of code. Registered alongside existing routes in `index.ts`.

## What's NOT in Scope

- WebSocket/SSE for live playground updates (polling the scorecard is enough)
- Running the playground as a deployed service (local dev tool only)
- Real x402 payment examples (would need actual USDC — manual override is fine)
- npm publishing of the SDK (git install path for now)
