// Focused regression test for the F2 canonicalization fix in claims-submit.
// Before the fix, providerHostname was compared === row.api_provider directly.
// After F2, api_provider is stored in canonical form (lowercase, stripped), so
// any SDK client still sending API.EXAMPLE.COM or https://api.example.com/foo
// would 400 with "providerHostname does not match call record". This test
// confirms the comparison now canonicalizes both sides and lets the request
// pass the hostname gate.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import Fastify from "fastify";
import { query, getOne, pool } from "../db.js";
import { claimsSubmitRoute } from "./claims-submit.js";

async function buildApp() {
  const app = Fastify();
  await app.register(claimsSubmitRoute);
  return app;
}

describe("POST /api/v1/claims/submit — providerHostname canonicalization (F2)", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  const tag = randomUUID().slice(0, 8);
  const canonicalHost = `canon-${tag}.example.com`;
  const apiKey = `pact_${randomBytes(24).toString("hex")}`;
  const keyHash = createHash("sha256").update(apiKey).digest("hex");
  const agentLabel = `agent-canon-${tag}`;
  const agentPubkey = `AgentPubkeyCanon${tag.padEnd(28, "1")}`;

  let providerId = "";
  let callRecordId = "";

  before(async () => {
    app = await buildApp();

    await query(
      "INSERT INTO api_keys (key_hash, label, agent_pubkey) VALUES ($1, $2, $3)",
      [keyHash, agentLabel, agentPubkey],
    );
    const prov = await getOne<{ id: string }>(
      "INSERT INTO providers (name, base_url) VALUES ($1, $2) RETURNING id",
      [canonicalHost, canonicalHost],
    );
    providerId = prov!.id;

    const rec = await getOne<{ id: string }>(
      `INSERT INTO call_records (provider_id, endpoint, timestamp, status_code,
         latency_ms, classification, agent_id, agent_pubkey)
       VALUES ($1, '/v1/submit', NOW(), 500, 100, 'error', $2, $3) RETURNING id`,
      [providerId, agentLabel, agentPubkey],
    );
    callRecordId = rec!.id;
  });

  after(async () => {
    await query("DELETE FROM call_records WHERE id = $1", [callRecordId]);
    await query("DELETE FROM providers WHERE id = $1", [providerId]);
    await query("DELETE FROM api_keys WHERE key_hash = $1", [keyHash]);
    await app.close();
    await pool.end();
  });

  async function postWith(providerHostname: string) {
    return app.inject({
      method: "POST",
      url: "/api/v1/claims/submit",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      payload: { callRecordId, providerHostname },
    });
  }

  // Absent the F2 fix, each of these variants was a direct `!==` miss against
  // the canonical api_provider string and produced 400
  // "providerHostname does not match call record". Post-fix we canonicalize
  // the incoming value first, so the hostname gate passes and we move on to
  // the on-chain policy check (which can legitimately fail in this test env
  // with 404 or 503 — but NOT with a hostname mismatch).
  const variants = [
    ["uppercase", canonicalHost.toUpperCase()],
    ["mixed case", canonicalHost.replace("canon", "Canon")],
    ["https scheme + path", `https://${canonicalHost}/v0/foo`],
    ["explicit port", `https://${canonicalHost}:443`],
  ] as const;

  for (const [label, variant] of variants) {
    it(`accepts ${label} providerHostname and passes the hostname gate`, async () => {
      const resp = await postWith(variant);
      const body = resp.json();
      assert.notEqual(
        resp.statusCode,
        400,
        `expected hostname gate to pass for variant "${variant}"; got 400: ${JSON.stringify(body)}`,
      );
      // If anything returns 400 from here it must be a different error
      // (Invalid providerHostname from canonicalHostname itself is fine to
      // ignore — these variants are all well-formed).
      assert.notEqual(
        body?.error,
        "providerHostname does not match call record",
        "hostname-mismatch error must not fire for canonically-equivalent input",
      );
    });
  }

  it("still rejects a truly different hostname with the mismatch error", async () => {
    const other = `different-${randomUUID().slice(0, 8)}.example.com`;
    const resp = await postWith(other);
    assert.equal(resp.statusCode, 400);
    assert.equal(
      resp.json().error,
      "providerHostname does not match call record",
    );
  });

  it("rejects unparseable providerHostname with a distinct 400", async () => {
    const resp = await postWith("http://");
    assert.equal(resp.statusCode, 400);
    assert.equal(resp.json().error, "Invalid providerHostname");
  });
});
