# Tracking and Simulated Claims Layer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a simulated claims layer and analytics endpoints so Rick can track SDK request volume and claims, and hackathon judges see a demo-able claim flow.

**Architecture:** When `POST /api/v1/records` ingests a call_record that qualifies (failure + payment), the backend auto-creates a claim row in a new `claims` table with computed refund amounts per whitepaper parametric rules. New read-only analytics endpoints aggregate this data. The scorecard gets a "Network Activity" panel.

**Tech Stack:** TypeScript, Fastify, PostgreSQL, React, Recharts, Tailwind CSS

---

### Task 1: Add claims table to database schema

**Files:**
- Modify: `packages/backend/src/schema.sql`

- [ ] **Step 1: Add claims table and indexes to schema.sql**

Append to the end of `packages/backend/src/schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS claims (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_record_id  UUID NOT NULL REFERENCES call_records(id),
  provider_id     UUID NOT NULL REFERENCES providers(id),
  agent_id        TEXT,
  policy_id       TEXT,
  trigger_type    TEXT NOT NULL CHECK (trigger_type IN ('timeout', 'error', 'schema_mismatch', 'latency_sla')),
  call_cost       BIGINT,
  refund_pct      INTEGER NOT NULL,
  refund_amount   BIGINT,
  status          TEXT NOT NULL DEFAULT 'simulated' CHECK (status IN ('detected', 'simulated', 'submitted', 'settled')),
  tx_hash         TEXT,
  settlement_slot BIGINT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_claims_provider_id ON claims(provider_id);
CREATE INDEX IF NOT EXISTS idx_claims_agent_id ON claims(agent_id);
CREATE INDEX IF NOT EXISTS idx_claims_status ON claims(status);
CREATE INDEX IF NOT EXISTS idx_claims_created_at ON claims(created_at);
```

- [ ] **Step 2: Verify schema applies cleanly**

Run: `cd packages/backend && npx tsx -e "import { initDb } from './src/db.js'; await initDb(); console.log('OK'); process.exit(0);"`

Expected: `OK` with no errors. The `CREATE TABLE IF NOT EXISTS` is idempotent.

- [ ] **Step 3: Commit**

```bash
git add packages/backend/src/schema.sql
git commit -m "feat(backend): add claims table to database schema"
```

---

### Task 2: Add claim creation logic to records ingestion

**Files:**
- Create: `packages/backend/src/utils/claims.ts`
- Modify: `packages/backend/src/routes/records.ts`

- [ ] **Step 1: Create the claims utility module**

Create `packages/backend/src/utils/claims.ts`:

```typescript
import { query, getOne } from "../db.js";

const REFUND_PCT: Record<string, number> = {
  timeout: 100,
  error: 100,
  schema_mismatch: 75,
  latency_sla: 50,
};

interface ClaimInput {
  callRecordId: string;
  providerId: string;
  agentId: string | null;
  classification: string;
  paymentAmount: number | null;
}

export async function maybeCreateClaim(input: ClaimInput): Promise<string | null> {
  const { callRecordId, providerId, agentId, classification, paymentAmount } = input;

  if (classification === "success") return null;
  if (!paymentAmount || paymentAmount <= 0) return null;

  const triggerType = classification;
  const refundPct = REFUND_PCT[triggerType];
  if (refundPct === undefined) return null;

  const refundAmount = Math.round((paymentAmount * refundPct) / 100);

  const row = await getOne<{ id: string }>(
    `INSERT INTO claims (
      call_record_id, provider_id, agent_id, trigger_type,
      call_cost, refund_pct, refund_amount, status
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'simulated')
    RETURNING id`,
    [callRecordId, providerId, agentId, triggerType, paymentAmount, refundPct, refundAmount],
  );

  return row?.id ?? null;
}
```

- [ ] **Step 2: Modify records route to capture inserted call_record IDs and create claims**

In `packages/backend/src/routes/records.ts`, add the import at the top:

