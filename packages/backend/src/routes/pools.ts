import type { FastifyInstance, FastifyReply } from "fastify";
import { address } from "@solana/kit";
import { generated } from "@pact-network/insurance";
const {
  decodeCoveragePool,
  decodeUnderwriterPosition,
  getCoveragePoolHostname,
  findCoveragePoolPda,
  COVERAGE_POOL_DISCRIMINATOR,
  UNDERWRITER_POSITION_DISCRIMINATOR,
} = generated;
import {
  createKitSolanaClient,
  getSolanaConfig,
  type SolanaConfig,
} from "../utils/solana.js";
import {
  kitFetchAccountBytes,
  kitGetProgramAccounts,
} from "../utils/kit-rpc.js";
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

function getConfigOr503(reply: FastifyReply): { config: SolanaConfig } | null {
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

    if (
      poolListCache &&
      poolListCache.programId === cfg.config.programId &&
      poolListCache.rpcUrl === cfg.config.rpcUrl &&
      Date.now() - poolListCache.cachedAt < POOL_LIST_TTL_MS
    ) {
      return reply.send(poolListCache.data);
    }

    try {
      const client = await createKitSolanaClient(cfg.config);
      const poolAccounts = await kitGetProgramAccounts(client, [
        {
          memcmp: {
            offset: 0,
            bytes: Buffer.from([COVERAGE_POOL_DISCRIMINATOR]).toString("base64"),
            encoding: "base64",
          },
        },
      ]);

      const result = poolAccounts.flatMap((acct) => {
        try {
          const pool = decodeCoveragePool(acct.data);
          return [{
            hostname: getCoveragePoolHostname(pool),
            pda: acct.pubkey,
            totalDeposited: pool.totalDeposited.toString(),
            totalAvailable: pool.totalAvailable.toString(),
            totalPremiumsEarned: pool.totalPremiumsEarned.toString(),
            totalClaimsPaid: pool.totalClaimsPaid.toString(),
            insuranceRateBps: pool.insuranceRateBps,
            maxCoveragePerCall: pool.maxCoveragePerCall.toString(),
            activePolicies: pool.activePolicies,
            payoutsThisWindow: pool.payoutsThisWindow.toString(),
            windowStart: pool.windowStart.toString(),
          }];
        } catch {
          return [];
        }
      });

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
        const client = await createKitSolanaClient(cfg.config);
        const [poolAddr] = await findCoveragePoolPda(request.params.hostname);
        const poolAddrStr = poolAddr as string;

        const poolBytes = await kitFetchAccountBytes(client, poolAddrStr);
        if (!poolBytes) {
          return reply.code(404).send({ error: "Pool not found" });
        }
        const pool = decodeCoveragePool(poolBytes);

        // UnderwriterPosition: `pool` field at offset 8 (disc:1 + pad:7).
        const positionAccounts = await kitGetProgramAccounts(client, [
          {
            memcmp: {
              offset: 0,
              bytes: Buffer.from([UNDERWRITER_POSITION_DISCRIMINATOR]).toString("base64"),
              encoding: "base64",
            },
          },
          {
            memcmp: {
              offset: 8,
              bytes: poolAddrStr,
              encoding: "base58",
            },
          },
        ]);

        const positions = positionAccounts.flatMap((acct) => {
          try {
            const pos = decodeUnderwriterPosition(acct.data);
            return [{
              underwriter: pos.underwriter as string,
              deposited: pos.deposited.toString(),
              earnedPremiums: pos.earnedPremiums.toString(),
              depositTimestamp: pos.depositTimestamp.toString(),
            }];
          } catch {
            return [];
          }
        });

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
            hostname: getCoveragePoolHostname(pool),
            totalDeposited: pool.totalDeposited.toString(),
            totalAvailable: pool.totalAvailable.toString(),
            totalPremiumsEarned: pool.totalPremiumsEarned.toString(),
            totalClaimsPaid: pool.totalClaimsPaid.toString(),
            insuranceRateBps: pool.insuranceRateBps,
            activePolicies: pool.activePolicies,
            payoutsThisWindow: pool.payoutsThisWindow.toString(),
          },
          positions,
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

export function __getPoolCacheTimestampForTests(programId?: string): number | null {
  if (!poolListCache) return null;
  if (programId !== undefined && poolListCache.programId !== programId) return null;
  return poolListCache.cachedAt;
}
