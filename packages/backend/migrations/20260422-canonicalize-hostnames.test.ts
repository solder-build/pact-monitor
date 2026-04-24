// Integration test for the one-off hostname canonicalization migration.
// Seeds two colliding provider rows (api.example.com + API.EXAMPLE.COM),
// re-parents a call_record to each, runs the migration, and verifies both
// the surviving provider row and the child rows.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { canonicalHostname } from "../src/utils/hostname.js";

const CONNECTION =
  process.env.DATABASE_URL || "postgresql://pact:pact@localhost:5433/pact";

// Inline the planning helper so the test doesn't depend on export surface.
interface ProviderRow {
  id: string;
  name: string;
  category: string;
  base_url: string;
  wallet_address: string | null;
  created_at: Date;
}

function planFromRows(rows: ProviderRow[]) {
  const byCanonical = new Map<string, ProviderRow[]>();
  for (const row of rows) {
    const canonical = canonicalHostname(row.base_url);
    const bucket = byCanonical.get(canonical) ?? [];
    bucket.push(row);
    byCanonical.set(canonical, bucket);
  }
  return byCanonical;
}

describe("hostname canonicalization migration", () => {
  const pool = new pg.Pool({ connectionString: CONNECTION });
  const tag = randomUUID().slice(0, 8);
  const canonicalHost = `mig-test-${tag}.example`;
  const upperHost = canonicalHost.toUpperCase();
  const pathHost = `https://${canonicalHost}/v0/webhooks`;

  let winnerId = "";
  let loserAId = "";
  let loserBId = "";

  before(async () => {
    // Provider A — canonical form (winner should be this one).
    const wRow = await pool.query<{ id: string }>(
      "INSERT INTO providers (name, base_url, wallet_address) VALUES ($1, $2, NULL) RETURNING id",
      [canonicalHost, canonicalHost],
    );
    winnerId = wRow.rows[0].id;

    // Provider B — uppercase variant; wallet_address set.
    const aRow = await pool.query<{ id: string }>(
      "INSERT INTO providers (name, base_url, wallet_address) VALUES ($1, $2, $3) RETURNING id",
      [upperHost, upperHost, "walletABC"],
    );
    loserAId = aRow.rows[0].id;

    // Provider C — URL-with-path variant.
    const bRow = await pool.query<{ id: string }>(
      "INSERT INTO providers (name, base_url) VALUES ($1, $2) RETURNING id",
      [pathHost, pathHost],
    );
    loserBId = bRow.rows[0].id;

    // One call_record per variant so we can check re-parenting.
    const now = new Date();
    for (const [pid, endpoint] of [
      [winnerId, "/winner"],
      [loserAId, "/loserA"],
      [loserBId, "/loserB"],
    ] as const) {
      await pool.query(
        `INSERT INTO call_records (provider_id, endpoint, timestamp, status_code, latency_ms, classification)
         VALUES ($1, $2, $3, 200, 100, 'success')`,
        [pid, endpoint, now.toISOString()],
      );
    }
  });

  after(async () => {
    // The migration collapses the three providers into winnerId. Cleanup only
    // needs to address the surviving row + its call_records.
    await pool.query(
      "DELETE FROM call_records WHERE provider_id IN ($1, $2, $3)",
      [winnerId, loserAId, loserBId],
    );
    await pool.query(
      "DELETE FROM providers WHERE id IN ($1, $2, $3)",
      [winnerId, loserAId, loserBId],
    );
    await pool.end();
  });

  it("groups variants under the same canonical hostname", async () => {
    const rows = await pool.query<ProviderRow>(
      "SELECT id, name, category, base_url, wallet_address, created_at FROM providers WHERE id IN ($1, $2, $3)",
      [winnerId, loserAId, loserBId],
    );
    const buckets = planFromRows(rows.rows);
    const bucket = buckets.get(canonicalHost);
    assert.ok(bucket, `expected bucket for ${canonicalHost}`);
    assert.equal(bucket!.length, 3);
  });

  it("collapses the three variants into one canonical row via migration script", async () => {
    // Run the migration inline against the shared dev DB. Importing the script
    // would call process.exit on success; instead we re-invoke the query chain
    // using the documented runbook path (tsx subprocess).
    const { spawnSync } = await import("node:child_process");
    const result = spawnSync(
      "npx",
      [
        "tsx",
        "/Users/q3labsadmin/Q3/Solder/pact-network-phase5/packages/backend/migrations/20260422-canonicalize-hostnames.ts",
      ],
      {
        env: { ...process.env, DATABASE_URL: CONNECTION },
        encoding: "utf-8",
      },
    );
    assert.equal(result.status, 0, `migration failed: ${result.stderr}`);
    assert.match(result.stdout, new RegExp(`canonical=${canonicalHost}`));

    // Exactly one provider row remains for the canonical hostname.
    const survivors = await pool.query<{ id: string; base_url: string; wallet_address: string | null }>(
      "SELECT id, base_url, wallet_address FROM providers WHERE base_url = $1",
      [canonicalHost],
    );
    assert.equal(survivors.rows.length, 1, "exactly one provider per canonical hostname");
    assert.equal(survivors.rows[0].id, winnerId, "pre-canonical row is the winner");
    assert.equal(
      survivors.rows[0].wallet_address,
      "walletABC",
      "wallet backfilled from loser A",
    );

    // Uppercase + path variants are gone.
    const leftover = await pool.query(
      "SELECT id FROM providers WHERE id IN ($1, $2)",
      [loserAId, loserBId],
    );
    assert.equal(leftover.rows.length, 0, "loser rows deleted");

    // Every original call_record now points at the canonical winner.
    const calls = await pool.query<{ provider_id: string; endpoint: string }>(
      "SELECT provider_id, endpoint FROM call_records WHERE endpoint IN ('/winner', '/loserA', '/loserB') ORDER BY endpoint",
    );
    assert.equal(calls.rows.length, 3);
    for (const row of calls.rows) {
      assert.equal(row.provider_id, winnerId, `${row.endpoint} re-parented`);
    }
  });
});
