# Anti-Fraud System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Protect the insurance pool from spam attacks, self-dealing, and record forging through economic penalties, rate limiting, call record signing, and anomaly detection.

**Architecture:** Backend-first defense with SDK signing. Dynamic premium penalty (claims loading factor) makes cheating unprofitable instead of blocking customers. Anomaly detection flags suspicious agents for admin review. Rate limits provide hard caps as a safety net.

**Tech Stack:** TypeScript, Fastify, PostgreSQL, Node.js native test framework (`node:test`), `@solana/web3.js` for Ed25519 signing/verification, Vite+React for admin UI.

**Spec:** `docs/superpowers/specs/2026-04-16-anti-fraud-system-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/backend/src/schema.sql` | Modify | Add `premium_adjustments`, `outage_events`, `agent_flags` tables |
| `packages/backend/src/routes/records.ts` | Modify | Batch size cap, hourly rate limit, anomaly detection trigger |
| `packages/backend/src/routes/admin.ts` | Modify | Add flags CRUD endpoints |
| `packages/backend/src/utils/claims.ts` | Modify | Daily claim cap, skip if agent flagged |
| `packages/backend/src/utils/insurance.ts` | Modify | Loading factor integration |
| `packages/backend/src/utils/fraud-detection.ts` | Create | Anomaly detection, premium calculation, outage detection |
| `packages/backend/src/utils/fraud-detection.test.ts` | Create | Tests for fraud detection logic |
| `packages/backend/src/utils/rate-limiter.ts` | Create | In-memory per-key rate limiting |
| `packages/backend/src/utils/rate-limiter.test.ts` | Create | Tests for rate limiter |
| `packages/backend/src/middleware/auth.ts` | Modify | Add signature verification middleware |
| `packages/backend/src/middleware/auth.test.ts` | Create | Tests for signature verification |
| `packages/sdk/src/types.ts` | Modify | Add `keypair` to PactConfig |
| `packages/sdk/src/sync.ts` | Modify | Sign record batches before POST |
| `packages/sdk/src/wrapper.ts` | Modify | Validate keypair at init |
| `packages/sdk/src/signing.ts` | Create | Deterministic serialization + Ed25519 signing |
| `packages/sdk/src/signing.test.ts` | Create | Tests for signing module |
| `packages/scorecard/src/components/AdminDashboard.tsx` | Modify | Add tab navigation, flags tab |
| `packages/scorecard/src/api/admin-client.ts` | Modify | Add flags API functions |

---

### Task 1: Database Schema -- Anti-Fraud Tables

**Files:**
- Modify: `packages/backend/src/schema.sql:110` (append after claims indexes)

- [ ] **Step 1: Add premium_adjustments table to schema**

Add after the claims indexes block (after line 110) in `packages/backend/src/schema.sql`:

```sql
-- ============================================================
-- Anti-fraud: premium adjustments
-- ============================================================
CREATE TABLE IF NOT EXISTS premium_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id TEXT NOT NULL,
  provider_id UUID NOT NULL REFERENCES providers(id),
  loading_factor NUMERIC(4,2) NOT NULL DEFAULT 1.0,
  reason TEXT,
  calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(agent_id, provider_id)
);

-- ============================================================
-- Anti-fraud: outage events
-- ============================================================
CREATE TABLE IF NOT EXISTS outage_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID NOT NULL REFERENCES providers(id),
  reporting_agents INTEGER NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  network_failure_rate NUMERIC(5,2)
);

CREATE INDEX IF NOT EXISTS idx_outage_events_provider
  ON outage_events(provider_id, started_at);

-- ============================================================
-- Anti-fraud: agent flags
-- ============================================================
CREATE TABLE IF NOT EXISTS agent_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id TEXT NOT NULL,
  agent_pubkey TEXT,
  flag_reason TEXT NOT NULL,
  flag_data JSONB,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'dismissed', 'suspended')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_flags_agent
  ON agent_flags(agent_id, status);

CREATE INDEX IF NOT EXISTS idx_agent_flags_status
  ON agent_flags(status, created_at);
```

- [ ] **Step 2: Verify schema loads cleanly**

Run:
```bash
cd packages/backend && node -e "const fs = require('fs'); const sql = fs.readFileSync('src/schema.sql','utf8'); console.log('Schema length:', sql.length, 'bytes'); console.log('Tables:', (sql.match(/CREATE TABLE/g)||[]).length)"
```

Expected: Schema loads without parse errors, table count increased by 3.

- [ ] **Step 3: Commit**

```bash
git add packages/backend/src/schema.sql
git commit -m "$(cat <<'EOF'
feat: add anti-fraud database tables

Add premium_adjustments (per-agent-per-provider loading factors),
outage_events (audit trail), and agent_flags (anomaly flagging)
tables for the anti-fraud system.
EOF
)"
```

---

### Task 2: Rate Limiter Module

**Files:**
- Create: `packages/backend/src/utils/rate-limiter.ts`
- Create: `packages/backend/src/utils/rate-limiter.test.ts`

- [ ] **Step 1: Write failing tests for rate limiter**

Create `packages/backend/src/utils/rate-limiter.test.ts`:

