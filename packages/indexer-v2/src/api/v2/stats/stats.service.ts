import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../../../prisma/prisma.service";

export interface NetworkStats {
  totalPools: number;
  activePolicies: number;
  totalDeposited: string;
  totalAvailable: string;
  totalPremiumsEarned: string;
  totalClaimsPaid: string;
  totalSettlements: number;
  totalClaims: number;
  topEarners: Array<{ pubkey: string; totalPremiumsPaid: string }>;
  cachedAt: string;
}

interface CacheEntry {
  stats: NetworkStats;
  expiresAt: number;
}

@Injectable()
export class StatsService {
  private readonly logger = new Logger(StatsService.name);
  private cache: CacheEntry | null = null;
  private readonly ttlMs: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService
  ) {
    this.ttlMs = Number(config.get("STATS_CACHE_TTL_MS")) || 5_000;
  }

  async getStats(): Promise<NetworkStats> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) {
      return this.cache.stats;
    }
    const [pools, settlementCount, claimCount, topAgents] = await Promise.all([
      this.prisma.v2Pool.findMany({
        select: {
          totalDeposited: true,
          totalAvailable: true,
          totalPremiumsEarned: true,
          totalClaimsPaid: true,
          activePolicies: true,
        },
      }),
      this.prisma.v2PremiumSettlement.count(),
      this.prisma.v2Claim.count(),
      this.prisma.v2Agent.findMany({
        orderBy: { totalPremiumsPaid: "desc" },
        take: 10,
        select: { pubkey: true, totalPremiumsPaid: true },
      }),
    ]);

    let totalDeposited = 0n;
    let totalAvailable = 0n;
    let totalPremiumsEarned = 0n;
    let totalClaimsPaid = 0n;
    let activePolicies = 0;
    for (const p of pools) {
      totalDeposited += p.totalDeposited;
      totalAvailable += p.totalAvailable;
      totalPremiumsEarned += p.totalPremiumsEarned;
      totalClaimsPaid += p.totalClaimsPaid;
      activePolicies += p.activePolicies;
    }

    const stats: NetworkStats = {
      totalPools: pools.length,
      activePolicies,
      totalDeposited: totalDeposited.toString(),
      totalAvailable: totalAvailable.toString(),
      totalPremiumsEarned: totalPremiumsEarned.toString(),
      totalClaimsPaid: totalClaimsPaid.toString(),
      totalSettlements: settlementCount,
      totalClaims: claimCount,
      topEarners: topAgents.map((a) => ({
        pubkey: a.pubkey,
        totalPremiumsPaid: a.totalPremiumsPaid.toString(),
      })),
      cachedAt: new Date().toISOString(),
    };
    this.cache = { stats, expiresAt: now + this.ttlMs };
    return stats;
  }
}
