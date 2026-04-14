import type { FastifyInstance, FastifyReply } from "fastify";
import { createSolanaClient, derivePoolPda, getSolanaConfig } from "../utils/solana.js";
import { query } from "../db.js";

interface CachedPoolList {
  cachedAt: number;
  data: unknown;
  programId: string;
  rpcUrl: string;
}
const POOL_LIST_TTL_MS = 30_000;
let poolListCache: CachedPoolList | null = null;

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

function getConfigOr503(reply: FastifyReply) {
  try {
    return { config: getSolanaConfig() };
  } catch (err) {
    reply.log.error({ err }, "Solana config missing");
    reply.code(503).send({ error: "Solana configuration unavailable" });
    return null;
  }
}

export async function poolsRoute(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/pools", async (request, reply) => {
    const cfg = getConfigOr503(reply);
    if (!cfg) return;

    // Cache is scoped to the (programId, rpcUrl) tuple. If either changes
    // at runtime (e.g. program redeploy in Task 12), the cached payload
    // belongs to a different network and must be invalidated.
    if (
      poolListCache &&
      poolListCache.programId === cfg.config.programId &&
      poolListCache.rpcUrl === cfg.config.rpcUrl &&
      Date.now() - poolListCache.cachedAt < POOL_LIST_TTL_MS
    ) {
      return reply.send(poolListCache.data);
    }

    try {
      const { program } = createSolanaClient(cfg.config);
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
      const payload = { pools: result };
      poolListCache = {
        cachedAt: Date.now(),
        data: payload,
        programId: cfg.config.programId,
        rpcUrl: cfg.config.rpcUrl,
      };
      return reply.send(payload);
    } catch (err) {
      request.log.error({ err }, "Failed to fetch pools");
      return reply.code(502).send({ error: "Upstream RPC error" });
    }
  });

  app.get<{ Params: { hostname: string } }>(
    "/api/v1/pools/:hostname",
    async (request, reply) => {
      const cfg = getConfigOr503(reply);
      if (!cfg) return;
      try {
        const { program, programId } = createSolanaClient(cfg.config);
        const [poolPda] = derivePoolPda(programId, request.params.hostname);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pool: any = await (program.account as any).coveragePool.fetch(poolPda);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const positions = await (program.account as any).underwriterPosition.all([
          { memcmp: { offset: 8, bytes: poolPda.toBase58() } },
        ]);
        const claimsResult = await query<ClaimRow>(
          `SELECT c.id, c.call_record_id, c.agent_id, c.trigger_type,
                  c.refund_amount, c.tx_hash, c.settlement_slot, c.created_at
           FROM claims c
           JOIN providers p ON p.id = c.provider_id
           WHERE c.status = 'settled' AND p.base_url = $1
           ORDER BY c.created_at DESC LIMIT 50`,
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
        request.log.error({ err }, "Failed to fetch pool detail");
        return reply.code(502).send({ error: "Upstream RPC error" });
      }
    },
  );
}

export function __resetPoolCacheForTests(): void { poolListCache = null; }

// Exported for tests that want to introspect cache state. If programId is
// provided, only returns the timestamp when the cached entry matches that
// programId — otherwise returns "any cached" timestamp (or null if unset).
export function __getPoolCacheTimestampForTests(programId?: string): number | null {
  if (!poolListCache) return null;
  if (programId !== undefined && poolListCache.programId !== programId) return null;
  return poolListCache.cachedAt;
}
