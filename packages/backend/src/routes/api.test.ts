import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import Fastify from "fastify";
import { initDb, query, pool } from "../db.js";
import { healthRoutes } from "./health.js";
import { recordsRoutes } from "./records.js";
import { providersRoutes } from "./providers.js";
import { analyticsRoutes } from "./analytics.js";
import { claimsRoutes } from "./claims.js";

const TEST_API_KEY = `test-key-${randomUUID()}`;
const TEST_KEY_HASH = createHash("sha256").update(TEST_API_KEY).digest("hex");
const TEST_LABEL = `test-agent-${randomUUID()}`;

async function buildApp() {
  const app = Fastify();
  await app.register(healthRoutes);
  await app.register(recordsRoutes);
  await app.register(providersRoutes);
  await app.register(analyticsRoutes);
  await app.register(claimsRoutes);
  return app;
}

describe("API integration tests", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  before(async () => {
    await initDb();
    await query(
      "INSERT INTO api_keys (key_hash, label) VALUES ($1, $2) ON CONFLICT (key_hash) DO NOTHING",
      [TEST_KEY_HASH, TEST_LABEL],
    );
    app = await buildApp();
  });

  after(async () => {
    await query("DELETE FROM call_records WHERE agent_id = $1", [TEST_LABEL]);
    await query("DELETE FROM api_keys WHERE key_hash = $1", [TEST_KEY_HASH]);
    await app.close();
    await pool.end();
  });

  describe("GET /health", () => {
    it("returns 200 with status ok", async () => {
      const res = await app.inject({ method: "GET", url: "/health" });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.status, "ok");
    });
  });

  describe("POST /api/v1/records", () => {
    it("without auth returns 401", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/records",
        payload: { records: [] },
      });
      assert.equal(res.statusCode, 401);
    });

    it("with invalid key returns 401", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/records",
        headers: { authorization: "Bearer bad-key-that-does-not-exist" },
        payload: { records: [] },
      });
      assert.equal(res.statusCode, 401);
    });

    it("with empty records array returns 400", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/records",
        headers: { authorization: `Bearer ${TEST_API_KEY}` },
        payload: { records: [] },
      });
      assert.equal(res.statusCode, 400);
      const body = res.json();
      assert.ok(body.error);
    });

    it("with valid key accepts records and returns accepted count", async () => {
      const hostname = `test-${randomUUID()}.example.com`;
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/records",
        headers: { authorization: `Bearer ${TEST_API_KEY}` },
        payload: {
          records: [
            {
              hostname,
              endpoint: "/v1/chat",
              timestamp: new Date().toISOString(),
              status_code: 200,
              latency_ms: 150,
              classification: "success",
            },
            {
              hostname,
              endpoint: "/v1/chat",
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
      assert.equal(body.accepted, 2);
      assert.ok(Array.isArray(body.provider_ids));
      assert.equal(body.provider_ids.length, 1);

      // Clean up the provider we just created
      const providerId = body.provider_ids[0];
      await query("DELETE FROM call_records WHERE provider_id = $1", [providerId]);
      await query("DELETE FROM providers WHERE id = $1", [providerId]);
    });

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

      await query("DELETE FROM call_records WHERE provider_id = $1", [providerId]);
      await query("DELETE FROM providers WHERE id = $1", [providerId]);
    });
  });

  describe("GET /api/v1/providers", () => {
    it("returns an array", async () => {
      const res = await app.inject({ method: "GET", url: "/api/v1/providers" });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.ok(Array.isArray(body));
    });
  });

  describe("GET /api/v1/providers/:id", () => {
    it("with invalid UUID returns 404", async () => {
      const fakeId = randomUUID();
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/providers/${fakeId}`,
      });
      assert.equal(res.statusCode, 404);
    });
  });

  describe("GET /api/v1/providers/:id/timeseries", () => {
    it("with invalid UUID returns 404", async () => {
      const fakeId = randomUUID();
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/providers/${fakeId}/timeseries`,
      });
      assert.equal(res.statusCode, 404);
    });
  });

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
});
