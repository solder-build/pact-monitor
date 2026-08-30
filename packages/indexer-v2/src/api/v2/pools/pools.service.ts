import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../../prisma/prisma.service";
import { serializePool } from "../shared/serialize";

@Injectable()
export class PoolsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(params: {
    hostnameLike?: string;
    sort?: "tvlDesc" | "tvlAsc" | "claimsDesc";
    limit?: number;
  }): Promise<ReturnType<typeof serializePool>[]> {
    const orderBy =
      params.sort === "tvlAsc"
        ? { totalAvailable: "asc" as const }
        : params.sort === "claimsDesc"
          ? { totalClaimsPaid: "desc" as const }
          : { totalAvailable: "desc" as const };

    const rows = await this.prisma.v2Pool.findMany({
      where: params.hostnameLike
        ? { providerHostname: { contains: params.hostnameLike } }
        : undefined,
      orderBy,
      take: Math.min(Math.max(params.limit ?? 50, 1), 200),
    });
    return rows.map(serializePool);
  }

  async getByHostname(hostname: string): Promise<{
    pool: ReturnType<typeof serializePool>;
    recentClaimCount: number;
  }> {
    const pool = await this.prisma.v2Pool.findUnique({
      where: { providerHostname: hostname },
    });
    if (!pool) {
      throw new NotFoundException(
        `no V2Pool found for hostname=${hostname}`
      );
    }
    const recentClaimCount = await this.prisma.v2Claim.count({
      where: { pool: pool.poolPda },
    });
    return { pool: serializePool(pool), recentClaimCount };
  }
}
