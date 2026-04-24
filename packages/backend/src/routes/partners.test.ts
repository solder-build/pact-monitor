// Integration tests for F1 — admin referrer registration + partners read
// endpoint. Exercises the full stack: schema ALTER TABLE columns, admin
// PATCH validation + atomic write, and the partners GET auth + totals +
// pagination shape.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import Fastify from "fastify";
import { query, getOne, pool as pgPool } from "../db.js";
import { adminRoutes } from "./admin.js";
import { partnersRoutes } from "./partners.js";

async function buildApp() {
  const app = Fastify();
  await app.register(adminRoutes);
  await app.register(partnersRoutes);
  return app;
}

const ADMIN_TOKEN = `admin-test-${randomUUID()}`;
const REFERRER_PUBKEY = `RefPartnerTest111111111111111111111111111111`.slice(0, 44);
const BAD_REFERRER = `RefOther22222222222222222222222222222222222`.slice(0, 44);

const REF_API_KEY = `pact_${randomBytes(24).toString("hex")}`;
const REF_KEY_HASH = createHash("sha256").update(REF_API_KEY).digest("hex");
const REF_LABEL = `ref-partner-${randomUUID()}`;

const OUTSIDER_API_KEY = `pact_${randomBytes(24).toString("hex")}`;
const OUTSIDER_KEY_HASH = createHash("sha256").update(OUTSIDER_API_KEY).digest("hex");
const OUTSIDER_LABEL = `outsider-${randomUUID()}`;

