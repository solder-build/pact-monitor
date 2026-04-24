// Phase 5 F1: referrer revenue-share schema migration.
//
// Matches the backend schema.sql additions so this script can be re-run safely
// against any environment whose schema.sql hasn't been re-applied yet
// (initDb runs schema.sql on every boot but will abort on the first
// IF-NOT-EXISTS-incompatible statement, so a targeted one-off is the
// reliable path in prod).
//
// Adds:
//   api_keys.referrer_pubkey       TEXT NULL
//   api_keys.referrer_share_bps    INTEGER NULL  CHECK 0..3000
//   idx_api_keys_referrer          partial index (WHERE referrer_pubkey IS NOT NULL)
//   claims.referrer_pubkey         TEXT NULL
//   idx_claims_referrer            partial index (WHERE referrer_pubkey IS NOT NULL)
//
// Idempotent — re-running is a no-op.
//
// Runbook
// -------
//   DATABASE_URL=postgres://... pnpm --filter @pact-network/backend \
//     run migrate:referrer-schema
// Or directly:
//   DATABASE_URL=postgres://... npx tsx migrations/20260424-referrer-schema.ts

import pg from "pg";

async function run(): Promise<void> {
  const connectionString =
    process.env.DATABASE_URL || "postgresql://pact:pact@localhost:5433/pact";
  const pool = new pg.Pool({ connectionString });

  console.log(
    `F1 referrer-schema migration against ${connectionString.replace(/:[^:@]+@/, ":***@")}`,
  );

  const statements: Array<{ label: string; sql: string }> = [
    {
      label: "api_keys.referrer_pubkey",
      sql: "ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS referrer_pubkey TEXT NULL",
    },
    {
      label: "api_keys.referrer_share_bps",
      sql: "ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS referrer_share_bps INTEGER NULL",
    },
    {
      label: "api_keys_referrer_share_bps_check",
      sql: `
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_referrer_share_bps_check'
          ) THEN
            ALTER TABLE api_keys
              ADD CONSTRAINT api_keys_referrer_share_bps_check
              CHECK (referrer_share_bps IS NULL OR (referrer_share_bps >= 0 AND referrer_share_bps <= 3000));
          END IF;
        END $$;
      `,
    },
    {
      label: "idx_api_keys_referrer",
      sql: "CREATE INDEX IF NOT EXISTS idx_api_keys_referrer ON api_keys(referrer_pubkey) WHERE referrer_pubkey IS NOT NULL",
    },
    {
      label: "claims.referrer_pubkey",
      sql: "ALTER TABLE claims ADD COLUMN IF NOT EXISTS referrer_pubkey TEXT NULL",
    },
    {
      label: "idx_claims_referrer",
      sql: "CREATE INDEX IF NOT EXISTS idx_claims_referrer ON claims(referrer_pubkey) WHERE referrer_pubkey IS NOT NULL",
    },
  ];

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const step of statements) {
      console.log(`  applying ${step.label}`);
      await client.query(step.sql);
    }
    await client.query("COMMIT");
    console.log("F1 schema applied.");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  await pool.end();
}

run().catch((err) => {
  console.error("F1 migration failed:", err);
  process.exit(1);
});