```typescript
import { maybeCreateClaim } from "../utils/claims.js";
```

Then replace the `for (const rec of records)` loop (the main insertion loop, lines 55-76) with:

```typescript
      for (const rec of records) {
        const providerId = await findOrCreateProvider(rec.hostname);
        providerIds.add(providerId);

        const insertResult = await query<{ id: string }>(
          `INSERT INTO call_records (
            provider_id, endpoint, timestamp, status_code, latency_ms,
            classification, payment_protocol, payment_amount, payment_asset,
            payment_network, payer_address, recipient_address, tx_hash,
            settlement_success, agent_id
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
          RETURNING id`,
          [
            providerId, rec.endpoint, rec.timestamp, rec.status_code,
            rec.latency_ms, rec.classification, rec.payment_protocol ?? null,
            rec.payment_amount ?? null, rec.payment_asset ?? null,
            rec.payment_network ?? null, rec.payer_address ?? null,
            rec.recipient_address ?? null, rec.tx_hash ?? null,
            rec.settlement_success ?? null, agentId,
          ],
        );

        const callRecordId = insertResult.rows[0].id;

        await maybeCreateClaim({
          callRecordId,
          providerId,
          agentId,
          classification: rec.classification,
          paymentAmount: rec.payment_amount ?? null,
        });

        accepted++;
      }
```

The key change: the INSERT now has `RETURNING id`, and `maybeCreateClaim` is called after each insert.

- [ ] **Step 3: Verify the backend still starts**

Run: `cd packages/backend && npx tsx src/index.ts`

Expected: Server starts without errors. Ctrl+C to stop.

- [ ] **Step 4: Commit**

```bash
git add packages/backend/src/utils/claims.ts packages/backend/src/routes/records.ts
git commit -m "feat(backend): auto-create claims on failure+payment ingestion"
```

---

### Task 3: Add tests for claim creation

**Files:**
- Create: `packages/backend/src/utils/claims.test.ts`
- Modify: `packages/backend/src/routes/api.test.ts`

- [ ] **Step 1: Write unit test for maybeCreateClaim logic**

Create `packages/backend/src/utils/claims.test.ts`:

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("claims refund logic", () => {
  it("returns correct refund percentages per trigger type", () => {
    const REFUND_PCT: Record<string, number> = {
      timeout: 100,
      error: 100,
      schema_mismatch: 75,
      latency_sla: 50,
    };

    assert.equal(REFUND_PCT["timeout"], 100);
    assert.equal(REFUND_PCT["error"], 100);
    assert.equal(REFUND_PCT["schema_mismatch"], 75);
    assert.equal(REFUND_PCT["latency_sla"], 50);
  });

  it("computes refund amount correctly", () => {
    const paymentAmount = 10000;
    const refundPct = 75;
    const refundAmount = Math.round((paymentAmount * refundPct) / 100);
    assert.equal(refundAmount, 7500);
  });

  it("computes 100% refund correctly", () => {
    const paymentAmount = 5432;
    const refundPct = 100;
    const refundAmount = Math.round((paymentAmount * refundPct) / 100);
    assert.equal(refundAmount, 5432);
  });

  it("computes 50% refund correctly with rounding", () => {
    const paymentAmount = 1001;
    const refundPct = 50;
    const refundAmount = Math.round((paymentAmount * refundPct) / 100);
    assert.equal(refundAmount, 501); // rounds 500.5 to 501
  });
});
```

- [ ] **Step 2: Run unit test**

Run: `cd packages/backend && npx tsx --test src/utils/claims.test.ts`

Expected: All tests pass.

- [ ] **Step 3: Add integration test for claim creation via records endpoint**

Add to the end of the `POST /api/v1/records` describe block in `packages/backend/src/routes/api.test.ts`, before the closing `});` of that describe:

```typescript
    it("creates a claim for failed records with payment", async () => {
      const hostname = `claim-test-${randomUUID()}.example.com`;
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/records",
        headers: { authorization: `Bearer ${TEST_API_KEY}` },
        payload: {
          records: [
            {
              hostname,
              endpoint: "/v1/data",
              timestamp: new Date().toISOString(),
              status_code: 500,
              latency_ms: 3000,
              classification: "error",
              payment_protocol: "x402",
              payment_amount: 10000,
              payment_asset: "USDC",
              payment_network: "solana",
            },
          ],
        },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      const providerId = body.provider_ids[0];

      // Verify claim was created
      const claimResult = await query(
        "SELECT * FROM claims WHERE provider_id = $1",
        [providerId],
      );
      assert.equal(claimResult.rows.length, 1);
      const claim = claimResult.rows[0];
      assert.equal(claim.trigger_type, "error");
      assert.equal(claim.refund_pct, 100);
      assert.equal(Number(claim.call_cost), 10000);
      assert.equal(Number(claim.refund_amount), 10000);
      assert.equal(claim.status, "simulated");

      // Clean up
      await query("DELETE FROM claims WHERE provider_id = $1", [providerId]);
      await query("DELETE FROM call_records WHERE provider_id = $1", [providerId]);
      await query("DELETE FROM providers WHERE id = $1", [providerId]);
    });

    it("does NOT create a claim for successful records with payment", async () => {
      const hostname = `no-claim-${randomUUID()}.example.com`;
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/records",
        headers: { authorization: `Bearer ${TEST_API_KEY}` },
        payload: {
          records: [
            {
              hostname,
              endpoint: "/v1/data",
              timestamp: new Date().toISOString(),
              status_code: 200,
              latency_ms: 100,
              classification: "success",
              payment_protocol: "x402",
              payment_amount: 10000,
            },
          ],
        },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      const providerId = body.provider_ids[0];

      const claimResult = await query(
        "SELECT * FROM claims WHERE provider_id = $1",
        [providerId],
      );
      assert.equal(claimResult.rows.length, 0);

      // Clean up
      await query("DELETE FROM call_records WHERE provider_id = $1", [providerId]);
      await query("DELETE FROM providers WHERE id = $1", [providerId]);
    });

    it("does NOT create a claim for failed records without payment", async () => {
      const hostname = `no-pay-${randomUUID()}.example.com`;
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/records",
        headers: { authorization: `Bearer ${TEST_API_KEY}` },
        payload: {
          records: [
            {
              hostname,
              endpoint: "/v1/data",
              timestamp: new Date().toISOString(),
              status_code: 500,
              latency_ms: 3000,
              classification: "error",
            },
          ],
        },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      const providerId = body.provider_ids[0];

      const claimResult = await query(
        "SELECT * FROM claims WHERE provider_id = $1",
        [providerId],
      );
      assert.equal(claimResult.rows.length, 0);

      // Clean up
      await query("DELETE FROM call_records WHERE provider_id = $1", [providerId]);
      await query("DELETE FROM providers WHERE id = $1", [providerId]);
    });
