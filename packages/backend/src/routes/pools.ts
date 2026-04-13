import type { FastifyInstance } from "fastify";
import { createSolanaClient, derivePoolPda, getSolanaConfig } from "../utils/solana.js";
import { query } from "../db.js";

interface ClaimRow {
  id: string;
  call_record_id: string;
  agent_id: string | null;
  trigger_type: string;
  refund_amount: number | null;
  tx_hash: string | null;
  settlement_slot: number | null;
  created_at: Date;
}

export async function poolsRoute(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/pools", async (request, reply) => {
    try {
      const { program } = createSolanaClient(getSolanaConfig());
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pools = await (program.account as any).coveragePool.all();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = pools.map((p: any) => ({
        hostname: p.account.providerHostname,
        pda: p.publicKey.toString(),
        totalDeposited: p.account.totalDeposited.toString(),
        totalAvailable: p.account.totalAvailable.toString(),
        totalPremiumsEarned: p.account.totalPremiumsEarned.toString(),
        totalClaimsPaid: p.account.totalClaimsPaid.toString(),
        insuranceRateBps: p.account.insuranceRateBps,
        maxCoveragePerCall: p.account.maxCoveragePerCall.toString(),
        activePolicies: p.account.activePolicies,
        payoutsThisWindow: p.account.payoutsThisWindow.toString(),
        windowStart: p.account.windowStart.toString(),
      }));
      return reply.send({ pools: result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      request.log.error({ err }, "Failed to fetch pools");
      return reply.code(500).send({ error: message });
    }
  });

  app.get<{ Params: { hostname: string } }>(
    "/api/v1/pools/:hostname",
    async (request, reply) => {
      try {
        const { program, programId } = createSolanaClient(getSolanaConfig());
        const [poolPda] = derivePoolPda(programId, request.params.hostname);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pool: any = await (program.account as any).coveragePool.fetch(poolPda);

        // UnderwriterPosition struct: first field is `pool: Pubkey` (32 bytes)
        // so the pool pubkey lives at offset 8 (after the 8-byte account
        // discriminator).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const positions = await (program.account as any).underwriterPosition.all([
          { memcmp: { offset: 8, bytes: poolPda.toBase58() } },
        ]);

        const claimsResult = await query<ClaimRow>(
          `SELECT c.id,
                  c.call_record_id,
                  c.agent_id,
                  c.trigger_type,
                  c.refund_amount,
                  c.tx_hash,
                  c.settlement_slot,
                  c.created_at
           FROM claims c
           JOIN providers p ON p.id = c.provider_id
           WHERE c.status = 'settled'
             AND p.base_url = $1
           ORDER BY c.created_at DESC
           LIMIT 50`,
          [request.params.hostname],
        );

        return reply.send({
          pool: {
            hostname: pool.providerHostname,
            totalDeposited: pool.totalDeposited.toString(),
            totalAvailable: pool.totalAvailable.toString(),
            totalPremiumsEarned: pool.totalPremiumsEarned.toString(),
            totalClaimsPaid: pool.totalClaimsPaid.toString(),
            insuranceRateBps: pool.insuranceRateBps,
            activePolicies: pool.activePolicies,
            payoutsThisWindow: pool.payoutsThisWindow.toString(),
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          positions: positions.map((p: any) => ({
            underwriter: p.account.underwriter.toString(),
            deposited: p.account.deposited.toString(),
            earnedPremiums: p.account.earnedPremiums.toString(),
            depositTimestamp: p.account.depositTimestamp.toString(),
          })),
          recentClaims: claimsResult.rows,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        request.log.error({ err }, "Failed to fetch pool detail");
        return reply.code(500).send({ error: message });
      }
    },
  );
}
