// One-off migration: canonicalize provider.base_url and dedupe collisions.
//
// Why: before Phase 5 the ingest path passed the raw record.hostname straight
// into findOrCreateProvider + derivePoolPda, so variants like
//   api.helius.xyz
//   API.Helius.XYZ
//   https://api.helius.xyz/v0/webhooks
// landed as three distinct provider rows (and three distinct on-chain pool
// PDAs). This script collapses DB duplicates under canonicalHostname, re-parents
// every child row (call_records, claims, premium_adjustments, outage_events) to
// the surviving provider id, and rewrites base_url to the canonical form.
//
// On-chain PDA duplicates, if any exist on devnet, are out of scope here —
// ingest will stop minting new duplicates after the route changes ship, and the
// Pinocchio redeploy resets on-chain state anyway.
//
// Runbook
// -------
//   # Dry-run (no writes):
//   DATABASE_URL=postgres://... npx tsx migrations/20260422-canonicalize-hostnames.ts --dry-run
//
//   # Apply:
//   DATABASE_URL=postgres://... npx tsx migrations/20260422-canonicalize-hostnames.ts
//
// Safe to re-run — idempotent once canonical rows exist.

import pg from "pg";
import { canonicalHostname } from "../src/utils/hostname.js";

interface ProviderRow {
  id: string;
  name: string;
  category: string;
  base_url: string;
  wallet_address: string | null;
  created_at: Date;
}

interface GroupPlan {
  canonical: string;
  winner: ProviderRow;
  losers: ProviderRow[];
  walletToSet: string | null;
}

function planGroups(rows: ProviderRow[]): GroupPlan[] {
  // Bucket by canonicalHostname(base_url). Skip rows whose base_url is
  // unparseable — log and leave alone; human follow-up.
  const byCanonical = new Map<string, ProviderRow[]>();
  for (const row of rows) {
    let canonical: string;
    try {
      canonical = canonicalHostname(row.base_url);
    } catch (err) {
      console.warn(
        `  skip: provider ${row.id} has unparseable base_url '${row.base_url}': ${(err as Error).message}`,
      );
      continue;
    }
    const bucket = byCanonical.get(canonical) ?? [];
    bucket.push(row);
    byCanonical.set(canonical, bucket);
  }

  const plans: GroupPlan[] = [];
  for (const [canonical, bucket] of byCanonical) {
    // Prefer the row that already equals canonical; otherwise the oldest row
    // wins (deterministic, preserves the created_at history for analytics).
    const alreadyCanonical = bucket.find((r) => r.base_url === canonical);
    const sorted = [...bucket].sort(
      (a, b) => a.created_at.getTime() - b.created_at.getTime(),
    );
    const winner = alreadyCanonical ?? sorted[0];
    const losers = bucket.filter((r) => r.id !== winner.id);

    // Rows with nothing to merge AND whose base_url already matches canonical
    // are no-ops — drop from the plan so we don't spam the log.
    if (losers.length === 0 && winner.base_url === canonical) {
      continue;
    }

    // wallet_address: keep winner's if set, otherwise first non-null loser.
    const walletToSet =
      winner.wallet_address ??
      losers.find((l) => l.wallet_address !== null)?.wallet_address ??
      null;

    plans.push({ canonical, winner, losers, walletToSet });
  }
  return plans;
}

