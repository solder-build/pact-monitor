import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { query, pool } from "../db.js";
import { premiumRoutes } from "./premium.js";

async function buildApp() {
  const app = Fastify();
  await app.register(premiumRoutes);
  return app;
}

describe("GET /api/v1/premium/:hostname", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  const canonicalHost = `api.premium-test-${randomUUID().slice(0, 8)}.example`;
  let providerId: string;

  before(async () => {
    // Assumes schema is already applied (shared dev DB). Individual tests
    // seed and tear down their own fixtures.
    app = await buildApp();

    // Seed: a canonical provider with 2 success + 1 error records in the
    // last 7 days so failureRate ~= 0.333 and sampleSize = 3.
    const res = await query<{ id: string }>(
      "INSERT INTO providers (name, base_url) VALUES ($1, $2) RETURNING id",
      [canonicalHost, canonicalHost],
    );
    providerId = res.rows[0].id;

    const now = new Date();
    const rows = [
      { classification: "success", offsetMs: 0 },
      { classification: "success", offsetMs: 1000 },
      { classification: "error", offsetMs: 2000 },
    ];
    for (const r of rows) {
      await query(
        `INSERT INTO call_records (
           provider_id, endpoint, timestamp, status_code, latency_ms, classification
         ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          providerId,
          "/v1/test",
          new Date(now.getTime() - r.offsetMs).toISOString(),
          r.classification === "success" ? 200 : 500,
          120,
          r.classification,
        ],
      );
    }
  });

  after(async () => {
    await query("DELETE FROM call_records WHERE provider_id = $1", [providerId]);
    await query("DELETE FROM providers WHERE id = $1", [providerId]);
    await app.close();
    await pool.end();
  });

  it("returns 200 with documented shape for a known hostname", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/premium/${canonicalHost}`,
    });
    assert.equal(res.statusCode, 200);
    assert.equal(
      res.headers["cache-control"],
      "public, max-age=60",
      "Cache-Control header must be present",
    );
    const body = res.json();
    assert.equal(body.schema_version, 1);
    assert.equal(body.hostname, canonicalHost);
    assert.equal(typeof body.premium.rateBps, "number");
    assert.ok(body.premium.rateBps > 0);
    assert.ok(
      ["reliable", "elevated", "high_risk"].includes(body.premium.tier),
      `tier must be lowercase snake_case, got ${body.premium.tier}`,
    );
    assert.equal(body.reliability.sampleSize, 3);
    assert.equal(body.reliability.windowSeconds, 604800);
    assert.ok(body.reliability.failureRate > 0.3);
    assert.ok(body.reliability.failureRate < 0.4);
    assert.ok(typeof body.asOf === "string");
    assert.equal(body.settlement, "pact_network_v1");
    assert.ok(typeof body.source === "string");
  });

  it("is case-insensitive (uppercase input)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/premium/${canonicalHost.toUpperCase()}`,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.hostname, canonicalHost);
    assert.equal(body.reliability.sampleSize, 3);
  });

  it("strips scheme and path", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/premium/${encodeURIComponent(`https://${canonicalHost}/v0/webhooks`)}`,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.hostname, canonicalHost);
  });

  it("returns 404 with documented error shape for unknown hostname", async () => {
    const unknown = `does-not-exist-${randomUUID().slice(0, 8)}.example`;
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/premium/${unknown}`,
    });
    assert.equal(res.statusCode, 404);
    const body = res.json();
    assert.equal(body.schema_version, 1);
    assert.equal(body.error, "not_tracked");
    assert.equal(body.hostname, unknown);
  });

  it("never returns a default rate on unknown hostname", async () => {
    const unknown = `also-absent-${randomUUID().slice(0, 8)}.example`;
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/premium/${unknown}`,
    });
    assert.equal(res.statusCode, 404);
    const body = res.json();
    assert.equal(body.premium, undefined);
    assert.equal(body.reliability, undefined);
  });
});
