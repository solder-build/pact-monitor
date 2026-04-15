import type { FastifyInstance } from "fastify";
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  createSolanaClient,
  deriveProtocolPda,
  getSolanaConfig,
} from "../utils/solana.js";
import { query } from "../db.js";

interface CallValueRow {
  total: string | null;
}

interface WatermarkRow {
  last_settled_at: Date;
}

// Fallback window when a policy has never been settled before (no row in
// policy_settlements). First settlement picks up at most this much history.
const INITIAL_WATERMARK_INTERVAL = "15 minutes";

/**
 * Premium settler (post-pivot, delegation model).
 *
 * For every active policy across every coverage pool, sum the call_records
 * payment_amount for that (provider, agent) pair over the recent window and
 * call settle_premium with the aggregated call_value. The program derives
 * premium from call_value * insurance_rate_bps and transfers USDC from the
 * agent's delegated ATA to the pool vault + treasury.
 */
export async function runPremiumSettler(app: FastifyInstance): Promise<void> {
  const { program, programId, oracleKeypair } = createSolanaClient(getSolanaConfig());
  const [protocolPda] = deriveProtocolPda(programId);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const config: any = await (program.account as any).protocolConfig.fetch(protocolPda);
  const treasuryTokenAccount = getAssociatedTokenAddressSync(
    config.usdcMint,
    config.treasury,
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pools: any[] = await (program.account as any).coveragePool.all();
  app.log.debug({ poolCount: pools.length }, "Premium settler: fetched pools");

  for (const pool of pools) {
    const poolPda: PublicKey = pool.publicKey;
    const hostname: string = pool.account.providerHostname;

    // Policy struct: agent (32) + pool (32) ... so the `pool` field lives at
    // offset 8 + 32 after the account discriminator.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const policies: any[] = await (program.account as any).policy.all([
      { memcmp: { offset: 8 + 32, bytes: poolPda.toBase58() } },
    ]);

    for (const entry of policies) {
      const policy = entry.account;
      if (!policy.active) continue;

      const policyPdaStr = entry.publicKey.toString();
      const agentPubkey = (policy.agent as PublicKey).toBase58();

      // Look up the policy's settlement watermark. If absent, treat the
      // watermark as NOW() - INITIAL_WATERMARK_INTERVAL so first settlement
      // picks up at most that window of history (and never older than
      // policy creation itself, since older records won't have this agent
      // as agent_pubkey).
      const watermarkResult = await query<WatermarkRow>(
        `SELECT last_settled_at FROM policy_settlements WHERE policy_pda = $1`,
        [policyPdaStr],
      );
      const hasWatermark = watermarkResult.rows.length > 0;

      // Match by agent_pubkey (canonical on-chain identity) rather than
      // agent_id string, since call_records.agent_id comes from the API
      // key label middleware and doesn't necessarily match policy.agentId.
      // The `created_at > watermark` filter ensures each call_record
      // contributes to exactly one settlement.
      const sumSql = hasWatermark
        ? `SELECT COALESCE(SUM(cr.payment_amount), 0)::text AS total
           FROM call_records cr
           JOIN providers p ON p.id = cr.provider_id
           WHERE cr.agent_pubkey = $1
             AND p.base_url = $2
             AND cr.created_at > $3
             AND cr.payment_amount IS NOT NULL`
        : `SELECT COALESCE(SUM(cr.payment_amount), 0)::text AS total
           FROM call_records cr
           JOIN providers p ON p.id = cr.provider_id
           WHERE cr.agent_pubkey = $1
             AND p.base_url = $2
             AND cr.created_at > NOW() - INTERVAL '${INITIAL_WATERMARK_INTERVAL}'
             AND cr.payment_amount IS NOT NULL`;

      const params: unknown[] = hasWatermark
        ? [agentPubkey, hostname, watermarkResult.rows[0].last_settled_at]
        : [agentPubkey, hostname];

      const result = await query<CallValueRow>(sumSql, params);

      const callValueStr = result.rows[0]?.total ?? "0";
      const callValue = BigInt(callValueStr);
      if (callValue === 0n) {
        // Still advance the watermark even when there's nothing to settle,
        // so we don't re-scan the same historical window next cycle.
        await query(
          `INSERT INTO policy_settlements (policy_pda, last_settled_at, updated_at)
           VALUES ($1, NOW(), NOW())
           ON CONFLICT (policy_pda)
           DO UPDATE SET last_settled_at = NOW(), updated_at = NOW()`,
          [policyPdaStr],
        );
        continue;
      }

      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sig: string = await (program.methods as any)
          .settlePremium(new BN(callValue.toString()))
          .accounts({
            config: protocolPda,
            pool: poolPda,
            vault: pool.account.vault,
            policy: entry.publicKey,
            agentTokenAccount: policy.agentTokenAccount,
            treasuryTokenAccount,
            oracle: oracleKeypair.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();

        // Only advance the watermark AFTER the on-chain settle succeeds,
        // so a failed settlement retries the same records next cycle.
        await query(
          `INSERT INTO policy_settlements (policy_pda, last_settled_at, updated_at)
           VALUES ($1, NOW(), NOW())
           ON CONFLICT (policy_pda)
           DO UPDATE SET last_settled_at = NOW(), updated_at = NOW()`,
          [policyPdaStr],
        );

        app.log.info(
          {
            hostname,
            policy: policyPdaStr,
            callValue: callValue.toString(),
            sig,
          },
          "Premium settled",
        );
      } catch (err) {
        app.log.warn(
          {
            err,
            hostname,
            policy: policyPdaStr,
            callValue: callValue.toString(),
          },
          "settle_premium failed for policy",
        );
        // Do NOT advance the watermark on failure; next cycle will retry.
        // Do NOT throw — keep settling other policies.
      }
    }
  }
}
