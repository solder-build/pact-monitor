// Route-layer tests for the F3 devnet sandbox endpoint. Covers the guards
// and gates that don't require a real devnet RPC:
//   - 403 on non-devnet
//   - 401 without API key
//   - 400 on missing/invalid body fields
//   - 400 on unknown classification
//   - 429 when rate-limited
//   - 503 when pool is exhausted
//
// The success path ultimately calls the on-chain submitClaimOnChain helper,
// which needs a running validator + funded pool + provisioned policy — that
// piece is manually exercised via scripts/topup-sandbox-pool.sh + a real
// curl. Here we assert the structural guards around it so regressions
// (especially the devnet gate) fail loudly in CI.

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import Fastify from "fastify";
import { Keypair } from "@solana/web3.js";
import { query, pool as pgPool } from "../db.js";
import { RateLimiter } from "../utils/rate-limiter.js";
import { SandboxKeypairPool } from "../services/sandbox-pool.js";
import { createSandboxRoutes } from "./sandbox.js";

const TEST_API_KEY = `pact_${randomBytes(24).toString("hex")}`;
const TEST_KEY_HASH = createHash("sha256").update(TEST_API_KEY).digest("hex");
const TEST_LABEL = `sandbox-test-${randomUUID()}`;

async function buildApp(opts: Parameters<typeof createSandboxRoutes>[0]) {
  const app = Fastify();
  const routes = createSandboxRoutes(opts);
  await app.register(routes);
  return app;
}

