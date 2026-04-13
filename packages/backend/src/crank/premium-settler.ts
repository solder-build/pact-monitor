import type { FastifyInstance } from "fastify";
import { PublicKey } from "@solana/web3.js";
import { BN } from "@anchor-lang/core";
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

      // Aggregate recent call_records for this agent/provider.
      const result = await query<CallValueRow>(
        `SELECT COALESCE(SUM(cr.payment_amount), 0)::text AS total
         FROM call_records cr
         JOIN providers p ON p.id = cr.provider_id
         WHERE cr.agent_id = $1
           AND p.base_url = $2
           AND cr.created_at > NOW() - INTERVAL '15 minutes'
           AND cr.payment_amount IS NOT NULL`,
        [policy.agentId, hostname],
      );

      const callValueStr = result.rows[0]?.total ?? "0";
      const callValue = BigInt(callValueStr);
      if (callValue === 0n) continue;

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
            authority: oracleKeypair.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();

        app.log.info(
          {
            hostname,
            policy: entry.publicKey.toString(),
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
            policy: entry.publicKey.toString(),
            callValue: callValue.toString(),
          },
          "settle_premium failed for policy",
        );
        // Per plan: do NOT throw — keep settling other policies.
      }
    }
  }
}
