import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import Fastify from "fastify";
import { initDb, query, pool } from "../db.js";
import { healthRoutes } from "./health.js";
import { recordsRoutes } from "./records.js";
import { providersRoutes } from "./providers.js";

const TEST_API_KEY = `test-key-${randomUUID()}`;
const TEST_KEY_HASH = createHash("sha256").update(TEST_API_KEY).digest("hex");
const TEST_LABEL = `test-agent-${randomUUID()}`;

async function buildApp() {
  const app = Fastify();
  await app.register(healthRoutes);
  await app.register(recordsRoutes);
  await app.register(providersRoutes);
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
});