```typescript
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter } from "./rate-limiter.js";

describe("RateLimiter", () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter({ maxPerWindow: 100, windowMs: 3600_000 });
  });

  it("allows requests under the limit", () => {
    const result = limiter.check("agent-1");
    assert.equal(result.allowed, true);
    assert.equal(result.remaining, 99);
  });

  it("tracks count across multiple calls", () => {
    for (let i = 0; i < 50; i++) {
      limiter.check("agent-1");
    }
    const result = limiter.check("agent-1");
    assert.equal(result.allowed, true);
    assert.equal(result.remaining, 49);
  });

  it("rejects when limit is reached", () => {
    for (let i = 0; i < 100; i++) {
      limiter.check("agent-1");
    }
    const result = limiter.check("agent-1");
    assert.equal(result.allowed, false);
    assert.equal(result.remaining, 0);
  });

  it("tracks keys independently", () => {
    for (let i = 0; i < 100; i++) {
      limiter.check("agent-1");
    }
    const result = limiter.check("agent-2");
    assert.equal(result.allowed, true);
    assert.equal(result.remaining, 99);
  });

  it("resets after window expires", () => {
    for (let i = 0; i < 100; i++) {
      limiter.check("agent-1");
    }
    // Manually expire the window
    limiter._expireKey("agent-1");
    const result = limiter.check("agent-1");
    assert.equal(result.allowed, true);
    assert.equal(result.remaining, 99);
  });

  it("reports warning threshold at 80%", () => {
    for (let i = 0; i < 80; i++) {
      limiter.check("agent-1");
    }
    const result = limiter.check("agent-1");
    assert.equal(result.allowed, true);
    assert.equal(result.warning, true);
  });

  it("does not report warning below 80%", () => {
    for (let i = 0; i < 79; i++) {
      limiter.check("agent-1");
    }
    const result = limiter.check("agent-1");
    assert.equal(result.warning, false);
  });

  it("increment adds count in bulk", () => {
    const result = limiter.increment("agent-1", 95);
    assert.equal(result.allowed, true);
    assert.equal(result.remaining, 5);
    assert.equal(result.warning, true);
  });

  it("increment rejects if bulk exceeds limit", () => {
    const result = limiter.increment("agent-1", 101);
    assert.equal(result.allowed, false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
cd packages/backend && npx tsx --test src/utils/rate-limiter.test.ts
```

Expected: FAIL -- module not found.

- [ ] **Step 3: Implement rate limiter**

Create `packages/backend/src/utils/rate-limiter.ts`:

```typescript
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  warning: boolean;
  resetAt: number;
}

interface Entry {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private readonly maxPerWindow: number;
  private readonly windowMs: number;
  private readonly entries = new Map<string, Entry>();
  private readonly WARNING_THRESHOLD = 0.8;

  constructor(opts: { maxPerWindow: number; windowMs: number }) {
    this.maxPerWindow = opts.maxPerWindow;
    this.windowMs = opts.windowMs;
  }

  check(key: string): RateLimitResult {
    return this.increment(key, 1);
  }

  increment(key: string, count: number): RateLimitResult {
    const now = Date.now();
    let entry = this.entries.get(key);

    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this.entries.set(key, entry);
    }

    const wouldExceed = entry.count + count > this.maxPerWindow;
    if (wouldExceed) {
      return {
        allowed: false,
        remaining: Math.max(0, this.maxPerWindow - entry.count),
        warning: true,
        resetAt: entry.resetAt,
      };
    }

    entry.count += count;
    const remaining = this.maxPerWindow - entry.count;
    const warning = entry.count >= this.maxPerWindow * this.WARNING_THRESHOLD;

    return { allowed: true, remaining, warning, resetAt: entry.resetAt };
  }

  /** Test helper: expire a key's window */
  _expireKey(key: string): void {
    this.entries.delete(key);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
cd packages/backend && npx tsx --test src/utils/rate-limiter.test.ts
```

Expected: All 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/utils/rate-limiter.ts packages/backend/src/utils/rate-limiter.test.ts
git commit -m "$(cat <<'EOF'
feat: add in-memory per-key rate limiter

Tracks request counts per key with configurable window.
Reports remaining quota and warning threshold at 80%.
Supports bulk increment for batch record ingestion.
EOF
)"
```

---

### Task 3: Fraud Detection Module

**Files:**
- Create: `packages/backend/src/utils/fraud-detection.ts`
- Create: `packages/backend/src/utils/fraud-detection.test.ts`

- [ ] **Step 1: Write failing tests for loading factor calculation**

Create `packages/backend/src/utils/fraud-detection.test.ts`:

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeLoadingFactor, isOutage } from "./fraud-detection.js";

describe("computeLoadingFactor", () => {
  it("returns 1.0 when agent rate <= 2x network rate", () => {
    assert.equal(computeLoadingFactor(10, 6), 1.0);  // 10/6 = 1.67x
  });

  it("returns 1.0 when agent rate equals network rate", () => {
    assert.equal(computeLoadingFactor(5, 5), 1.0);
  });

  it("returns 1.5 when agent rate is 2x-5x network rate", () => {
    assert.equal(computeLoadingFactor(15, 5), 1.5);  // 3x
  });

  it("returns 1.5 at exactly 2x boundary", () => {
    assert.equal(computeLoadingFactor(10.01, 5), 1.5);
  });

  it("returns 2.5 when agent rate > 5x network rate", () => {
    assert.equal(computeLoadingFactor(30, 5), 2.5);  // 6x
  });

  it("returns 2.5 at exactly 5x boundary", () => {
    assert.equal(computeLoadingFactor(25.01, 5), 2.5);
  });

  it("returns 1.0 when network rate is 0 and agent rate is 0", () => {
    assert.equal(computeLoadingFactor(0, 0), 1.0);
  });

  it("returns 2.5 when network rate is 0 but agent has failures", () => {
    assert.equal(computeLoadingFactor(5, 0), 2.5);
  });

  it("returns 1.0 when agent rate is 0", () => {
    assert.equal(computeLoadingFactor(0, 10), 1.0);
  });
});

describe("isOutage", () => {
  it("returns true when 5+ established agents report failures", () => {
    assert.equal(isOutage(5), true);
  });

  it("returns true when more than 5 agents report", () => {
    assert.equal(isOutage(10), true);
  });

  it("returns false when fewer than 5 agents report", () => {
    assert.equal(isOutage(4), false);
  });

  it("returns false when 0 agents report", () => {
    assert.equal(isOutage(0), false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
cd packages/backend && npx tsx --test src/utils/fraud-detection.test.ts
```

Expected: FAIL -- module not found.

- [ ] **Step 3: Implement fraud detection functions**

Create `packages/backend/src/utils/fraud-detection.ts`:

