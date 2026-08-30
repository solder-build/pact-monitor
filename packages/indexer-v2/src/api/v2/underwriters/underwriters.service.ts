import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../../prisma/prisma.service";
import { serializePosition } from "../shared/serialize";

@Injectable()
export class UnderwritersService {
  constructor(private readonly prisma: PrismaService) {}

  async listPositions(pubkey: string) {
    const rows = await this.prisma.v2Position.findMany({
      where: { underwriter: pubkey },
      orderBy: { updatedAt: "desc" },
    });
    return rows.map(serializePosition);
  }
}