async function run(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const connectionString =
    process.env.DATABASE_URL || "postgresql://pact:pact@localhost:5433/pact";
  const pool = new pg.Pool({ connectionString });

  console.log(
    `hostname canonicalization migration (${dryRun ? "DRY RUN" : "APPLY"}) against ${connectionString.replace(/:[^:@]+@/, ":***@")}`,
  );

  const { rows } = await pool.query<ProviderRow>(
    "SELECT id, name, category, base_url, wallet_address, created_at FROM providers ORDER BY created_at ASC",
  );
  console.log(`  loaded ${rows.length} provider rows`);

  const plans = planGroups(rows);
  if (plans.length === 0) {
    console.log("  nothing to do — all providers already canonical and unique");
    await pool.end();
    return;
  }

  let mergedProviders = 0;
  let rewrittenBaseUrls = 0;
  let reParentedCallRecords = 0;
  let reParentedClaims = 0;
  let reParentedAdjustments = 0;
  let droppedAdjustments = 0;
  let reParentedOutages = 0;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (const plan of plans) {
      const winnerId = plan.winner.id;
      const loserIds = plan.losers.map((l) => l.id);

      console.log(
        `  canonical=${plan.canonical} winner=${winnerId} (${plan.winner.base_url}) losers=${loserIds.length}`,
      );

      for (const loser of plan.losers) {
        console.log(
          `    merge loser ${loser.id} base_url='${loser.base_url}'`,
        );
      }

      if (loserIds.length > 0) {
        // 1. call_records — straightforward re-parent; no unique constraints
        //    on provider_id so every loser row moves to the winner.
        const cr = await client.query(
          "UPDATE call_records SET provider_id = $1 WHERE provider_id = ANY($2::uuid[])",
          [winnerId, loserIds],
        );
        reParentedCallRecords += cr.rowCount ?? 0;

        // 2. claims
        const cl = await client.query(
          "UPDATE claims SET provider_id = $1 WHERE provider_id = ANY($2::uuid[])",
          [winnerId, loserIds],
        );
        reParentedClaims += cl.rowCount ?? 0;

        // 3. premium_adjustments has UNIQUE(agent_id, provider_id). If the
        //    winner already has a row for that agent_id, the loser's row must
        //    be dropped instead of re-parented. Do the conflict-free move
        //    first, then delete leftovers.
        const padjMoved = await client.query(
          `UPDATE premium_adjustments pa
             SET provider_id = $1
             WHERE pa.provider_id = ANY($2::uuid[])
               AND NOT EXISTS (
                 SELECT 1 FROM premium_adjustments win
                 WHERE win.agent_id = pa.agent_id AND win.provider_id = $1
               )`,
          [winnerId, loserIds],
        );
        reParentedAdjustments += padjMoved.rowCount ?? 0;

        const padjDropped = await client.query(
          "DELETE FROM premium_adjustments WHERE provider_id = ANY($1::uuid[])",
          [loserIds],
        );
        droppedAdjustments += padjDropped.rowCount ?? 0;

        // 4. outage_events — no uniqueness constraint that matters here.
        const oe = await client.query(
          "UPDATE outage_events SET provider_id = $1 WHERE provider_id = ANY($2::uuid[])",
          [winnerId, loserIds],
        );
        reParentedOutages += oe.rowCount ?? 0;

        // 5. drop the loser provider rows.
        await client.query(
          "DELETE FROM providers WHERE id = ANY($1::uuid[])",
          [loserIds],
        );
        mergedProviders += loserIds.length;
      }

      // 6. Winner row: rewrite base_url to canonical, backfill wallet.
      if (
        plan.winner.base_url !== plan.canonical ||
        plan.walletToSet !== plan.winner.wallet_address
      ) {
        await client.query(
          `UPDATE providers
             SET base_url = $1,
                 wallet_address = COALESCE(wallet_address, $2)
             WHERE id = $3`,
          [plan.canonical, plan.walletToSet, winnerId],
        );
        if (plan.winner.base_url !== plan.canonical) {
          rewrittenBaseUrls += 1;
        }
      }
    }

    if (dryRun) {
      await client.query("ROLLBACK");
      console.log("  DRY RUN — rolled back.");
    } else {
      await client.query("COMMIT");
      console.log("  COMMIT ok.");
    }
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  console.log("Summary:");
  console.log(`  merged loser provider rows:      ${mergedProviders}`);
  console.log(`  rewrote base_url on winner row:  ${rewrittenBaseUrls}`);
  console.log(`  call_records re-parented:        ${reParentedCallRecords}`);
  console.log(`  claims re-parented:              ${reParentedClaims}`);
  console.log(`  premium_adjustments moved:       ${reParentedAdjustments}`);
  console.log(`  premium_adjustments dropped:     ${droppedAdjustments}`);
  console.log(`  outage_events re-parented:       ${reParentedOutages}`);

  await pool.end();
}

run().catch((err) => {
  console.error("migration failed:", err);
  process.exit(1);
});