describe("F1 referrer registration + partners read endpoint", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  const previousAdminToken = process.env.ADMIN_TOKEN;

  before(async () => {
    process.env.ADMIN_TOKEN = ADMIN_TOKEN;
    app = await buildApp();

    // Seed: one key to become a referrer; one key that stays an outsider.
    await query(
      "INSERT INTO api_keys (key_hash, label, agent_pubkey) VALUES ($1, $2, $3)",
      [REF_KEY_HASH, REF_LABEL, "RefAgent1111111111111111111111111111111111"],
    );
    await query(
      "INSERT INTO api_keys (key_hash, label, agent_pubkey) VALUES ($1, $2, $3)",
      [OUTSIDER_KEY_HASH, OUTSIDER_LABEL, "OutsiderAgent111111111111111111111111111111"],
    );
  });

  after(async () => {
    await query("DELETE FROM claims WHERE referrer_pubkey = $1", [REFERRER_PUBKEY]);
    await query("DELETE FROM api_keys WHERE label IN ($1, $2)", [REF_LABEL, OUTSIDER_LABEL]);
    if (previousAdminToken === undefined) {
      delete process.env.ADMIN_TOKEN;
    } else {
      process.env.ADMIN_TOKEN = previousAdminToken;
    }
    await app.close();
    await pgPool.end();
  });

  describe("PATCH /api/v1/admin/api-keys/:label/referrer", () => {
    it("rejects requests without the admin token", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/admin/api-keys/${REF_LABEL}/referrer`,
        headers: { "content-type": "application/json" },
        payload: { referrer_pubkey: REFERRER_PUBKEY, referrer_share_bps: 500 },
      });
      assert.equal(res.statusCode, 401);
    });

    it("rejects out-of-range share_bps (>3000)", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/admin/api-keys/${REF_LABEL}/referrer`,
        headers: {
          authorization: `Bearer ${ADMIN_TOKEN}`,
          "content-type": "application/json",
        },
        payload: { referrer_pubkey: REFERRER_PUBKEY, referrer_share_bps: 3001 },
      });
      assert.equal(res.statusCode, 400);
      // Confirm the DB row was NOT partially written.
      const row = await getOne<{
        referrer_pubkey: string | null;
        referrer_share_bps: number | null;
      }>(
        "SELECT referrer_pubkey, referrer_share_bps FROM api_keys WHERE label = $1",
        [REF_LABEL],
      );
      assert.equal(row?.referrer_pubkey, null);
      assert.equal(row?.referrer_share_bps, null);
    });

    it("rejects half-set registration (pubkey without share)", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/admin/api-keys/${REF_LABEL}/referrer`,
        headers: {
          authorization: `Bearer ${ADMIN_TOKEN}`,
          "content-type": "application/json",
        },
        payload: { referrer_pubkey: REFERRER_PUBKEY, referrer_share_bps: null },
      });
      assert.equal(res.statusCode, 400);
    });

    it("404 on unknown label", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/admin/api-keys/does-not-exist/referrer`,
        headers: {
          authorization: `Bearer ${ADMIN_TOKEN}`,
          "content-type": "application/json",
        },
        payload: { referrer_pubkey: REFERRER_PUBKEY, referrer_share_bps: 500 },
      });
      assert.equal(res.statusCode, 404);
    });

    it("atomically writes both columns on valid input", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/admin/api-keys/${REF_LABEL}/referrer`,
        headers: {
          authorization: `Bearer ${ADMIN_TOKEN}`,
          "content-type": "application/json",
        },
        payload: { referrer_pubkey: REFERRER_PUBKEY, referrer_share_bps: 1000 },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.label, REF_LABEL);
      assert.equal(body.referrer_pubkey, REFERRER_PUBKEY);
      assert.equal(body.referrer_share_bps, 1000);

      const row = await getOne<{
        referrer_pubkey: string | null;
        referrer_share_bps: number | null;
      }>(
        "SELECT referrer_pubkey, referrer_share_bps FROM api_keys WHERE label = $1",
        [REF_LABEL],
      );
      assert.equal(row?.referrer_pubkey, REFERRER_PUBKEY);
      assert.equal(row?.referrer_share_bps, 1000);
    });

    it("clears both columns with both=null", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/admin/api-keys/${REF_LABEL}/referrer`,
        headers: {
          authorization: `Bearer ${ADMIN_TOKEN}`,
          "content-type": "application/json",
        },
        payload: { referrer_pubkey: null, referrer_share_bps: null },
      });
      assert.equal(res.statusCode, 200);
      const row = await getOne<{
        referrer_pubkey: string | null;
        referrer_share_bps: number | null;
      }>(
        "SELECT referrer_pubkey, referrer_share_bps FROM api_keys WHERE label = $1",
        [REF_LABEL],
      );
      assert.equal(row?.referrer_pubkey, null);
      assert.equal(row?.referrer_share_bps, null);
    });
  });

  describe("GET /api/v1/partners/:referrer_pubkey/policies — auth", () => {
    before(async () => {
      // Register the referrer so the api key is bound.
      await query(
        "UPDATE api_keys SET referrer_pubkey = $1, referrer_share_bps = $2 WHERE label = $3",
        [REFERRER_PUBKEY, 1000, REF_LABEL],
      );
    });

    it("401 without auth", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/partners/${REFERRER_PUBKEY}/policies`,
      });
      assert.equal(res.statusCode, 401);
      assert.equal(res.json().error, "missing_auth");
    });

    it("401 with outsider API key (not registered as this referrer)", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/partners/${REFERRER_PUBKEY}/policies`,
        headers: { authorization: `Bearer ${OUTSIDER_API_KEY}` },
      });
      assert.equal(res.statusCode, 401);
      assert.equal(res.json().error, "invalid_auth");
    });

    it("401 when referrer pubkey mismatch (registered for a different referrer)", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/partners/${BAD_REFERRER}/policies`,
        headers: { authorization: `Bearer ${REF_API_KEY}` },
      });
      assert.equal(res.statusCode, 401);
    });

    it("200 with admin token", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/partners/${REFERRER_PUBKEY}/policies`,
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      assert.equal(res.statusCode, 200);
    });

    it("200 with matching-referrer API key", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/partners/${REFERRER_PUBKEY}/policies`,
        headers: { authorization: `Bearer ${REF_API_KEY}` },
      });
      assert.equal(res.statusCode, 200);
    });
  });

  describe("GET /api/v1/partners/:referrer_pubkey/policies — contract", () => {
    it("returns the documented shape with empty data today", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/partners/${REFERRER_PUBKEY}/policies`,
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.schema_version, 1);
      assert.equal(body.referrer, REFERRER_PUBKEY);
      assert.ok(body.window.from);
      assert.ok(body.window.to);
      assert.deepEqual(body.totals, {
        policies_referred: 0,
        premium_usdc_total: "0.00",
        referrer_cut_usdc_total: "0.00",
        claims_paid_usdc: "0.00",
      });
      assert.equal(body.settlement, "on_chain");
      assert.deepEqual(body.policies, []);
      assert.equal(body.pagination.limit, 100);
      assert.equal(body.pagination.next_cursor, null);
    });

    it("reflects claims.referrer_pubkey in claims_paid_usdc once data exists", async () => {
      // Seed a claim with the referrer denormalized column populated. Need
      // a call_record + provider to satisfy FK. The claim's refund_amount
      // is 0.50 USDC = 500_000 raw.
      const provRow = await getOne<{ id: string }>(
        `INSERT INTO providers (name, base_url) VALUES ($1, $2) RETURNING id`,
        [`partners-prov-${randomUUID()}`, `partners-${randomUUID()}.example`],
      );
      const crRow = await getOne<{ id: string }>(
        `INSERT INTO call_records
           (provider_id, endpoint, timestamp, status_code, latency_ms, classification, agent_id)
           VALUES ($1, '/x', NOW(), 500, 100, 'error', 'partners-test-agent')
           RETURNING id`,
        [provRow!.id],
      );
      await query(
        `INSERT INTO claims
           (call_record_id, provider_id, agent_id, trigger_type, refund_pct, refund_amount, referrer_pubkey)
           VALUES ($1, $2, 'partners-test-agent', 'error', 100, 500000, $3)`,
        [crRow!.id, provRow!.id, REFERRER_PUBKEY],
      );

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/partners/${REFERRER_PUBKEY}/policies`,
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.totals.claims_paid_usdc, "0.50");

      // Cleanup
      await query("DELETE FROM claims WHERE referrer_pubkey = $1 AND provider_id = $2", [
        REFERRER_PUBKEY,
        provRow!.id,
      ]);
      await query("DELETE FROM call_records WHERE id = $1", [crRow!.id]);
      await query("DELETE FROM providers WHERE id = $1", [provRow!.id]);
    });

    it("rejects junk referrer_pubkey with 400", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/partners/x/policies`,
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      assert.equal(res.statusCode, 400);
      assert.equal(res.json().error, "invalid_referrer_pubkey");
    });

    it("honors limit query param (capped at 500)", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/partners/${REFERRER_PUBKEY}/policies?limit=9999`,
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().pagination.limit, 500);
    });

    it("rejects invalid cursor", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/partners/${REFERRER_PUBKEY}/policies?cursor=not-a-date`,
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      assert.equal(res.statusCode, 400);
      assert.equal(res.json().error, "invalid_cursor");
    });
  });
});
