# Tracking and Simulated Claims Layer

Design spec for adding product tracking (SDK request volume, claims) and a simulated claims system to Pact Network.

**Date:** 2026-04-09
**Author:** Alan (Engineering), Rick (Product)
**Status:** Draft
**Deadline:** April 12, 2026 (Colosseum hackathon)

## Context

Rick wants tracking added to pact-network: how many requests were made using the SDK and how many claims happened. The system should be an in-house solution before considering PostHog.

The whitepaper describes the Pact SDK as handling "SLA monitoring, premium deduction, and automatic claim submission." Phases 1-2 (current scope) cover monitoring and the scorecard. Premium deduction, on-chain claims, and refund settlement are Phase 3. This design bridges the gap by simulating the claims layer off-chain so that:

1. Rick gets real product tracking numbers for SDK requests and claims.
2. Hackathon judges see a tangible claim flow ("API failed, Pact detected it, computed a $0.47 refund").
3. The schema is SC-ready — when the Solana program arrives in Phase 3, nullable fields get populated and status transitions from "simulated" to "settled."

## Approach

**Approach B: Simulated Claims Layer** was selected over:

- **A (Analytics-Only):** SQL aggregations on existing `call_records`. No new tables. Fastest but no formal claim objects, nothing demo-able, no Phase 3 foundation.
- **C (Full Event Tracking):** Everything in B plus generic telemetry. Overkill for 3 days remaining.

## Data Model

### New table: `claims`

```sql
CREATE TABLE claims (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_record_id  UUID NOT NULL REFERENCES call_records(id),
  provider_id     UUID NOT NULL REFERENCES providers(id),
  agent_id        TEXT,
  policy_id       TEXT,                -- null now, links to on-chain policy PDA in Phase 3
  trigger_type    TEXT NOT NULL,        -- 'timeout', 'error', 'schema_mismatch', 'latency_sla'
  call_cost       BIGINT,              -- original payment amount from call_record
  refund_pct      INTEGER NOT NULL,    -- 100, 75, or 50 per whitepaper parametric rules
  refund_amount   BIGINT,              -- call_cost * refund_pct / 100
  status          TEXT NOT NULL DEFAULT 'simulated',
  tx_hash         TEXT,                -- null now, Solana settlement tx in Phase 3
  settlement_slot BIGINT,              -- null now, Solana slot in Phase 3
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_claims_provider_id ON claims(provider_id);
CREATE INDEX idx_claims_agent_id ON claims(agent_id);
CREATE INDEX idx_claims_status ON claims(status);
CREATE INDEX idx_claims_created_at ON claims(created_at);
```

### Parametric trigger mapping (from whitepaper Section 3.2)

| call_record.classification | trigger_type    | refund_pct |
|---------------------------|-----------------|------------|
| `timeout`                 | timeout         | 100        |
| `error`                   | error           | 100        |
| `schema_mismatch`         | schema_mismatch | 75         |
| latency > SLA threshold   | latency_sla     | 50         |

**Note on `latency_sla`:** The current SDK classifier maps latency breaches to `timeout` (100% refund). A distinct `latency_sla` trigger (50% refund, for slow-but-complete responses) requires a classifier update to distinguish "no response" from "slow response." For Phase 1-2, this trigger type won't fire — claims use the three existing classifications. `latency_sla` becomes active when the classifier is refined in a future phase.

### Claim qualification rule

A claim is created **only** when a `call_record` has:
- `classification != 'success'` AND
- `payment_amount IS NOT NULL` AND `payment_amount > 0`

No payment = no claim. The agent didn't pay, so there's nothing to refund.

### Status lifecycle

```
detected → simulated       (Phase 1-2: off-chain only)
detected → submitted → settled   (Phase 3: on-chain settlement)
```

- `detected`: parametric trigger fired, claim record created
- `simulated`: refund computed but no on-chain action (current behavior)
- `submitted`: claim submitted to Solana program (Phase 3)
- `settled`: refund USDC transferred, tx_hash populated (Phase 3)

### SC-ready fields

| Field             | Now  | Phase 3                          |
|-------------------|------|----------------------------------|
| `policy_id`       | null | links to on-chain policy PDA     |
| `tx_hash`         | null | Solana settlement transaction    |
| `settlement_slot` | null | Solana slot number               |
| `status`          | simulated | submitted / settled          |

### No changes to existing tables

