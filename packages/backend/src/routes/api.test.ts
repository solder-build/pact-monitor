import { describe, it, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash, randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";
import Fastify from "fastify";
import { initDb, query, getOne, pool } from "../db.js";
import { requireApiKey } from "../middleware/auth.js";
import { healthRoutes } from "./health.js";
import { recordsRoutes } from "./records.js";
import { providersRoutes } from "./providers.js";
import { analyticsRoutes } from "./analytics.js";
import { claimsRoutes } from "./claims.js";
import { claimsSubmitRoute } from "./claims-submit.js";
import { poolsRoute } from "./pools.js";

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

// buildTestApp creates a fresh Fastify instance (no pool.end — caller manages lifecycle)
async function buildTestApp() {
  const app = Fastify();
  await app.register(healthRoutes);
  await app.register(recordsRoutes);
  await app.register(providersRoutes);
  await app.register(analyticsRoutes);
  await app.register(claimsRoutes);
  await app.register(claimsSubmitRoute);
  await app.register(poolsRoute);
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

  // Step 1.1 — auth middleware decorates agentPubkey
  describe("auth middleware agentPubkey decoration", () => {
    it("decorates request.agentPubkey from api_keys row", async () => {
      const testApp = await buildTestApp();
      const key = `pact_${randomBytes(24).toString("hex")}`;
      const hash = createHash("sha256").update(key).digest("hex");
      await query(
        "INSERT INTO api_keys (key_hash, label, agent_pubkey) VALUES ($1, $2, $3)",
        [hash, "test-agent", "AgentPubkey111111111111111111111111111111111"],
      );

      testApp.get("/api/v1/debug/whoami", { preHandler: requireApiKey }, async (req) => {
        const r = req as FastifyRequest & { agentId: string; agentPubkey: string | null };
        return { agentId: r.agentId, agentPubkey: r.agentPubkey };
      });

      const resp = await testApp.inject({
        method: "GET",
        url: "/api/v1/debug/whoami",
        headers: { authorization: `Bearer ${key}` },
      });

      assert.equal(resp.statusCode, 200);
      const body = resp.json();
      assert.equal(body.agentId, "test-agent");
      assert.equal(body.agentPubkey, "AgentPubkey111111111111111111111111111111111");

      await query("DELETE FROM api_keys WHERE key_hash = $1", [hash]);
      await testApp.close();
    });
  });

  // Step 1.7 — records route ignores client-supplied agent_pubkey
  describe("POST /api/v1/records agent_pubkey binding", () => {
    it("ignores client-supplied agent_pubkey and uses api_key binding", async () => {
      const testApp = await buildTestApp();
      const key = `pact_${randomBytes(24).toString("hex")}`;
      const hash = createHash("sha256").update(key).digest("hex");
      const boundPubkey = "BoundPubkey111111111111111111111111111111111";
      const attackerPubkey = "AttackerPubkey11111111111111111111111111111";
      const agentLabel = "test-agent-pubkey";
      await query(
        "INSERT INTO api_keys (key_hash, label, agent_pubkey) VALUES ($1, $2, $3)",
        [hash, agentLabel, boundPubkey],
      );

      const hostname = `pubkey-test-${randomUUID()}.example.com`;
      const resp = await testApp.inject({
        method: "POST",
        url: "/api/v1/records",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        payload: {
          records: [{
            hostname,
            endpoint: "/v1",
            timestamp: new Date().toISOString(),
            status_code: 200,
            latency_ms: 50,
            classification: "success",
            agent_pubkey: attackerPubkey,
          }],
        },
      });

      assert.equal(resp.statusCode, 200);
      const stored = await getOne<{ agent_pubkey: string }>(
        "SELECT agent_pubkey FROM call_records WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 1",
        [agentLabel],
      );
      assert.equal(stored?.agent_pubkey, boundPubkey);

      await query("DELETE FROM call_records WHERE agent_id = $1", [agentLabel]);
      await query("DELETE FROM providers WHERE base_url = $1", [hostname]);
      await query("DELETE FROM api_keys WHERE key_hash = $1", [hash]);
      await testApp.close();
    });
  });

  // Step 1.11 — claims-submit auth and ownership checks
  describe("POST /api/v1/claims/submit auth", () => {
    it("rejects missing auth with 401", async () => {
      const testApp = await buildTestApp();
      const resp = await testApp.inject({
        method: "POST",
        url: "/api/v1/claims/submit",
        payload: { callRecordId: "00000000-0000-0000-0000-000000000000", providerHostname: "x.com" },
      });
      assert.equal(resp.statusCode, 401);
      await testApp.close();
    });

    it("rejects key/call_record agent mismatch with 403", async () => {
      const testApp = await buildTestApp();
      const keyA = `pact_${randomBytes(24).toString("hex")}`;
      const hashA = createHash("sha256").update(keyA).digest("hex");
      await query(
        "INSERT INTO api_keys (key_hash, label, agent_pubkey) VALUES ($1, $2, $3)",
        [hashA, "agent-a", null],
      );
      const provHostname = `mismatch-test-${randomUUID()}.example.com`;
      const prov = await getOne<{ id: string }>(
        "INSERT INTO providers (name, base_url) VALUES ($1, $2) RETURNING id",
        [provHostname, provHostname],
      );
      const rec = await getOne<{ id: string }>(
        `INSERT INTO call_records (provider_id, endpoint, timestamp, status_code,
           latency_ms, classification, agent_id, agent_pubkey)
         VALUES ($1, '/v1', NOW(), 500, 100, 'error', 'agent-b', NULL) RETURNING id`,
        [prov!.id],
      );
      const resp = await testApp.inject({
        method: "POST",
        url: "/api/v1/claims/submit",
        headers: { authorization: `Bearer ${keyA}`, "content-type": "application/json" },
        payload: { callRecordId: rec!.id, providerHostname: provHostname },
      });
      assert.equal(resp.statusCode, 403);

      await query("DELETE FROM call_records WHERE id = $1", [rec!.id]);
      await query("DELETE FROM providers WHERE id = $1", [prov!.id]);
      await query("DELETE FROM api_keys WHERE key_hash = $1", [hashA]);
      await testApp.close();
    });

    it("rejects providerHostname mismatch with call record's provider with 400", async () => {
      const testApp = await buildTestApp();
      const keyA = `pact_${randomBytes(24).toString("hex")}`;
      const hashA = createHash("sha256").update(keyA).digest("hex");
      const agentLabel = `agent-a-${randomUUID()}`;
      await query(
        "INSERT INTO api_keys (key_hash, label, agent_pubkey) VALUES ($1, $2, $3)",
        [hashA, agentLabel, "AgentPubkey1111111111111111111111111111111"],
      );
      const provXHostname = `provider-x-${randomUUID()}.example.com`;
      const provYHostname = `provider-y-${randomUUID()}.example.com`;
      const provX = await getOne<{ id: string }>(
        "INSERT INTO providers (name, base_url) VALUES ($1, $2) RETURNING id",
        [provXHostname, provXHostname],
      );
      const provY = await getOne<{ id: string }>(
        "INSERT INTO providers (name, base_url) VALUES ($1, $2) RETURNING id",
        [provYHostname, provYHostname],
      );
      // Call record is against provider X, but attacker will pass provider Y
      const rec = await getOne<{ id: string }>(
        `INSERT INTO call_records (provider_id, endpoint, timestamp, status_code,
           latency_ms, classification, agent_id, agent_pubkey)
         VALUES ($1, '/v1', NOW(), 500, 100, 'error', $2, $3) RETURNING id`,
        [provX!.id, agentLabel, "AgentPubkey1111111111111111111111111111111"],
      );
      const resp = await testApp.inject({
        method: "POST",
        url: "/api/v1/claims/submit",
        headers: { authorization: `Bearer ${keyA}`, "content-type": "application/json" },
        payload: { callRecordId: rec!.id, providerHostname: provYHostname },
      });
      assert.equal(resp.statusCode, 400);
      const body = resp.json();
      assert.equal(body.error, "providerHostname does not match call record");

      await query("DELETE FROM call_records WHERE id = $1", [rec!.id]);
      await query("DELETE FROM providers WHERE id IN ($1, $2)", [provX!.id, provY!.id]);
      await query("DELETE FROM api_keys WHERE key_hash = $1", [hashA]);
      await testApp.close();
    });

    it("passes ownership + provider gates when agent matches and providerHostname matches (pre-policy 404)", async () => {
      const testApp = await buildTestApp();
      const keyA = `pact_${randomBytes(24).toString("hex")}`;
      const hashA = createHash("sha256").update(keyA).digest("hex");
      const agentLabel = `agent-happy-${randomUUID()}`;
      await query(
        "INSERT INTO api_keys (key_hash, label, agent_pubkey) VALUES ($1, $2, $3)",
        [hashA, agentLabel, "AgentPubkey2222222222222222222222222222222"],
      );
      const provHostname = `happy-path-${randomUUID()}.example.com`;
      const prov = await getOne<{ id: string }>(
        "INSERT INTO providers (name, base_url) VALUES ($1, $2) RETURNING id",
        [provHostname, provHostname],
      );
      const rec = await getOne<{ id: string }>(
        `INSERT INTO call_records (provider_id, endpoint, timestamp, status_code,
           latency_ms, classification, agent_id, agent_pubkey)
         VALUES ($1, '/v1', NOW(), 500, 100, 'error', $2, $3) RETURNING id`,
        [prov!.id, agentLabel, "AgentPubkey2222222222222222222222222222222"],
      );
      const resp = await testApp.inject({
        method: "POST",
        url: "/api/v1/claims/submit",
        headers: { authorization: `Bearer ${keyA}`, "content-type": "application/json" },
        payload: { callRecordId: rec!.id, providerHostname: provHostname },
      });
      // Ownership + providerHostname gates pass through; we expect to fail later
      // in the pipeline (no on-chain policy seeded in test env → 404, or 500 if
      // the RPC call itself errors out). Assert only that we are NOT blocked
      // by 401/403/400 — which confirms the ownership and provider-match gates
      // let us through.
      assert.notEqual(resp.statusCode, 401);
      assert.notEqual(resp.statusCode, 403);
      assert.notEqual(resp.statusCode, 400);

      await query("DELETE FROM call_records WHERE id = $1", [rec!.id]);
      await query("DELETE FROM providers WHERE id = $1", [prov!.id]);
      await query("DELETE FROM api_keys WHERE key_hash = $1", [hashA]);
      await testApp.close();
    });
  });

  // Step 2.1 — oracle keypair module-scope cache
  test("oracle keypair cache returns same object reference across N calls", async () => {
    // ESM module exports are read-only — we cannot monkey-patch fs.readFileSync.
    // Instead we verify caching by identity: getCachedOracleKeypair() must return
    // the exact same Keypair object on every call after the first (proving no
    // re-read). We also confirm the public key matches the key we wrote.
    const { Keypair } = await import("@solana/web3.js");
    const fs = await import("fs");
    const os = await import("os");
    const path = await import("path");
    const tmpFile = path.join(os.tmpdir(), `pact-oracle-test-${Date.now()}.json`);
    const kp = Keypair.generate();
    fs.writeFileSync(tmpFile, JSON.stringify(Array.from(kp.secretKey)));

    const savedEnv = process.env.PACT_ORACLE_KEYPAIR;
    process.env.PACT_ORACLE_KEYPAIR = tmpFile;

    const { getCachedOracleKeypair, __resetOracleKeypairCacheForTests } = await import("../services/claim-settlement.js");
    __resetOracleKeypairCacheForTests();

    const a = getCachedOracleKeypair();
    const b = getCachedOracleKeypair();
    const c = getCachedOracleKeypair();

    // All calls must return the same cached object (reference equality).
    assert.strictEqual(a, b, "second call must return the cached keypair instance");
    assert.strictEqual(b, c, "third call must return the cached keypair instance");
    // And it must be the keypair we wrote.
    assert.equal(a.publicKey.toBase58(), kp.publicKey.toBase58());

    if (savedEnv === undefined) delete process.env.PACT_ORACLE_KEYPAIR;
    else process.env.PACT_ORACLE_KEYPAIR = savedEnv;
    fs.unlinkSync(tmpFile);
    __resetOracleKeypairCacheForTests();
  });

  // Step 2.2/2.3 — pools route: 503 on missing env, cache consistency
  test("GET /api/v1/pools returns 503 when SOLANA_PROGRAM_ID missing", async () => {
    const saved = process.env.SOLANA_PROGRAM_ID;
    delete process.env.SOLANA_PROGRAM_ID;
    const { __resetPoolCacheForTests } = await import("../routes/pools.js");
    __resetPoolCacheForTests();
    const app = await buildTestApp();
    const resp = await app.inject({ method: "GET", url: "/api/v1/pools" });
    assert.equal(resp.statusCode, 503);
    const body = resp.json();
    assert.equal(body.error, "Solana configuration unavailable");
    if (saved !== undefined) process.env.SOLANA_PROGRAM_ID = saved;
    await app.close();
  });

  test("GET /api/v1/pools sequential calls return consistent status (error responses not cached)", async () => {
    // With no validator running both calls fall through to the RPC error path
    // and both return 502. Asserts that error responses are NOT cached (i.e.
    // the cache is not poisoned) and both requests are treated equally.
    process.env.SOLANA_PROGRAM_ID = process.env.SOLANA_PROGRAM_ID ?? "4Z1Y3W49U2Cn6bz9UpkahVP7LaeobQ4cAaEt3uNaqSob";
    const { __resetPoolCacheForTests, __getPoolCacheTimestampForTests } = await import("../routes/pools.js");
    __resetPoolCacheForTests();
    const app = await buildTestApp();
    const r1 = await app.inject({ method: "GET", url: "/api/v1/pools" });
    const r2 = await app.inject({ method: "GET", url: "/api/v1/pools" });
    assert.equal(r1.statusCode, r2.statusCode, "sequential calls should return identical status");
    // Errors must NOT populate the cache.
    assert.equal(
      __getPoolCacheTimestampForTests(),
      null,
      "cache should remain empty after RPC error responses",
    );
    await app.close();
  });
});