```typescript
import { getOne, query } from "../db.js";

const OUTAGE_AGENT_THRESHOLD = 5;
const AGENT_HISTORY_DAYS = 7;

/**
 * Compute the premium loading factor based on agent vs network failure rate.
 * Returns 1.0 (no penalty), 1.5 (50% increase), or 2.5 (150% increase).
 */
export function computeLoadingFactor(
  agentFailureRate: number,
  networkFailureRate: number,
): number {
  if (agentFailureRate === 0) return 1.0;
  if (networkFailureRate === 0) return 2.5;

  const ratio = agentFailureRate / networkFailureRate;
  if (ratio <= 2) return 1.0;
  if (ratio <= 5) return 1.5;
  return 2.5;
}

/**
 * Determine if a provider is experiencing a real outage based on
 * how many established agents are reporting failures.
 */
export function isOutage(establishedAgentsReporting: number): boolean {
  return establishedAgentsReporting >= OUTAGE_AGENT_THRESHOLD;
}

/**
 * Query agent's failure rate and network failure rate for a provider
 * in the last 24 hours. Returns both rates as percentages (0-100).
 */
export async function getFailureRates(
  agentId: string,
  providerId: string,
): Promise<{ agentRate: number; networkRate: number }> {
  const result = await getOne<{ agent_failure_rate: string; network_failure_rate: string }>(
    `WITH agent_stats AS (
      SELECT COALESCE(
        COUNT(*) FILTER (WHERE classification != 'success') * 100.0 / NULLIF(COUNT(*), 0),
        0
      ) AS agent_failure_rate
      FROM call_records
      WHERE agent_id = $1 AND provider_id = $2 AND created_at > NOW() - INTERVAL '24 hours'
    ),
    network_stats AS (
      SELECT COALESCE(
        COUNT(*) FILTER (WHERE classification != 'success') * 100.0 / NULLIF(COUNT(*), 0),
        0
      ) AS network_failure_rate
      FROM call_records
      WHERE provider_id = $2 AND created_at > NOW() - INTERVAL '24 hours'
    )
    SELECT agent_failure_rate, network_failure_rate
    FROM agent_stats, network_stats`,
    [agentId, providerId],
  );
  return {
    agentRate: parseFloat(result?.agent_failure_rate ?? "0"),
    networkRate: parseFloat(result?.network_failure_rate ?? "0"),
  };
}

/**
 * Count how many established agents (7+ days old) are reporting failures
 * for a provider in the last hour.
 */
export async function countEstablishedFailingAgents(
  providerId: string,
): Promise<number> {
  const result = await getOne<{ cnt: string }>(
    `SELECT COUNT(DISTINCT cr.agent_id) AS cnt
     FROM call_records cr
     JOIN api_keys ak ON cr.agent_id = ak.label
     WHERE cr.provider_id = $1
       AND cr.classification != 'success'
       AND cr.created_at > NOW() - INTERVAL '1 hour'
       AND ak.created_at < NOW() - INTERVAL '${AGENT_HISTORY_DAYS} days'`,
    [providerId],
  );
  return parseInt(result?.cnt ?? "0", 10);
}

/**
 * Upsert the premium loading factor for an agent-provider pair.
 */
export async function upsertLoadingFactor(
  agentId: string,
  providerId: string,
  factor: number,
  reason: string,
): Promise<void> {
  await query(
    `INSERT INTO premium_adjustments (agent_id, provider_id, loading_factor, reason, calculated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (agent_id, provider_id)
     DO UPDATE SET loading_factor = $3, reason = $4, calculated_at = NOW()`,
    [agentId, providerId, factor, reason],
  );
}

/**
 * Create a flag for a suspicious agent.
 */
export async function createFlag(
  agentId: string,
  agentPubkey: string | null,
  reason: string,
  data: Record<string, unknown>,
): Promise<string> {
  const result = await getOne<{ id: string }>(
    `INSERT INTO agent_flags (agent_id, agent_pubkey, flag_reason, flag_data)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [agentId, agentPubkey, reason, JSON.stringify(data)],
  );
  return result!.id;
}

/**
 * Check if an agent currently has a pending flag.
 */
export async function hasPendingFlag(agentId: string): Promise<boolean> {
  const result = await getOne<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt FROM agent_flags
     WHERE agent_id = $1 AND status = 'pending'`,
    [agentId],
  );
  return parseInt(result?.cnt ?? "0", 10) > 0;
}

/**
 * Record an outage event for audit trail.
 */
export async function recordOutageEvent(
  providerId: string,
  reportingAgents: number,
  networkFailureRate: number,
): Promise<void> {
  await query(
    `INSERT INTO outage_events (provider_id, reporting_agents, network_failure_rate)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [providerId, reportingAgents, networkFailureRate],
  );
}

/**
 * Run anomaly detection after a record batch is processed.
 * Returns the loading factor applied (1.0 if no penalty).
 */