`call_records`, `providers`, and `api_keys` remain unchanged.

## API Endpoints

### New endpoints (public, no auth required)

#### `GET /api/v1/analytics/summary`

Network-wide aggregate stats.

**Response:**
```json
{
  "total_sdk_requests": 124500,
  "total_claims": 342,
  "total_claim_amount": 18400,
  "total_refund_amount": 15200,
  "claims_by_trigger": {
    "timeout": 180,
    "error": 95,
    "schema_mismatch": 42,
    "latency_sla": 25
  },
  "unique_agents": 18,
  "unique_providers": 7
}
```

- `total_claim_amount`: sum of `call_cost` across all claims (what agents paid for failed calls)
- `total_refund_amount`: sum of `refund_amount` across all claims (what agents would receive back)

#### `GET /api/v1/analytics/timeseries`

Requests and claims over time.

**Query params:**
- `granularity`: `hourly` (default) or `daily`
- `days`: number of days to look back (default: 7)

**Response:**
```json
{
  "granularity": "hourly",
  "data": [
    {
      "bucket": "2026-04-09T14:00:00Z",
      "requests": 520,
      "claims": 12,
      "refund_amount": 840
    }
  ]
}
```

#### `GET /api/v1/claims`

List individual claim records.

**Query params:**
- `provider_id`: filter by provider (optional)
- `agent_id`: filter by agent (optional)
- `trigger_type`: filter by trigger type (optional)
- `limit`: max results (default: 50, max: 200)
- `offset`: pagination offset (default: 0)

**Response:** Array of claim objects with provider name and trigger details.

### Modified endpoint (internal behavior only)

#### `POST /api/v1/records`

No API contract change. After inserting each `call_record`, if the record qualifies (failure + payment), the backend auto-creates a corresponding `claims` row. The response remains `{ accepted, provider_ids }`.

## Scorecard UI

A **"Network Activity"** section on the existing scorecard dashboard. Not a separate page — a panel above or below the provider ranking table.

### Content

- **Total SDK Requests** — large number, JetBrains Mono
- **Total Claims Triggered** — large number, copper (#B87333)
- **Total Refund Amount** — copper, formatted as USDC value
- **Claims by Trigger Type** — small breakdown (counts per type)
- **7-day Sparkline** — mini-chart showing requests vs claims over time

### Design

Follows existing design system:
- Dark background (#151311)
- Copper (#B87333) for financial values and claim amounts
- Burnt sienna (#C9553D) for failure-related labels
- Slate (#5A6B7A) for healthy/neutral states
- Inria Serif headings, Inria Sans body, JetBrains Mono data
- Zero border radius, no gradients, no emojis

## Seed Script Update

The existing seed script in `packages/backend/src/scripts/` generates `call_records`. It needs to:

- Ensure a realistic proportion of seeded failure records have `payment_amount` set (so claims get auto-generated during ingestion)
- No separate claim seeding logic needed — claims are created by the backend's ingestion path

## Architecture Flow

```
Agent SDK
    │
    ▼
POST /api/v1/records → Backend ingests call_records
                            │
                            ▼ (failure + payment?)
                        Creates claim row in claims table
                            │
                            ▼
         GET /api/v1/analytics/*  ◄── Scorecard dashboard
         GET /api/v1/claims
```

## Phase 3 Notes (for future reference)

When the Solana program is built, the on-chain settlement will need proof that an API call actually failed. The on-chain program cannot make HTTP requests, so a bridging mechanism is required. Options explored during brainstorming:

1. **Multi-observer attestation** (whitepaper approach): Independent verifier nodes cross-check agent-reported failures. N-of-M verifiers sign attestations submitted on-chain.
2. **zkTLS / TLS Notary**: Cryptographic proof of HTTP response status. Most trustless, most complex.
3. **Optimistic claims**: Agent submits evidence, refund assumed valid after dispute window. Cheapest on-chain.
4. **Trusted oracle**: Pact backend attests to failures from its monitoring data. Centralized but simplest for early mainnet.

The claims table schema supports all of these — `policy_id`, `tx_hash`, `settlement_slot`, and `status` transitions are ready for whichever proof mechanism is chosen.

## Out of Scope

- On-chain Solana program, smart contracts, or token operations
- Premium deduction or payment processing in the SDK
- Self-service agent registration or policy management
- PostHog or third-party analytics integration
- Mobile-optimized UI