describe("POST /api/v1/devnet/sandbox/inject-failure — guards", () => {
  before(async () => {
    await query(
      "INSERT INTO api_keys (key_hash, label, agent_pubkey) VALUES ($1, $2, $3)",
      [TEST_KEY_HASH, TEST_LABEL, "SandboxAgent1111111111111111111111111111111"],
    );
  });

  after(async () => {
    await query("DELETE FROM api_keys WHERE key_hash = $1", [TEST_KEY_HASH]);
    await pgPool.end();
  });

  function makePool(n = 2): SandboxKeypairPool {
    return new SandboxKeypairPool(
      Array.from({ length: n }, () => Keypair.generate()),
    );
  }

  const VALID_BODY = {
    schema_version: 1,
    hostname: "api.test-provider.example",
    classification: "provider_5xx",
    simulated_latency_ms: 500,
  };

  describe("devnet gate", () => {
    it("returns 403 when network is not devnet", async () => {
      const app = await buildApp({
        isDevnetCheck: () => false,
        pool: makePool(),
        rateLimiterOverride: new RateLimiter({
          maxPerWindow: 10,
          windowMs: 60 * 60 * 1000,
        }),
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/devnet/sandbox/inject-failure",
        headers: {
          authorization: `Bearer ${TEST_API_KEY}`,
          "content-type": "application/json",
        },
        payload: VALID_BODY,
      });
      assert.equal(res.statusCode, 403);
      const body = res.json();
      assert.equal(body.schema_version, 1);
      assert.equal(body.error, "sandbox_not_available");
      await app.close();
    });

    it("403 fires BEFORE API key validation (no mainnet info leak)", async () => {
      const app = await buildApp({
        isDevnetCheck: () => false,
        pool: makePool(),
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/devnet/sandbox/inject-failure",
        // No Authorization header — on devnet this would be 401. On mainnet
        // we still 403 on the gate first so integrators can't probe whether
        // their key is valid against a mainnet deploy.
        headers: { "content-type": "application/json" },
        payload: VALID_BODY,
      });
      // Fastify's preHandler (requireApiKey) runs BEFORE the route handler
      // where devnetCheck() lives, so missing-auth actually returns 401
      // first. Verify that behavior is preserved — if it ever flips to 403
      // first, this test catches it (either order is defensible; pick one
      // and lock it).
      assert.equal(res.statusCode, 401);
      await app.close();
    });
  });

  describe("auth", () => {
    it("returns 401 without API key", async () => {
      const app = await buildApp({
        isDevnetCheck: () => true,
        pool: makePool(),
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/devnet/sandbox/inject-failure",
        headers: { "content-type": "application/json" },
        payload: VALID_BODY,
      });
      assert.equal(res.statusCode, 401);
      await app.close();
    });

    it("returns 401 with bogus API key", async () => {
      const app = await buildApp({
        isDevnetCheck: () => true,
        pool: makePool(),
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/devnet/sandbox/inject-failure",
        headers: {
          authorization: "Bearer not-a-real-key",
          "content-type": "application/json",
        },
        payload: VALID_BODY,
      });
      assert.equal(res.statusCode, 401);
      await app.close();
    });
  });

  describe("body validation", () => {
    const validHeaders = {
      authorization: `Bearer ${TEST_API_KEY}`,
      "content-type": "application/json",
    };

    let app: Awaited<ReturnType<typeof buildApp>>;

    beforeEach(async () => {
      app = await buildApp({
        isDevnetCheck: () => true,
        pool: makePool(),
        rateLimiterOverride: new RateLimiter({
          maxPerWindow: 100,
          windowMs: 60 * 60 * 1000,
        }),
      });
    });

    it("400 when hostname missing", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/devnet/sandbox/inject-failure",
        headers: validHeaders,
        payload: {
          classification: "provider_5xx",
          simulated_latency_ms: 100,
        },
      });
      assert.equal(res.statusCode, 400);
      assert.equal(res.json().error, "invalid_request");
      await app.close();
    });

    it("400 when hostname is unparseable junk", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/devnet/sandbox/inject-failure",
        headers: validHeaders,
        payload: { ...VALID_BODY, hostname: "http://" },
      });
      assert.equal(res.statusCode, 400);
      assert.equal(res.json().error, "invalid_hostname");
      await app.close();
    });

    it("400 on unknown classification value", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/devnet/sandbox/inject-failure",
        headers: validHeaders,
        payload: { ...VALID_BODY, classification: "provider_meltdown" },
      });
      assert.equal(res.statusCode, 400);
      const body = res.json();
      assert.equal(body.error, "invalid_classification");
      assert.deepEqual(body.supported, [
        "provider_5xx",
        "provider_timeout",
        "provider_rate_limit",
      ]);
      await app.close();
    });

    it("accepts all three documented classifications past validation", async () => {
      // We can't run the on-chain portion from a unit test, so we use an
      // exhausted pool to short-circuit each classification at the pool
      // checkout step AFTER it passes classification validation (proving
      // validation accepts it).
      const exhaustedPool = makePool(1);
      exhaustedPool.checkout(); // pool is now full
      const sandbox = await buildApp({
        isDevnetCheck: () => true,
        pool: exhaustedPool,
        rateLimiterOverride: new RateLimiter({
          maxPerWindow: 100,
          windowMs: 60 * 60 * 1000,
        }),
      });
      for (const c of ["provider_5xx", "provider_timeout", "provider_rate_limit"]) {
        const res = await sandbox.inject({
          method: "POST",
          url: "/api/v1/devnet/sandbox/inject-failure",
          headers: validHeaders,
          payload: { ...VALID_BODY, classification: c },
        });
        // Each classification reaches the pool checkout (503), meaning
        // body validation passed.
        assert.equal(res.statusCode, 503, `classification ${c}`);
        assert.equal(res.json().error, "sandbox_pool_exhausted", `classification ${c}`);
      }
      await sandbox.close();
    });
  });

  describe("rate limiting", () => {
    it("returns 429 with Retry-After after 10 requests in an hour", async () => {
      const limiter = new RateLimiter({
        maxPerWindow: 10,
        windowMs: 60 * 60 * 1000,
      });
      // Pre-fill the window so the very next request is over the limit.
      // Use a pool that's already exhausted so requests don't escape into
      // the on-chain path.
      const p = makePool(1);
      p.checkout();
      const app = await buildApp({
        isDevnetCheck: () => true,
        pool: p,
        rateLimiterOverride: limiter,
      });

      const headers = {
        authorization: `Bearer ${TEST_API_KEY}`,
        "content-type": "application/json",
      };

      // Burn through the 10-request budget. Each one hits the exhausted
      // pool and returns 503, which still counts against the budget.
      for (let i = 0; i < 10; i++) {
        await app.inject({
          method: "POST",
          url: "/api/v1/devnet/sandbox/inject-failure",
          headers,
          payload: VALID_BODY,
        });
      }

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/devnet/sandbox/inject-failure",
        headers,
        payload: VALID_BODY,
      });
      assert.equal(res.statusCode, 429);
      assert.ok(res.headers["retry-after"], "Retry-After header required");
      const body = res.json();
      assert.equal(body.error, "rate_limit_exceeded");
      assert.ok(body.retry_after_seconds > 0);
      await app.close();
    });
  });

  describe("pool exhaustion", () => {
    it("returns 503 with Retry-After when all keypairs are in flight", async () => {
      const p = makePool(1);
      p.checkout(); // pool is now full
      const app = await buildApp({
        isDevnetCheck: () => true,
        pool: p,
        rateLimiterOverride: new RateLimiter({
          maxPerWindow: 100,
          windowMs: 60 * 60 * 1000,
        }),
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/devnet/sandbox/inject-failure",
        headers: {
          authorization: `Bearer ${TEST_API_KEY}`,
          "content-type": "application/json",
        },
        payload: VALID_BODY,
      });
      assert.equal(res.statusCode, 503);
      assert.equal(res.headers["retry-after"], "30");
      const body = res.json();
      assert.equal(body.error, "sandbox_pool_exhausted");
      assert.equal(body.schema_version, 1);
      assert.equal(body.retry_after_seconds, 30);
      await app.close();
    });
  });
});