export async function detectAnomalies(
  agentId: string,
  agentPubkey: string | null,
  providerId: string,
  logger?: { warn: (obj: Record<string, unknown>, msg: string) => void },
): Promise<number> {
  const { agentRate, networkRate } = await getFailureRates(agentId, providerId);

  // Check for real outage first
  const establishedCount = await countEstablishedFailingAgents(providerId);
  if (isOutage(establishedCount)) {
    await recordOutageEvent(providerId, establishedCount, networkRate);
    // Real outage: no penalty, reset factor to 1.0
    await upsertLoadingFactor(agentId, providerId, 1.0, "outage_exempt");
    return 1.0;
  }

  const factor = computeLoadingFactor(agentRate, networkRate);

  if (factor > 1.0) {
    await upsertLoadingFactor(agentId, providerId, factor, "elevated_failure_rate");
    logger?.warn(
      { agentId, providerId, agentRate, networkRate, factor },
      "Premium penalty applied to agent",
    );
  }

  // Flag agent if factor hits maximum
  if (factor >= 2.5) {
    const alreadyFlagged = await hasPendingFlag(agentId);
    if (!alreadyFlagged) {
      await createFlag(agentId, agentPubkey, "failure_rate_spike", {
        agentRate,
        networkRate,
        ratio: networkRate > 0 ? agentRate / networkRate : Infinity,
        providerId,
      });
      logger?.warn(
        { agentId, providerId, agentRate, networkRate },
        "Agent flagged for anomalous failure rate",
      );
    }
  }

  return factor;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
cd packages/backend && npx tsx --test src/utils/fraud-detection.test.ts
```

Expected: All 9 tests pass (pure function tests -- no DB required).

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/utils/fraud-detection.ts packages/backend/src/utils/fraud-detection.test.ts
git commit -m "$(cat <<'EOF'
feat: add fraud detection module

Implements premium loading factor calculation, outage detection
with sybil protection (5+ established agents threshold), agent
flagging, and anomaly detection orchestration.
EOF
)"
```

---

### Task 4: Integrate Rate Limiting into Records Route

**Files:**
- Modify: `packages/backend/src/routes/records.ts:1-4` (imports), `41-50` (handler start)

- [ ] **Step 1: Add rate limiter imports and instance to records.ts**

At the top of `packages/backend/src/routes/records.ts`, add the import after existing imports (line 4):

```typescript
import { RateLimiter } from "../utils/rate-limiter.js";
```

After the imports, before `findOrCreateProvider`, add the limiter instances:

```typescript
const MAX_BATCH_SIZE = 500;
const MAX_RECORDS_PER_HOUR = 10_000;

const recordsLimiter = new RateLimiter({
  maxPerWindow: MAX_RECORDS_PER_HOUR,
  windowMs: 3600_000,
});
```

- [ ] **Step 2: Add batch size check and rate limit check in the handler**

Inside the `recordsRoutes` handler, after the existing records array validation (line 49: `if (!records || !Array.isArray(records) || records.length === 0)`), add:

```typescript
    if (records.length > MAX_BATCH_SIZE) {
      return reply.code(400).send({
        error: `Batch size ${records.length} exceeds maximum of ${MAX_BATCH_SIZE}`,
      });
    }

    const authed = request as FastifyRequest & { agentId: string; agentPubkey?: string };
    const rateResult = recordsLimiter.increment(authed.agentId, records.length);
    if (!rateResult.allowed) {
      return reply.code(429).send({
        error: "Rate limit exceeded",
        remaining: rateResult.remaining,
        resetAt: new Date(rateResult.resetAt).toISOString(),
      });
    }
    if (rateResult.warning) {
      request.log.warn(
        { agentId: authed.agentId, remaining: rateResult.remaining },
        "Agent approaching hourly rate limit (80%)",
      );
    }
```

Remove the duplicate `const authed = ...` line that existed previously further down in the handler (around line 52-53) since we moved it up.

- [ ] **Step 3: Verify the backend still starts**

Run:
```bash
cd packages/backend && npx tsx src/index.ts &
sleep 2 && kill %1
```

Expected: Server starts without import errors.

- [ ] **Step 4: Commit**

```bash
git add packages/backend/src/routes/records.ts
git commit -m "$(cat <<'EOF'
feat: add rate limiting to record ingestion

Enforce max 500 records per batch (400 error) and 10,000 records
per hour per API key (429 error). Logs warning at 80% threshold.
EOF
)"
```

---

### Task 5: Integrate Fraud Detection into Records Route

**Files:**
- Modify: `packages/backend/src/routes/records.ts` (import + post-insert hook)

- [ ] **Step 1: Add fraud detection import**

Add to imports in `packages/backend/src/routes/records.ts`:

```typescript
import { detectAnomalies } from "../utils/fraud-detection.js";
```

- [ ] **Step 2: Add anomaly detection after record batch processing**

After the existing for-loop that processes records (after the wallet_address update block, before the final `return reply.send`), add:

```typescript
    // Run anomaly detection per provider touched in this batch
    const uniqueProviders = [...new Set(providerIds)];
    for (const pid of uniqueProviders) {
      try {
        await detectAnomalies(authed.agentId, authed.agentPubkey ?? null, pid, request.log);
      } catch (err) {
        request.log.error({ err, providerId: pid }, "Anomaly detection failed");
      }
    }
```

- [ ] **Step 3: Verify the backend still starts**

Run:
```bash
cd packages/backend && npx tsx src/index.ts &
sleep 2 && kill %1
```

Expected: Server starts without import errors.

- [ ] **Step 4: Commit**

```bash
git add packages/backend/src/routes/records.ts
git commit -m "$(cat <<'EOF'
feat: run anomaly detection after record ingestion

After processing a batch, checks each touched provider for
anomalous failure rates. Applies premium loading factor and
flags agents exceeding 5x network average.
EOF
)"
```

---

### Task 6: Daily Claim Cap and Flag Check in Claims

**Files:**
- Modify: `packages/backend/src/utils/claims.ts:37-66` (maybeCreateClaim)

- [ ] **Step 1: Add fraud detection import to claims.ts**

Add to imports at the top of `packages/backend/src/utils/claims.ts`:

```typescript
import { hasPendingFlag } from "./fraud-detection.js";
```

- [ ] **Step 2: Add claim cap and flag check to maybeCreateClaim**

In `maybeCreateClaim`, after the early returns for success/no payment (around line 42-43), add:

```typescript
  // Anti-fraud: skip claim if agent is flagged
  if (input.agentId) {
    const flagged = await hasPendingFlag(input.agentId);
    if (flagged) {
      input.logger?.warn(
        { agentId: input.agentId },
        "Skipping claim creation: agent is flagged",
      );
      return null;
    }
  }

  // Anti-fraud: daily claim cap per agent
  if (input.agentId) {
    const dailyCount = await getOne<{ cnt: string }>(
      "SELECT COUNT(*) AS cnt FROM claims WHERE agent_id = $1 AND created_at > NOW() - INTERVAL '1 day'",
      [input.agentId],
    );
    const count = parseInt(dailyCount?.cnt ?? "0", 10);
    if (count >= 1000) {
      input.logger?.warn(
        { agentId: input.agentId, dailyClaims: count },
        "Skipping claim creation: daily cap reached (1000)",
      );
      return null;
    }
  }
```

- [ ] **Step 3: Verify the backend still starts**

Run:
```bash
cd packages/backend && npx tsx src/index.ts &
sleep 2 && kill %1
```

Expected: Server starts without import errors.

- [ ] **Step 4: Commit**

```bash
git add packages/backend/src/utils/claims.ts
git commit -m "$(cat <<'EOF'
feat: add daily claim cap and flag check

Skip claim creation if agent has a pending flag or has exceeded
1,000 claims in the last 24 hours. Records are still stored for
visibility.
EOF
)"
```

---

### Task 7: Loading Factor in Insurance Rate

**Files:**
- Modify: `packages/backend/src/utils/insurance.ts`

- [ ] **Step 1: Add getEffectiveRate function**

Add to `packages/backend/src/utils/insurance.ts` after the existing functions:

```typescript
import { getOne } from "../db.js";

export async function getEffectiveRate(
  baseRate: number,
  agentId: string,
  providerId: string,
): Promise<number> {
  const adjustment = await getOne<{ loading_factor: string }>(
    "SELECT loading_factor FROM premium_adjustments WHERE agent_id = $1 AND provider_id = $2",
    [agentId, providerId],
  );
  const factor = adjustment ? parseFloat(adjustment.loading_factor) : 1.0;
  return baseRate * factor;
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/backend/src/utils/insurance.ts
git commit -m "$(cat <<'EOF'
feat: add loading factor to insurance rate calculation

getEffectiveRate() multiplies base insurance rate by the agent's
premium loading factor for the given provider.
EOF
)"
```

---

### Task 8: Admin Flags Endpoints

**Files:**
- Modify: `packages/backend/src/routes/admin.ts` (add after existing endpoints)

- [ ] **Step 1: Add flags endpoints to admin routes**

At the end of the `adminRoutes` function in `packages/backend/src/routes/admin.ts`, before the closing `}` of the function (before line 278), add:

```typescript
  // ── Flags ──────────────────────────────────────────────
  app.get("/api/v1/admin/flags", async (request, reply) => {
    const { status } = request.query as { status?: string };
    const where = status ? "WHERE status = $1" : "";
    const params = status ? [status] : [];
    const rows = await getMany<{
      id: string;
      agent_id: string;
      agent_pubkey: string | null;
      flag_reason: string;
      flag_data: Record<string, unknown>;
      status: string;
      created_at: string;
      resolved_at: string | null;
      resolved_by: string | null;
    }>(`SELECT * FROM agent_flags ${where} ORDER BY created_at DESC LIMIT 100`, params);

    // Enrich with 24h stats
    const enriched = await Promise.all(
      rows.map(async (row) => {
        const stats = await getOne<{ records_24h: string; claims_24h: string }>(
          `SELECT
            (SELECT COUNT(*) FROM call_records WHERE agent_id = $1 AND created_at > NOW() - INTERVAL '1 day') AS records_24h,
            (SELECT COUNT(*) FROM claims WHERE agent_id = $1 AND created_at > NOW() - INTERVAL '1 day') AS claims_24h`,
          [row.agent_id],
        );
        return {
          ...row,
          records_24h: parseInt(stats?.records_24h ?? "0", 10),
          claims_24h: parseInt(stats?.claims_24h ?? "0", 10),
        };
      }),
    );

    return reply.send(enriched);
  });

  app.patch("/api/v1/admin/flags/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { status } = request.body as { status: "dismissed" | "suspended" };

    if (!["dismissed", "suspended"].includes(status)) {
      return reply.code(400).send({ error: "Status must be 'dismissed' or 'suspended'" });
    }

    const flag = await getOne<{ agent_id: string; status: string }>(
      "SELECT agent_id, status FROM agent_flags WHERE id = $1",
      [id],
    );
    if (!flag) {
      return reply.code(404).send({ error: "Flag not found" });
    }

    await query(
      "UPDATE agent_flags SET status = $1, resolved_at = NOW(), resolved_by = 'admin' WHERE id = $2",
      [status, id],
    );

    if (status === "dismissed") {
      // Reset loading factors for this agent
      await query(
        "UPDATE premium_adjustments SET loading_factor = 1.0, reason = 'flag_dismissed' WHERE agent_id = $1",
        [flag.agent_id],
      );
    }

    if (status === "suspended") {
      // Disable the agent's API key
      await query(
        "UPDATE api_keys SET label = label || ' [SUSPENDED]' WHERE label = $1",
        [flag.agent_id],
      );
    }

    return reply.send({ ok: true, status });
  });
```

You'll also need to add `getMany` to the db import if not already there. Check the existing import line and add it:

```typescript
import { query, getOne, getMany } from "../db.js";
```

- [ ] **Step 2: Verify the backend still starts**

Run:
```bash
cd packages/backend && npx tsx src/index.ts &
sleep 2 && kill %1
```

Expected: Server starts, no import errors.

- [ ] **Step 3: Commit**

```bash
git add packages/backend/src/routes/admin.ts
git commit -m "$(cat <<'EOF'
feat: add admin flags endpoints

GET /api/v1/admin/flags lists flagged agents with 24h stats.
PATCH /api/v1/admin/flags/:id resolves flags (dismiss resets
loading factor, suspend disables API key).
EOF
)"
```

---

### Task 9: SDK Signing Module

**Files:**
- Create: `packages/sdk/src/signing.ts`
- Create: `packages/sdk/src/signing.test.ts`

- [ ] **Step 1: Write failing tests for signing**

Create `packages/sdk/src/signing.test.ts`:

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSignature, serializeRecords, verifySignature } from "./signing.js";
import { Keypair } from "@solana/web3.js";

