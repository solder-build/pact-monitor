import type { FastifyInstance } from "fastify";
import { address } from "@solana/kit";
import { generated } from "@pact-network/insurance";
const {
  decodeProtocolConfig,
  decodeCoveragePool,
  getCoveragePoolHostname,
  findProtocolConfigPda,
  getUpdateRatesInstruction,
} = generated;
import {
  createKitSolanaClient,
  getSolanaConfig,
} from "../utils/solana.js";
import {
  kitFetchAccountBytes,
  kitGetProgramAccounts,
  kitSendTx,
} from "../utils/kit-rpc.js";
import { query } from "../db.js";
import { computeInsuranceRate } from "../utils/insurance.js";

interface FailureStatsRow {
  total: string;
  failures: string;
}

const MIN_CHANGE_BPS = 5;
const MIN_RATE_BPS = 25;
const MAX_RATE_BPS = 5000;

// Minimum call_records needed before trusting the failure rate.
const MIN_SAMPLE_SIZE = 10;

export const COVERAGE_POOL_DISCRIMINATOR_BYTE = 1;

/**
 * Rate updater: recomputes each pool's insurance_rate_bps from observed
 * failure rates in the recent window, and calls update_rates on-chain when
 * the delta exceeds MIN_CHANGE_BPS.
 */
export async function runRateUpdater(app: FastifyInstance): Promise<void> {
  const config = getSolanaConfig();
  const client = await createKitSolanaClient(config);

  const [protocolConfigAddr] = await findProtocolConfigPda();
  const configBytes = await kitFetchAccountBytes(client, protocolConfigAddr as string);
  if (!configBytes) {
    app.log.warn("Rate updater: protocol config not found");
    return;
  }
  decodeProtocolConfig(configBytes); // validates decoding without crashing

  const poolAccounts = await kitGetProgramAccounts(client, [
    { memcmp: { offset: 0, bytes: Buffer.from([COVERAGE_POOL_DISCRIMINATOR_BYTE]).toString("base64"), encoding: "base64" } },
  ]);
  app.log.debug({ poolCount: poolAccounts.length }, "Rate updater: fetched pools");

  for (const acct of poolAccounts) {
    let pool: ReturnType<typeof decodeCoveragePool>;
    try {
      pool = decodeCoveragePool(acct.data);
    } catch {
      continue;
    }

    const hostname = getCoveragePoolHostname(pool);
    const currentRateBps: number = pool.insuranceRateBps;
    const poolAddr = address(acct.pubkey);

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
      const ix = getUpdateRatesInstruction({
        config: protocolConfigAddr,
        pool: poolAddr,
        oracleSigner: client.oracleSigner,
        newRateBps: proposedBps,
      });
      const sig = await kitSendTx(client, [ix]);
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
