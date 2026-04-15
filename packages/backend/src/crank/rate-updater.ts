import type { FastifyInstance } from "fastify";
import {
  createSolanaClient,
  deriveProtocolPda,
  getSolanaConfig,
} from "../utils/solana.js";
import { query } from "../db.js";
import { computeInsuranceRate } from "../utils/insurance.js";

interface FailureStatsRow {
  total: string;
  failures: string;
}

const MIN_CHANGE_BPS = 5;
const MIN_RATE_BPS = 25;
const MAX_RATE_BPS = 5000;

// Minimum call_records needed in the observation window before we trust
// the failure rate enough to push a new rate on-chain. Below this, we
// keep the existing rate. Prevents "1 failed call -> 5000 bps" pathologies.
// Tune upward for production (e.g. 200+); this floor is pragmatic for
// devnet/dev environments with low traffic.
const MIN_SAMPLE_SIZE = 10;

/**
 * Rate updater: recomputes each pool's insurance_rate_bps from observed
 * failure rates in the recent window, and calls update_rates on-chain when
 * the delta exceeds MIN_CHANGE_BPS to avoid noisy updates.
 */
export async function runRateUpdater(app: FastifyInstance): Promise<void> {
  const { program, programId, oracleKeypair } = createSolanaClient(getSolanaConfig());
  const [protocolPda] = deriveProtocolPda(programId);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pools: any[] = await (program.account as any).coveragePool.all();
  app.log.debug({ poolCount: pools.length }, "Rate updater: fetched pools");

  for (const pool of pools) {
    const hostname: string = pool.account.providerHostname;
    const currentRateBps: number = pool.account.insuranceRateBps;

    // Observed failure rate over the last hour.
    const result = await query<FailureStatsRow>(
      `SELECT
         COUNT(*)::text AS total,
         COUNT(*) FILTER (WHERE cr.classification != 'success')::text AS failures
       FROM call_records cr
       JOIN providers p ON p.id = cr.provider_id
       WHERE p.base_url = $1
         AND cr.created_at > NOW() - INTERVAL '1 hour'`,
      [hostname],
    );
    const row = result.rows[0];
    const total = Number(row?.total ?? 0);
    const failures = Number(row?.failures ?? 0);
    if (total === 0) continue;
    if (total < MIN_SAMPLE_SIZE) {
      app.log.debug(
        { hostname, total, threshold: MIN_SAMPLE_SIZE },
        "Rate updater: sample size below threshold; keeping current rate",
      );
      continue;
    }

    const failureRate = failures / total;
    const proposedRate = computeInsuranceRate(failureRate);
    let proposedBps = Math.round(proposedRate * 10_000);
    if (proposedBps < MIN_RATE_BPS) proposedBps = MIN_RATE_BPS;
    if (proposedBps > MAX_RATE_BPS) proposedBps = MAX_RATE_BPS;

    if (Math.abs(proposedBps - currentRateBps) < MIN_CHANGE_BPS) {
      app.log.debug(
        { hostname, currentRateBps, proposedBps },
        "Rate change below threshold; skipping",
      );
      continue;
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sig: string = await (program.methods as any)
        .updateRates(proposedBps)
        .accounts({
          config: protocolPda,
          pool: pool.publicKey,
          oracle: oracleKeypair.publicKey,
        })
        .rpc();
      app.log.info(
        { hostname, from: currentRateBps, to: proposedBps, sig },
        "Insurance rate updated",
      );
    } catch (err) {
      app.log.warn(
        { err, hostname, proposedBps },
        "update_rates failed for pool",
      );
    }
  }
}