describe("serializeRecords", () => {
  it("produces deterministic output regardless of key order", () => {
    const a = [{ z: 1, a: 2 }];
    const b = [{ a: 2, z: 1 }];
    assert.equal(serializeRecords(a), serializeRecords(b));
  });

  it("returns a string", () => {
    const result = serializeRecords([{ foo: "bar" }]);
    assert.equal(typeof result, "string");
  });
});

describe("createSignature + verifySignature", () => {
  it("round-trips with a valid keypair", () => {
    const keypair = Keypair.generate();
    const payload = JSON.stringify([{ hostname: "test.com", classification: "error" }]);

    const signature = createSignature(payload, keypair.secretKey);
    assert.equal(typeof signature, "string");

    const valid = verifySignature(payload, signature, keypair.publicKey.toBytes());
    assert.equal(valid, true);
  });

  it("rejects a tampered payload", () => {
    const keypair = Keypair.generate();
    const payload = JSON.stringify([{ hostname: "test.com" }]);
    const signature = createSignature(payload, keypair.secretKey);

    const tampered = JSON.stringify([{ hostname: "evil.com" }]);
    const valid = verifySignature(tampered, signature, keypair.publicKey.toBytes());
    assert.equal(valid, false);
  });

  it("rejects a wrong public key", () => {
    const keypair1 = Keypair.generate();
    const keypair2 = Keypair.generate();
    const payload = JSON.stringify([{ data: 1 }]);
    const signature = createSignature(payload, keypair1.secretKey);

    const valid = verifySignature(payload, signature, keypair2.publicKey.toBytes());
    assert.equal(valid, false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
cd packages/sdk && npx tsx --test src/signing.test.ts
```

Expected: FAIL -- module not found.

- [ ] **Step 3: Implement signing module**

First, add `@solana/web3.js` as a peer/dev dependency to the SDK:

```bash
cd packages/sdk && npm install --save-dev @solana/web3.js
```

Create `packages/sdk/src/signing.ts`:

```typescript
import { createHash } from "node:crypto";
import nacl from "tweetnacl";

/**
 * Serialize records array to a deterministic JSON string (sorted keys).
 */
export function serializeRecords(records: unknown[]): string {
  return JSON.stringify(records, Object.keys(records[0] as object).sort());
}

/**
 * Create an Ed25519 signature for a payload string.
 * Returns base64-encoded signature.
 */
export function createSignature(payload: string, secretKey: Uint8Array): string {
  const hash = createHash("sha256").update(payload).digest();
  const signature = nacl.sign.detached(hash, secretKey);
  return Buffer.from(signature).toString("base64");
}

/**
 * Verify an Ed25519 signature for a payload string.
 */
export function verifySignature(
  payload: string,
  signatureBase64: string,
  publicKey: Uint8Array,
): boolean {
  const hash = createHash("sha256").update(payload).digest();
  const signature = Buffer.from(signatureBase64, "base64");
  return nacl.sign.detached.verify(hash, signature, publicKey);
}
```

Then install tweetnacl in the SDK:

```bash
cd packages/sdk && npm install tweetnacl
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
cd packages/sdk && npx tsx --test src/signing.test.ts
```

Expected: All 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/signing.ts packages/sdk/src/signing.test.ts packages/sdk/package.json packages/sdk/package-lock.json
git commit -m "$(cat <<'EOF'
feat: add Ed25519 record signing module to SDK

Deterministic serialization + SHA-256 hash + nacl.sign.detached
for call record batch integrity. Includes verification function
for backend use.
EOF
)"
```

---

### Task 10: Integrate Signing into SDK Sync

**Files:**
- Modify: `packages/sdk/src/types.ts:25-34` (PactConfig interface)
- Modify: `packages/sdk/src/wrapper.ts:14-44` (constructor validation)
- Modify: `packages/sdk/src/sync.ts:57-93` (doFlush)

- [ ] **Step 1: Add keypair to PactConfig**

In `packages/sdk/src/types.ts`, add to the `PactConfig` interface (after `agentPubkey` on line 33):

```typescript
  keypair?: { publicKey: Uint8Array; secretKey: Uint8Array };
```

- [ ] **Step 2: Validate keypair in PactMonitor constructor**

In `packages/sdk/src/wrapper.ts`, in the constructor (around line 27-29 where agentPubkey is validated), add after the existing agentPubkey warning:

```typescript
    if (this.config.syncEnabled && this.config.apiKey && !this.config.keypair) {
      console.warn(
        "[pact-monitor] keypair not provided — record batches will not be signed. " +
        "This will be required in a future version.",
      );
    }
```

- [ ] **Step 3: Pass keypair to PactSync**

In `packages/sdk/src/wrapper.ts`, where PactSync is instantiated (around line 35-41), add keypair to the constructor arguments. Update the line:

```typescript
      this.sync = new PactSync(
        this.storage,
        this.config.backendUrl!,
        this.config.apiKey!,
        this.config.syncIntervalMs!,
        this.config.syncBatchSize!,
        this.config.keypair ?? null,
      );
```

- [ ] **Step 4: Update PactSync to accept and use keypair for signing**

In `packages/sdk/src/sync.ts`, add import at the top:

```typescript
import { serializeRecords, createSignature } from "./signing.js";
import bs58 from "bs58";
```

Install bs58 in the SDK:

```bash
cd packages/sdk && npm install bs58
```

Update the PactSync constructor to accept keypair (add after `batchSize` parameter):

```typescript
  private readonly keypair: { publicKey: Uint8Array; secretKey: Uint8Array } | null;

  constructor(
    storage: { getUnsynced: () => CallRecord[]; markSynced: (count: number) => void },
    backendUrl: string,
    apiKey: string,
    intervalMs: number,
    batchSize: number,
    keypair: { publicKey: Uint8Array; secretKey: Uint8Array } | null,
  ) {
    // ... existing assignments ...
    this.keypair = keypair;
  }
```

In `doFlush()`, before the `fetch` call, add signing headers:

```typescript
    const payload = JSON.stringify(
      batch.map((r) => ({
        hostname: r.hostname,
        endpoint: r.endpoint,
        timestamp: r.timestamp,
        status_code: r.statusCode,
        latency_ms: r.latencyMs,
        classification: r.classification,
        payment_protocol: r.payment?.protocol ?? null,
        payment_amount: r.payment?.amount ?? null,
        payment_asset: r.payment?.asset ?? null,
        payment_network: r.payment?.network ?? null,
        payer_address: r.payment?.payerAddress ?? null,
        recipient_address: r.payment?.recipientAddress ?? null,
        tx_hash: r.payment?.txHash ?? null,
        settlement_success: r.payment?.settlementSuccess ?? null,
      })),
    );

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };

    if (this.keypair) {
      const serialized = serializeRecords(JSON.parse(payload));
      headers["X-Pact-Signature"] = createSignature(serialized, this.keypair.secretKey);
      headers["X-Pact-Pubkey"] = bs58.encode(this.keypair.publicKey);
    }

    const res = await fetch(`${this.backendUrl}/api/v1/records`, {
      method: "POST",
      headers,
      body: JSON.stringify({ records: JSON.parse(payload) }),
    });
```

- [ ] **Step 5: Verify SDK builds**

Run:
```bash
cd packages/sdk && npm run build
```

Expected: Build succeeds.

- [ ] **Step 6: Commit**

```bash
git add packages/sdk/src/types.ts packages/sdk/src/sync.ts packages/sdk/src/wrapper.ts packages/sdk/package.json
git commit -m "$(cat <<'EOF'
feat: sign record batches with agent keypair in SDK

SDK now signs each sync batch with Ed25519 using the agent's
keypair. Sends X-Pact-Signature and X-Pact-Pubkey headers.
Gracefully warns if keypair not provided (grace period).
EOF
)"
```

---

### Task 11: Backend Signature Verification Middleware

**Files:**
- Modify: `packages/backend/src/middleware/auth.ts`

- [ ] **Step 1: Add signature verification function to auth.ts**

Add imports at the top of `packages/backend/src/middleware/auth.ts`:

```typescript
import { createHash } from "node:crypto";
import nacl from "tweetnacl";
import bs58 from "bs58";
```

Install tweetnacl in the backend if not already present:

```bash
cd packages/backend && npm install tweetnacl
```

Add the middleware after the existing `requireApiKey` export:

```typescript
const REQUIRE_SIGNATURES = process.env.REQUIRE_RECORD_SIGNATURES === "true";

export async function verifyRecordSignature(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const signature = request.headers["x-pact-signature"] as string | undefined;
  const pubkeyHeader = request.headers["x-pact-pubkey"] as string | undefined;

  if (!signature || !pubkeyHeader) {
    if (REQUIRE_SIGNATURES) {
      reply.code(401).send({ error: "Record signature required" });
      return;
    }
    // Grace period: accept unsigned, add deprecation warning
    return;
  }

  const authed = request as FastifyRequest & { agentPubkey?: string };
  if (authed.agentPubkey && pubkeyHeader !== authed.agentPubkey) {
    reply.code(401).send({ error: "Signature pubkey does not match API key binding" });
    return;
  }

  try {
    const body = request.body as { records: unknown[] };
    const serialized = JSON.stringify(body.records, Object.keys(body.records[0] as object).sort());
    const hash = createHash("sha256").update(serialized).digest();
    const sigBytes = Buffer.from(signature, "base64");
    const pubkeyBytes = bs58.decode(pubkeyHeader);

    const valid = nacl.sign.detached.verify(hash, sigBytes, pubkeyBytes);
    if (!valid) {
      reply.code(401).send({ error: "Invalid record signature" });
      return;
    }
  } catch (err) {
    request.log.error({ err }, "Signature verification error");
    reply.code(401).send({ error: "Signature verification failed" });
    return;
  }
}
```

- [ ] **Step 2: Wire middleware into records route**

In `packages/backend/src/routes/records.ts`, add import:

```typescript
import { requireApiKey, verifyRecordSignature } from "../middleware/auth.js";
```

Update the route registration to chain both middlewares. Change the route definition from:

```typescript
app.post("/api/v1/records", { preHandler: [requireApiKey] }, async (request, reply) => {
```

to:

```typescript
app.post("/api/v1/records", { preHandler: [requireApiKey, verifyRecordSignature] }, async (request, reply) => {
```

(Note: Check the exact current syntax -- it may use `onRequest` hook or `preHandler`. Match the existing pattern.)

- [ ] **Step 3: Verify the backend still starts**

Run:
```bash
cd packages/backend && npx tsx src/index.ts &
sleep 2 && kill %1
```

Expected: Server starts. Unsigned requests still accepted (grace period default).

- [ ] **Step 4: Commit**

```bash
git add packages/backend/src/middleware/auth.ts packages/backend/src/routes/records.ts packages/backend/package.json
git commit -m "$(cat <<'EOF'
feat: add Ed25519 signature verification for record batches

Verifies X-Pact-Signature header against X-Pact-Pubkey using
nacl.sign.detached.verify. Grace period (unsigned accepted) by
default. Set REQUIRE_RECORD_SIGNATURES=true to enforce.
EOF
)"
```

---

### Task 12: Admin Dashboard -- Flags Tab

**Files:**
- Modify: `packages/scorecard/src/api/admin-client.ts`
- Modify: `packages/scorecard/src/components/AdminDashboard.tsx`

- [ ] **Step 1: Add flags API functions to admin-client.ts**

Add interfaces and methods to `packages/scorecard/src/api/admin-client.ts`:

After the existing interfaces (around line 67), add:

```typescript
export interface FlagRow {
  id: string;
  agent_id: string;
  agent_pubkey: string | null;
  flag_reason: string;
  flag_data: Record<string, unknown>;
  status: string;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  records_24h: number;
  claims_24h: number;
}
```

Add a helper for PATCH requests:

```typescript
async function adminPatch<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const token = getToken();
  const res = await fetch(`/api/v1/admin${path}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Admin PATCH ${path}: ${res.status}`);
  return res.json() as Promise<T>;
}
```

Add to the `adminApi` object:

```typescript
  getFlags: (status?: string) =>
    adminGet<FlagRow[]>(status ? `/flags?status=${status}` : "/flags"),
  resolveFlag: (id: string, status: "dismissed" | "suspended") =>
    adminPatch<{ ok: boolean }>(`/flags/${id}`, { status }),
```

- [ ] **Step 2: Add tab navigation and flags tab to AdminDashboard**

In `packages/scorecard/src/components/AdminDashboard.tsx`, add state and tab navigation.

Add imports at the top:

```typescript
import { useState, useEffect } from "react";
import { adminApi, FlagRow } from "../api/admin-client";
```

Inside the `AdminDashboard` component, before the return statement, add:

```typescript
  const [activeTab, setActiveTab] = useState<"overview" | "flags">("overview");
  const [flags, setFlags] = useState<FlagRow[]>([]);
  const [flagsLoading, setFlagsLoading] = useState(false);

  useEffect(() => {
    if (activeTab === "flags") {
      setFlagsLoading(true);
      adminApi.getFlags("pending")
        .then(setFlags)
        .catch(() => setFlags([]))
        .finally(() => setFlagsLoading(false));
    }
  }, [activeTab]);

  const handleResolve = async (id: string, status: "dismissed" | "suspended") => {
    await adminApi.resolveFlag(id, status);
    setFlags((prev) => prev.filter((f) => f.id !== id));
  };
```

Wrap the existing dashboard content inside a tab container. Replace the outer return with:

```tsx
  const pendingCount = flags.filter((f) => f.status === "pending").length;

  return (
    <div style={{ padding: "2rem", maxWidth: 1200, margin: "0 auto" }}>
      {/* Tab bar */}
      <div style={{ display: "flex", gap: "1rem", marginBottom: "2rem", borderBottom: "1px solid #333" }}>
        <button
          onClick={() => setActiveTab("overview")}
          style={{
            padding: "0.75rem 1.5rem",
            background: activeTab === "overview" ? "#B87333" : "transparent",
            color: activeTab === "overview" ? "#151311" : "#888",
            border: "none",
            cursor: "pointer",
            fontFamily: "'Inria Sans', sans-serif",
            fontSize: "0.9rem",
          }}
        >
          Overview
        </button>
        <button
          onClick={() => setActiveTab("flags")}
          style={{
            padding: "0.75rem 1.5rem",
            background: activeTab === "flags" ? "#B87333" : "transparent",
            color: activeTab === "flags" ? "#151311" : "#888",
            border: "none",
            cursor: "pointer",
            fontFamily: "'Inria Sans', sans-serif",
            fontSize: "0.9rem",
            position: "relative",
          }}
        >
          Flags
          {pendingCount > 0 && (
            <span style={{
              position: "absolute",
              top: 4,
              right: -4,
              background: "#C9553D",
              color: "#fff",
              fontSize: "0.7rem",
              padding: "1px 6px",
              fontFamily: "'JetBrains Mono', monospace",
            }}>
              {pendingCount}
            </span>
          )}
        </button>
      </div>

      {activeTab === "overview" && (
        <>
          {/* Paste existing dashboard content here */}
        </>
      )}

      {activeTab === "flags" && (
        <div>
          <h2 style={{ fontFamily: "'Inria Serif', serif", color: "#C9553D", marginBottom: "1rem" }}>
            Flagged Agents
          </h2>
          {flagsLoading ? (
            <p style={{ color: "#888" }}>Loading...</p>
          ) : flags.length === 0 ? (
            <p style={{ color: "#5A6B7A" }}>No pending flags</p>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "'JetBrains Mono', monospace", fontSize: "0.85rem" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #333", color: "#888" }}>
                  <th style={{ textAlign: "left", padding: "0.5rem" }}>Agent</th>
                  <th style={{ textAlign: "left", padding: "0.5rem" }}>Reason</th>
                  <th style={{ textAlign: "right", padding: "0.5rem" }}>Records 24h</th>
                  <th style={{ textAlign: "right", padding: "0.5rem" }}>Claims 24h</th>
                  <th style={{ textAlign: "left", padding: "0.5rem" }}>Flagged</th>
                  <th style={{ textAlign: "center", padding: "0.5rem" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {flags.map((flag) => (
                  <tr key={flag.id} style={{ borderBottom: "1px solid #222" }}>
                    <td style={{ padding: "0.5rem", color: "#ddd" }}>
                      {flag.agent_id}
                    </td>
                    <td style={{ padding: "0.5rem", color: "#C9553D" }}>
                      {flag.flag_reason}
                    </td>
                    <td style={{ padding: "0.5rem", textAlign: "right", color: "#B87333" }}>
                      {flag.records_24h.toLocaleString()}
                    </td>
                    <td style={{ padding: "0.5rem", textAlign: "right", color: "#B87333" }}>
                      {flag.claims_24h.toLocaleString()}
                    </td>
                    <td style={{ padding: "0.5rem", color: "#888" }}>
                      {new Date(flag.created_at).toLocaleDateString()}
                    </td>
                    <td style={{ padding: "0.5rem", textAlign: "center" }}>
                      <button
                        onClick={() => handleResolve(flag.id, "dismissed")}
                        style={{
                          background: "#5A6B7A",
                          color: "#fff",
                          border: "none",
                          padding: "0.25rem 0.75rem",
                          cursor: "pointer",
                          marginRight: "0.5rem",
                          fontFamily: "'Inria Sans', sans-serif",
                          fontSize: "0.8rem",
                        }}
                      >
                        Dismiss
                      </button>
                      <button
                        onClick={() => handleResolve(flag.id, "suspended")}
                        style={{
                          background: "#C9553D",
                          color: "#fff",
                          border: "none",
                          padding: "0.25rem 0.75rem",
                          cursor: "pointer",
                          fontFamily: "'Inria Sans', sans-serif",
                          fontSize: "0.8rem",
                        }}
                      >
                        Suspend
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
```

- [ ] **Step 3: Verify the scorecard builds**

Run:
```bash
cd packages/scorecard && npm run build
```

Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add packages/scorecard/src/api/admin-client.ts packages/scorecard/src/components/AdminDashboard.tsx
git commit -m "$(cat <<'EOF'
feat: add flags tab to admin dashboard

Admin can view flagged agents with 24h stats, dismiss flags
(resets loading factor) or suspend agents (disables API key).
Badge shows pending flag count.
EOF
)"
```

---

### Task 13: Integration Verification

- [ ] **Step 1: Run all backend tests**

```bash
cd packages/backend && npx tsx --test src/**/*.test.ts
```

Expected: All tests pass (existing + new rate-limiter and fraud-detection tests).

- [ ] **Step 2: Run all SDK tests**

```bash
cd packages/sdk && npx tsx --test src/**/*.test.ts
```

Expected: All tests pass (existing + new signing tests).

- [ ] **Step 3: Build scorecard**

```bash
cd packages/scorecard && npm run build
```

Expected: Build succeeds.

- [ ] **Step 4: Verify backend starts with new schema**

```bash
cd packages/backend && npx tsx src/index.ts &
sleep 3 && kill %1
```

Expected: Server starts, schema creates new tables on startup.

- [ ] **Step 5: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix: integration fixes for anti-fraud system"
```

Only if there were fixes to make. Skip if everything passed clean.
