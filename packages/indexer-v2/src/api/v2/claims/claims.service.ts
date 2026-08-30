import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../../prisma/prisma.service";
import { serializeClaim } from "../shared/serialize";

@Injectable()
export class ClaimsService {
  constructor(private readonly prisma: PrismaService) {}

  async getByCallIdHash(callIdHash: string) {
    const claim = await this.prisma.v2Claim.findUnique({
      where: { callIdHash },
    });
    if (!claim) {
      throw new NotFoundException(
        `no V2Claim for callIdHash=${callIdHash}`
      );
    }
    return serializeClaim(claim);
  }
}