```

- [ ] **Step 4: Run the full test suite**

Run: `cd packages/backend && npx tsx --test src/utils/*.test.ts src/routes/*.test.ts`

Expected: All tests pass, including the three new claim tests.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/utils/claims.test.ts packages/backend/src/routes/api.test.ts
git commit -m "test(backend): add claim creation unit and integration tests"
```

---

### Task 4: Add analytics and claims API endpoints

**Files:**
- Create: `packages/backend/src/routes/analytics.ts`
- Create: `packages/backend/src/routes/claims.ts`
- Modify: `packages/backend/src/index.ts`

- [ ] **Step 1: Create analytics routes**

Create `packages/backend/src/routes/analytics.ts`:

```typescript
import type { FastifyInstance } from "fastify";
import { getOne, getMany } from "../db.js";

export async function analyticsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/analytics/summary", async () => {
    const stats = await getOne<{
      total_sdk_requests: string;
      unique_agents: string;
      unique_providers: string;
    }>(`
      SELECT
        COUNT(*)::text AS total_sdk_requests,
        COUNT(DISTINCT agent_id)::text AS unique_agents,
        COUNT(DISTINCT provider_id)::text AS unique_providers
      FROM call_records
    `);

    const claimStats = await getOne<{
      total_claims: string;
      total_claim_amount: string;
      total_refund_amount: string;
    }>(`
      SELECT
        COUNT(*)::text AS total_claims,
        COALESCE(SUM(call_cost), 0)::text AS total_claim_amount,
        COALESCE(SUM(refund_amount), 0)::text AS total_refund_amount
      FROM claims
    `);

    const triggerRows = await getMany<{ trigger_type: string; count: string }>(`
      SELECT trigger_type, COUNT(*)::text AS count
      FROM claims
      GROUP BY trigger_type
    `);

    return {
      total_sdk_requests: parseInt(stats!.total_sdk_requests, 10),
      total_claims: parseInt(claimStats!.total_claims, 10),
      total_claim_amount: parseInt(claimStats!.total_claim_amount, 10),
      total_refund_amount: parseInt(claimStats!.total_refund_amount, 10),
      claims_by_trigger: Object.fromEntries(
        triggerRows.map((r) => [r.trigger_type, parseInt(r.count, 10)]),
      ),
      unique_agents: parseInt(stats!.unique_agents, 10),
      unique_providers: parseInt(stats!.unique_providers, 10),
    };
  });

  app.get<{
    Querystring: { granularity?: string; days?: string };
  }>("/api/v1/analytics/timeseries", async (request) => {
    const granularity = request.query.granularity === "daily" ? "day" : "hour";
    const days = parseInt(request.query.days || "7", 10);

    const rows = await getMany<{
      bucket: string;
      requests: string;
      claims: string;
      refund_amount: string;
    }>(`
      SELECT
        date_trunc($1, cr.timestamp) AS bucket,
        COUNT(cr.id)::text AS requests,
        COUNT(c.id)::text AS claims,
        COALESCE(SUM(c.refund_amount), 0)::text AS refund_amount
      FROM call_records cr
      LEFT JOIN claims c ON c.call_record_id = cr.id
      WHERE cr.timestamp > NOW() - ($2 || ' days')::interval
      GROUP BY bucket
      ORDER BY bucket ASC
    `, [granularity, days.toString()]);

    return {
      granularity: request.query.granularity === "daily" ? "daily" : "hourly",
      data: rows.map((r) => ({
        bucket: r.bucket,
        requests: parseInt(r.requests, 10),
        claims: parseInt(r.claims, 10),
        refund_amount: parseInt(r.refund_amount, 10),
      })),
    };
  });
}
```

- [ ] **Step 2: Create claims list route**

Create `packages/backend/src/routes/claims.ts`:

```typescript
import type { FastifyInstance } from "fastify";
import { getMany } from "../db.js";

export async function claimsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Querystring: {
      provider_id?: string;
      agent_id?: string;
      trigger_type?: string;
      limit?: string;
      offset?: string;
    };
  }>("/api/v1/claims", async (request) => {
    const limit = Math.min(parseInt(request.query.limit || "50", 10), 200);
    const offset = parseInt(request.query.offset || "0", 10);

    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (request.query.provider_id) {
      conditions.push(`c.provider_id = $${paramIndex++}`);
      params.push(request.query.provider_id);
    }
    if (request.query.agent_id) {
      conditions.push(`c.agent_id = $${paramIndex++}`);
      params.push(request.query.agent_id);
    }
    if (request.query.trigger_type) {
      conditions.push(`c.trigger_type = $${paramIndex++}`);
      params.push(request.query.trigger_type);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    params.push(limit);
    const limitParam = `$${paramIndex++}`;
    params.push(offset);
    const offsetParam = `$${paramIndex++}`;

    const rows = await getMany<{
      id: string;
      call_record_id: string;
      provider_id: string;
      provider_name: string;
      agent_id: string | null;
      trigger_type: string;
      call_cost: string | null;
      refund_pct: string;
      refund_amount: string | null;
      status: string;
      created_at: string;
    }>(`
      SELECT
        c.id, c.call_record_id, c.provider_id, p.name AS provider_name,
        c.agent_id, c.trigger_type, c.call_cost::text, c.refund_pct::text,
        c.refund_amount::text, c.status, c.created_at
      FROM claims c
      JOIN providers p ON p.id = c.provider_id
      ${where}
      ORDER BY c.created_at DESC
      LIMIT ${limitParam} OFFSET ${offsetParam}
    `, params);

    return rows.map((r) => ({
      id: r.id,
      call_record_id: r.call_record_id,
      provider_id: r.provider_id,
      provider_name: r.provider_name,
      agent_id: r.agent_id,
      trigger_type: r.trigger_type,
      call_cost: r.call_cost ? parseInt(r.call_cost, 10) : null,
      refund_pct: parseInt(r.refund_pct, 10),
      refund_amount: r.refund_amount ? parseInt(r.refund_amount, 10) : null,
      status: r.status,
      created_at: r.created_at,
    }));
  });
}
```

- [ ] **Step 3: Register new routes in the backend entry point**

In `packages/backend/src/index.ts`, add imports after the existing route imports:

```typescript
import { analyticsRoutes } from "./routes/analytics.js";
import { claimsRoutes } from "./routes/claims.js";
```

Add registrations after the existing `app.register` calls:

```typescript
await app.register(analyticsRoutes);
await app.register(claimsRoutes);
```

- [ ] **Step 4: Verify the backend starts with new routes**

Run: `cd packages/backend && npx tsx src/index.ts`

Expected: Server starts. Test with:
`curl http://localhost:3001/api/v1/analytics/summary` — should return JSON with zeros or seeded data.
`curl http://localhost:3001/api/v1/claims` — should return empty array or seeded claims.

Ctrl+C to stop.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/routes/analytics.ts packages/backend/src/routes/claims.ts packages/backend/src/index.ts
git commit -m "feat(backend): add analytics summary, timeseries, and claims list endpoints"
```

---

### Task 5: Add tests for analytics and claims endpoints

**Files:**
- Modify: `packages/backend/src/routes/api.test.ts`

- [ ] **Step 1: Add analytics and claims endpoint tests**

Add these describe blocks at the end of the top-level `describe("API integration tests")` block in `packages/backend/src/routes/api.test.ts`, before its closing `});`. Also add the imports for the new routes in the `buildApp` function:

First, update the `buildApp` function to include the new routes:

```typescript
import { analyticsRoutes } from "./analytics.js";
import { claimsRoutes } from "./claims.js";
```

Add inside `buildApp()` after the existing register calls:

```typescript
  await app.register(analyticsRoutes);
  await app.register(claimsRoutes);
```

Then add these test blocks:

```typescript
  describe("GET /api/v1/analytics/summary", () => {
    it("returns analytics summary with expected fields", async () => {
      const res = await app.inject({ method: "GET", url: "/api/v1/analytics/summary" });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(typeof body.total_sdk_requests, "number");
      assert.equal(typeof body.total_claims, "number");
      assert.equal(typeof body.total_claim_amount, "number");
      assert.equal(typeof body.total_refund_amount, "number");
      assert.equal(typeof body.claims_by_trigger, "object");
      assert.equal(typeof body.unique_agents, "number");
      assert.equal(typeof body.unique_providers, "number");
    });
  });

  describe("GET /api/v1/analytics/timeseries", () => {
    it("returns timeseries data with expected structure", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/analytics/timeseries?granularity=daily&days=7",
      });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.granularity, "daily");
      assert.ok(Array.isArray(body.data));
    });
  });

  describe("GET /api/v1/claims", () => {
    it("returns an array", async () => {
      const res = await app.inject({ method: "GET", url: "/api/v1/claims" });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.ok(Array.isArray(body));
    });

    it("respects limit parameter", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/claims?limit=1",
      });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.ok(Array.isArray(body));
      assert.ok(body.length <= 1);
    });
  });
```

- [ ] **Step 2: Run the full test suite**

Run: `cd packages/backend && npx tsx --test src/utils/*.test.ts src/routes/*.test.ts`

Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/backend/src/routes/api.test.ts
git commit -m "test(backend): add analytics and claims endpoint tests"
```

---

### Task 6: Update seed script to generate claims

**Files:**
- Modify: `packages/backend/src/scripts/seed.ts`

- [ ] **Step 1: Add claim generation after call_record insertion in seed script**

The seed script already generates failure records with payment amounts. We need to add claim creation after each call_record insert.

Add the refund mapping constant after the `SOLANA_NETWORK` constant in `packages/backend/src/scripts/seed.ts`:

```typescript
const REFUND_PCT: Record<string, number> = {
  timeout: 100,
  error: 100,
  schema_mismatch: 75,
};
```

Replace the existing `await query(INSERT INTO call_records ...)` block (lines 95-119) with:

```typescript
      const insertResult = await query<{ id: string }>(
        `INSERT INTO call_records (
          provider_id, endpoint, timestamp, status_code, latency_ms,
          classification, payment_protocol, payment_amount, payment_asset,
          payment_network, payer_address, recipient_address, tx_hash,
          settlement_success, agent_id
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        RETURNING id`,
        [
          providerIds[provider.base_url],
          endpoint,
          timestamp.toISOString(),
          statusCode,
          latency,
          classification,
          protocol,
          paymentAmount,
          protocol ? USDC_MINT : null,
          protocol ? SOLANA_NETWORK : null,
          protocol ? `Agent${randomBytes(4).toString("hex")}` : null,
          protocol ? `Provider${randomBytes(4).toString("hex")}` : null,
          protocol ? randomBytes(32).toString("hex") : null,
          protocol ? (classification === "success") : null,
          "seeder",
        ],
      );

      // Create claim for qualifying failures
      if (classification !== "success" && paymentAmount && paymentAmount > 0) {
        const refundPct = REFUND_PCT[classification];
        if (refundPct !== undefined) {
          const refundAmount = Math.round((paymentAmount * refundPct) / 100);
          await query(
            `INSERT INTO claims (
              call_record_id, provider_id, agent_id, trigger_type,
              call_cost, refund_pct, refund_amount, status, created_at
            ) VALUES ($1, $2, 'seeder', $3, $4, $5, $6, 'simulated', $7)`,
            [
              insertResult.rows[0].id,
              providerIds[provider.base_url],
              classification,
              paymentAmount,
              refundPct,
              refundAmount,
              timestamp.toISOString(),
            ],
          );
        }
      }
```

- [ ] **Step 2: Add claims cleanup at the start of seed (for re-runs)**

Add this line right after the `console.log("Seeding database...");` line, before provider creation:

```typescript
  // Clean previous seed data for re-runs
  await query("DELETE FROM claims WHERE agent_id = 'seeder'");
```

- [ ] **Step 3: Test the seed script**

Run: `cd packages/backend && npx tsx src/scripts/seed.ts`

Expected: Seeding completes. Then verify claims exist:

Run: `cd packages/backend && npx tsx -e "import { query, pool } from './src/db.js'; const r = await query('SELECT COUNT(*) as count FROM claims'); console.log('Claims:', r.rows[0].count); await pool.end();"`

Expected: Claims count > 0 (should be roughly 10-20% of total records, since ~85% of records have payment data and ~3% average failure rate).

- [ ] **Step 4: Commit**

```bash
git add packages/backend/src/scripts/seed.ts
git commit -m "feat(backend): generate claims in seed script for demo data"
```

---

### Task 7: Add scorecard API client methods for analytics

**Files:**
- Modify: `packages/scorecard/src/api/client.ts`

- [ ] **Step 1: Add TypeScript interfaces and API methods**

Add these interfaces after the existing `TimeseriesData` interface in `packages/scorecard/src/api/client.ts`:

```typescript
export interface AnalyticsSummary {
  total_sdk_requests: number;
  total_claims: number;
  total_claim_amount: number;
  total_refund_amount: number;
  claims_by_trigger: Record<string, number>;
  unique_agents: number;
  unique_providers: number;
}

export interface AnalyticsTimeseriesPoint {
  bucket: string;
  requests: number;
  claims: number;
  refund_amount: number;
}

export interface AnalyticsTimeseries {
  granularity: "hourly" | "daily";
  data: AnalyticsTimeseriesPoint[];
}
```

Add these methods to the `api` object:

```typescript
  getAnalyticsSummary: () => get<AnalyticsSummary>("/analytics/summary"),
  getAnalyticsTimeseries: (granularity = "daily", days = 7) =>
    get<AnalyticsTimeseries>(`/analytics/timeseries?granularity=${granularity}&days=${days}`),
```

- [ ] **Step 2: Commit**

```bash
git add packages/scorecard/src/api/client.ts
git commit -m "feat(scorecard): add analytics API client methods"
```

---

### Task 8: Add useAnalytics hook

**Files:**
- Create: `packages/scorecard/src/hooks/useAnalytics.ts`

- [ ] **Step 1: Create the hook**

Create `packages/scorecard/src/hooks/useAnalytics.ts`:

```typescript
import { useState, useEffect, useCallback } from "react";
import { api, type AnalyticsSummary, type AnalyticsTimeseries } from "../api/client";

export function useAnalytics(refreshIntervalMs = 30_000) {
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [timeseries, setTimeseries] = useState<AnalyticsTimeseries | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [summaryData, timeseriesData] = await Promise.all([
        api.getAnalyticsSummary(),
        api.getAnalyticsTimeseries("daily", 7),
      ]);
      setSummary(summaryData);
      setTimeseries(timeseriesData);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch analytics");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, refreshIntervalMs);
    return () => clearInterval(timer);
  }, [refresh, refreshIntervalMs]);

  return { summary, timeseries, loading, error };
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/scorecard/src/hooks/useAnalytics.ts
git commit -m "feat(scorecard): add useAnalytics hook for data fetching"
```

---

### Task 9: Build NetworkActivity panel component

**Files:**
- Create: `packages/scorecard/src/components/NetworkActivity.tsx`

- [ ] **Step 1: Create the NetworkActivity component**

Create `packages/scorecard/src/components/NetworkActivity.tsx`:

```tsx
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { useAnalytics } from "../hooks/useAnalytics";

function formatUsd(microUnits: number): string {
  return `$${(microUnits / 1_000_000).toFixed(2)}`;
}

function formatNumber(n: number): string {
  return n.toLocaleString();
}

const TRIGGER_LABELS: Record<string, string> = {
  timeout: "Timeout",
  error: "HTTP Error",
  schema_mismatch: "Schema Violation",
  latency_sla: "Latency SLA",
};

export function NetworkActivity() {
  const { summary, timeseries, loading, error } = useAnalytics();

  if (loading) {
    return <p className="text-neutral-500 font-mono text-sm">Loading network activity...</p>;
  }

  if (error || !summary) {
    return null;
  }

  const chartData = (timeseries?.data ?? []).map((d) => ({
    label: new Date(d.bucket).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
    requests: d.requests,
    claims: d.claims,
  }));

  return (
    <div className="mb-8 border-b border-border pb-8">
      <h2 className="font-serif text-lg text-neutral-300 mb-4">Network Activity</h2>

      <div className="grid grid-cols-3 gap-6 mb-6">
        <div>
          <p className="text-xs text-neutral-500 uppercase tracking-widest font-sans mb-1">
            SDK Requests
          </p>
          <p className="text-2xl font-mono text-neutral-200">
            {formatNumber(summary.total_sdk_requests)}
          </p>
        </div>
        <div>
          <p className="text-xs text-neutral-500 uppercase tracking-widest font-sans mb-1">
            Claims Triggered
          </p>
          <p className="text-2xl font-mono text-copper">
            {formatNumber(summary.total_claims)}
          </p>
        </div>
        <div>
          <p className="text-xs text-neutral-500 uppercase tracking-widest font-sans mb-1">
            Refund Amount
          </p>
          <p className="text-2xl font-mono text-copper">
            {formatUsd(summary.total_refund_amount)}
          </p>
        </div>
      </div>

      {Object.keys(summary.claims_by_trigger).length > 0 && (
        <div className="mb-6">
          <p className="text-xs text-neutral-500 uppercase tracking-widest font-sans mb-2">
            Claims by Trigger
          </p>
          <div className="flex gap-4 font-mono text-sm">
            {Object.entries(summary.claims_by_trigger).map(([trigger, count]) => (
              <span key={trigger} className="text-neutral-400">
                <span className="text-sienna">{count}</span>
                {" "}
                {TRIGGER_LABELS[trigger] ?? trigger}
              </span>
            ))}
          </div>
        </div>
      )}

      {chartData.length > 0 && (
        <div>
          <p className="text-xs text-neutral-500 uppercase tracking-widest font-sans mb-2">
            7-Day Activity
          </p>
          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={chartData}>
              <XAxis
                dataKey="label"
                tick={{ fill: "#5A6B7A", fontSize: 10 }}
                interval="preserveStartEnd"
              />
              <YAxis tick={{ fill: "#5A6B7A", fontSize: 10 }} />
              <Tooltip
                contentStyle={{
                  background: "#1A1917",
                  border: "1px solid #333330",
                  color: "#ccc",
                  fontFamily: "JetBrains Mono",
                  fontSize: 12,
                }}
              />
              <Bar dataKey="requests" fill="#5A6B7A" name="Requests" />
              <Bar dataKey="claims" fill="#B87333" name="Claims" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/scorecard/src/components/NetworkActivity.tsx
git commit -m "feat(scorecard): add NetworkActivity panel component"
```

---

### Task 10: Wire NetworkActivity into the scorecard App

**Files:**
- Modify: `packages/scorecard/src/components/ProviderTable.tsx`

- [ ] **Step 1: Add NetworkActivity above the provider table**

In `packages/scorecard/src/components/ProviderTable.tsx`, add the import at the top:

```typescript
import { NetworkActivity } from "./NetworkActivity";
```

Then wrap the return JSX so NetworkActivity renders above the table. Replace the opening `<div>` in the return statement (line 31) with:

```tsx
    <div>
      <NetworkActivity />
```

No other changes needed — the existing table renders below.

- [ ] **Step 2: Verify the scorecard renders**

Run: `cd packages/scorecard && npx vite`

Expected: Open `http://localhost:5173`. The "Network Activity" panel should appear above the provider rankings table, showing SDK requests, claims triggered, refund amount, trigger breakdown, and the 7-day bar chart. (Requires the backend to be running with seeded data for numbers to show.)

- [ ] **Step 3: Commit**

```bash
git add packages/scorecard/src/components/ProviderTable.tsx
git commit -m "feat(scorecard): wire NetworkActivity panel into dashboard"
```

---

### Task 11: Update CLAUDE.md with new endpoints

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add new endpoints to the API Endpoints section**

In the root `CLAUDE.md`, add these lines to the `## API Endpoints` section after the existing entries:

```markdown
- `GET /api/v1/analytics/summary` — network-wide aggregate stats (public)
- `GET /api/v1/analytics/timeseries` — requests and claims over time (public)
- `GET /api/v1/claims` — list individual claim records with filters (public)
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add analytics and claims endpoints to CLAUDE.md"
```
