# Anti-Fraud System Design

**Date:** April 16, 2026
**Status:** Approved (revised after Rick's feedback)
**Approach:** Economic penalties + rate limiting + record signing (no hard gates, no multisig)

---

## Problem

Two fraud vectors threaten the insurance pool:

1. **Spam attack**: An agent discovers a failing API provider and floods it with requests to farm refunds. Current rate limiting is zero.
2. **Self-dealing**: An attacker creates a fake API that always fails, registers agents against it, and drains the pool via fabricated claims. Providers are auto-created from any hostname with no vetting.

The security audit (see `docs/SECURITY-AUDIT-2026-04-16.md`) identified these as the highest-risk economic attacks, with 9 CRITICAL and 19 HIGH findings across the full stack.

## Design Principles

Based on Rick's feedback:
- **No hard gates** that block customer onboarding (no manual provider approval required)
- **Economic incentives** do the heavy lifting -- cheating must be unprofitable, not just forbidden
- **Minimal UX friction** -- agents set up once, no popups, no extra steps per call
- **Monitor first, tune later** -- start with generous limits, tighten based on real data

---

## Architecture Overview

```
SDK                        Backend                         Admin UI
+-------------------+      +---------------------------+   +------------------+
| Sign record batch |----->| Verify signature          |   | Flag review      |
| with agent keypair|      | Rate limit per-agent      |   | Agent management |
+-------------------+      | Anomaly detection         |   +------------------+
                           | Premium penalty calculator |          |
                           | Outage vs fraud detection  |          v
                           +---------------------------+   GET /admin/flags
                                      |
                                      v
                           Suspicious agents:
                           - Premium increased
                           - Claims frozen if flagged
```

---

## Section 1: Dynamic Premium Penalty

The core anti-fraud mechanism. Instead of blocking providers or agents, make cheating economically unprofitable by increasing premiums for suspicious claiming patterns.

### How It Works

Each agent has a **claims loading factor** per provider that multiplies their insurance premium:

```
effective_rate = base_insurance_rate * claims_loading_factor
```

The loading factor starts at 1.0 (no penalty) and increases when an agent's claiming behavior is anomalous.

### Calculating the Loading Factor

After each record batch, compare the agent's failure rate against the network:

```sql
-- Agent's failure rate for this provider in last 24h
WITH agent_stats AS (
  SELECT
    COUNT(*) FILTER (WHERE classification != 'success') * 100.0 / NULLIF(COUNT(*), 0) AS agent_failure_rate
  FROM call_records
  WHERE agent_id = $1 AND provider_id = $2 AND created_at > NOW() - INTERVAL '24 hours'
),
-- Network-wide failure rate for this provider in last 24h
network_stats AS (
  SELECT
    COUNT(*) FILTER (WHERE classification != 'success') * 100.0 / NULLIF(COUNT(*), 0) AS network_failure_rate
  FROM call_records
  WHERE provider_id = $2 AND created_at > NOW() - INTERVAL '24 hours'
)
SELECT agent_failure_rate, network_failure_rate
FROM agent_stats, network_stats;
```

**Loading factor rules:**
- Agent failure rate <= 2x network average: `factor = 1.0` (no penalty)
- Agent failure rate 2x-5x network average: `factor = 1.5` (50% premium increase)
- Agent failure rate > 5x network average: `factor = 2.5` (150% premium increase) + flag for review

### Outage Detection (Sybil Protection)

Before applying a penalty, check if this is a genuine provider outage:

```sql
-- Count distinct agents with 7+ days history reporting failures for this provider in last hour
SELECT COUNT(DISTINCT agent_id)
FROM call_records cr
JOIN api_keys ak ON cr.agent_id = ak.label
WHERE cr.provider_id = $1
  AND cr.classification != 'success'
  AND cr.created_at > NOW() - INTERVAL '1 hour'
  AND ak.created_at < NOW() - INTERVAL '7 days'
```

**Outage threshold:** If **5+ established agents** (each with 7+ days history) report failures for the same provider in the same hour, classify as **real outage**. No premium penalty applied to any agent for that provider during the outage window.

Why 5 agents with 7 days history: An attacker would need to maintain 5+ agents for a week, paying premiums the whole time, before they could attempt a sybil attack. The economic cost makes it unprofitable.

### Schema Change

```sql
-- Per-agent-per-provider premium loading
CREATE TABLE premium_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id TEXT NOT NULL,
  provider_id UUID NOT NULL REFERENCES providers(id),
  loading_factor NUMERIC(4,2) NOT NULL DEFAULT 1.0,
  reason TEXT,                    -- 'elevated_failure_rate', 'outage_exempt', etc.
  calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(agent_id, provider_id)
);

-- Outage events for audit trail
CREATE TABLE outage_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID NOT NULL REFERENCES providers(id),
  reporting_agents INTEGER NOT NULL,   -- how many agents reported
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  network_failure_rate NUMERIC(5,2)
);
```

### Integration with Insurance Rate

In `packages/backend/src/utils/insurance.ts`, the rate calculation becomes:

```typescript
function getEffectiveRate(baseRate: number, agentId: string, providerId: string): number {
  const adjustment = await getOne(
    "SELECT loading_factor FROM premium_adjustments WHERE agent_id = $1 AND provider_id = $2",
    [agentId, providerId]
  );
  const factor = adjustment?.loading_factor ?? 1.0;
  return baseRate * factor;
}
```

The on-chain rate stays the same (base rate). The loading factor is applied at the backend level when calculating what the agent actually pays. This avoids a program upgrade.

---

## Section 2: Rate Limiting

Wide limits to prevent brute-force attacks without blocking real usage. Monitor and adjust based on real data.

### Request-Level Limits

On `POST /api/v1/records`:
- **Batch size cap**: Max 500 records per request. Reject with 400 if exceeded.
- **Per-key hourly cap**: Max 10,000 records per hour per API key. In-memory map with hourly reset, same pattern as faucet's `ipHits`. Reject with 429 when exceeded.

### Claim-Level Limits

In `maybeCreateClaim()`:
- **Per-agent daily cap**: Max 1,000 claims per day per agent.
- Check: `SELECT COUNT(*) FROM claims WHERE agent_id = $1 AND created_at > NOW() - INTERVAL '1 day'`
- If exceeded, skip claim creation silently (record is still stored).

### Monitoring

Log a warning when any agent reaches 80% of any limit. This gives early signal for admin review.

### Implementation

Use in-memory counters (Map<string, { count, resetAt }>) for the hourly record cap. The claim cap queries the database directly since it's checked per-claim, not per-request.

---

## Section 3: Call Record Signing

One-time keypair setup, invisible per-call. Prevents record spoofing and agent impersonation.

### SDK Changes (packages/sdk/)

**Config interface** (`types.ts`):
```typescript
interface PactConfig {
  // ... existing fields ...
  keypair?: { publicKey: Uint8Array; secretKey: Uint8Array }; // Ed25519 keypair
}
```

- Optional for backwards compatibility
- Required when `syncEnabled: true` (throw at init if missing)
- Agent pubkey derived from keypair must match `agentPubkey` config field

**Sync changes** (`sync.ts`):
In `doFlush()`, before POST:
1. Serialize the records batch to deterministic JSON (sorted keys)
2. SHA-256 hash the serialized payload
3. Sign hash with `nacl.sign.detached(hash, keypair.secretKey)`
4. Encode signature as base64
5. Add headers:
   - `X-Pact-Signature: <base64 signature>`
   - `X-Pact-Pubkey: <base58 pubkey>`

### Backend Changes (packages/backend/)

**New middleware** `verifyRecordSignature` on `POST /api/v1/records`:
1. Extract `X-Pact-Signature` and `X-Pact-Pubkey` headers
2. If headers missing:
   - During grace period: accept with deprecation warning in response. Grace period controlled by env var `REQUIRE_RECORD_SIGNATURES=false` (default). Set to `true` to enforce.
   - After grace period (env var flipped): reject with 401
3. Verify `X-Pact-Pubkey` matches `agentPubkey` from authenticated API key
4. Reconstruct SHA-256 hash from request body
5. Verify Ed25519 signature: `nacl.sign.detached.verify(hash, signature, pubkey)`
6. Reject with `401: Invalid record signature` if verification fails

### What Gets Signed

The full `records` JSON array. This proves:
- The agent actually submitted these exact records
- Records can't be modified in transit
- An attacker can't forge records on behalf of another agent

### Dependencies

- SDK: `tweetnacl` (already used in Solana ecosystem, zero additional deps)
- Backend: `tweetnacl` or `@solana/web3.js` (already a dependency) for Ed25519 verification

---

## Section 4: Anomaly Detection and Flagging

Automated detection of suspicious patterns. Flags freeze claims pending admin review.

### Agent Flagging

After each record batch is processed, run lightweight checks:

**Failure rate spike** (triggers premium penalty + flag):
- Agent failure rate > 5x network average for same provider = flag
- This is the same check that drives the premium loading factor in Section 1

**Volume spike**:
- Agent's record count in last hour > 10x their 7-day hourly average = flag

### Storage

```sql
CREATE TABLE agent_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id TEXT NOT NULL,
  agent_pubkey TEXT,
  flag_reason TEXT NOT NULL,       -- 'failure_rate_spike', 'volume_spike'
  flag_data JSONB,                 -- context: rates, counts, thresholds
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'dismissed', 'suspended')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT
);
```

### Effect of Flagging

- Flagged agents' claims stay in `simulated` status (no on-chain settlement)
- Record ingestion continues (within rate limits) so we maintain visibility
- Premium loading factor set to maximum (2.5x)
- Admin must review and either dismiss the flag or suspend the agent

### Admin Endpoints

**`GET /api/v1/admin/flags`**
- Returns flagged agents with: agent_id, flag_reason, flag_data, status, created_at
- Query params: `?status=pending|dismissed|suspended`

**`PATCH /api/v1/admin/flags/:id`**
- Body: `{ status: 'dismissed' | 'suspended' }`
- If suspended: disable the agent's API key
- If dismissed: reset premium loading factor to 1.0
- Guarded by `requireAdmin`

---

## Section 5: Admin Dashboard UI

Minimal additions to the existing admin page. No complex flows.

### Flagged Agents Tab

Location: `/admin?tab=flags` (tab within existing admin page)

**Components**:
- Badge count in tab header showing unreviewed (pending) flags
- Flag table: agent_id, flag_reason, loading_factor, flagged_at, record_count_24h, claim_count_24h
- Each row: "Dismiss" and "Suspend" action buttons
- Suspended agents shown in grey with timestamp

### Navigation

Add tab bar to AdminDashboard component:
- Overview (existing dashboard content, default)
- Flags (new)

### Design System

Follows existing scorecard conventions:
- Background: #151311
- Copper (#B87333): financial values, loading factors
- Burnt Sienna (#C9553D): flags, suspended state, warning badges
- Slate (#5A6B7A): healthy/dismissed indicators
- JetBrains Mono: data tables
- Inria Sans: labels and body text
- Zero border radius (brutalist aesthetic)

---

## Files Changed

### Modified Files

| File | Change |
|------|--------|
| `packages/backend/src/schema.sql` | Add `premium_adjustments`, `outage_events`, `agent_flags` tables |
| `packages/backend/src/routes/records.ts` | Rate limiting, anomaly detection trigger, premium calculation |
| `packages/backend/src/routes/admin.ts` | Flags CRUD endpoints |
| `packages/backend/src/utils/claims.ts` | Daily claim cap check, skip if agent flagged |
| `packages/backend/src/utils/insurance.ts` | Loading factor integration in rate calculation |
| `packages/backend/src/middleware/auth.ts` | Signature verification middleware |
| `packages/sdk/src/types.ts` | Add `keypair` to PactConfig |
| `packages/sdk/src/sync.ts` | Sign record batches before POST |
| `packages/sdk/src/wrapper.ts` | Validate keypair at init |
| `packages/scorecard/src/components/AdminDashboard.tsx` | Tab navigation, flags table |
| `packages/scorecard/src/api/admin-client.ts` | New admin API functions for flags |

---

## Out of Scope (Future Work)

- On-chain provider registry
- Provider staking / collateral
- Multisig oracle for claim settlement
- Slack/email alert notifications
- Server-side classification re-computation
- Hard provider whitelist (replaced by economic penalties)

---

## Success Criteria

1. Agents with anomalous failure rates automatically get increased premiums (loading factor > 1.0)
2. Real outages detected by 5+ established agents are exempt from premium penalties
3. An agent cannot submit more than 500 records per request or 10,000 per hour
4. An agent cannot generate more than 1,000 claims per day
5. Record batches without valid Ed25519 signatures are rejected (after grace period)
6. Flagged agents' claims are frozen until admin reviews
7. Admin can review and resolve flags from the dashboard
