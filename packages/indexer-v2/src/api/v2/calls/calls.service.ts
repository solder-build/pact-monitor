import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../../prisma/prisma.service";
import { serializeSettlement } from "../shared/serialize";

/**
 * Settlement detail by tx signature. Multi-ix txs return N rows under one
 * signature (the (signature, callId) unique constraint on V2PremiumSettlement
 * scopes uniqueness per call).
 */
@Injectable()
export class CallsService {
  constructor(private readonly prisma: PrismaService) {}

  async getBySignature(signature: string) {
    const rows = await this.prisma.v2PremiumSettlement.findMany({
      where: { signature },
      orderBy: { settledAt: "asc" },
    });
    if (rows.length === 0) {
      throw new NotFoundException(
        `no V2PremiumSettlement for signature=${signature}`
      );
    }
    return {
      signature,
      settlements: rows.map(serializeSettlement),
    };
  }
}
