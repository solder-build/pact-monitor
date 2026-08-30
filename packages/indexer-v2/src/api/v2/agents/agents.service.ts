import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../../prisma/prisma.service";
import {
  serializeAgent,
  serializePolicy,
} from "../shared/serialize";

@Injectable()
export class AgentsService {
  constructor(private readonly prisma: PrismaService) {}

  async getAgent(pubkey: string) {
    const agent = await this.prisma.v2Agent.findUnique({ where: { pubkey } });
    if (!agent) {
      throw new NotFoundException(`no V2Agent for pubkey=${pubkey}`);
    }
    return serializeAgent(agent);
  }

  async listPolicies(agentPubkey: string) {
    const rows = await this.prisma.v2Policy.findMany({
      where: { agent: agentPubkey },
      orderBy: { updatedAt: "desc" },
    });
    return rows.map(serializePolicy);
  }

  async getPolicyByHostname(agentPubkey: string, hostname: string) {
    const pool = await this.prisma.v2Pool.findUnique({
      where: { providerHostname: hostname },
      select: { poolPda: true },
    });
    if (!pool) {
      throw new NotFoundException(`no V2Pool for hostname=${hostname}`);
    }
    const policy = await this.prisma.v2Policy.findUnique({
      where: { pool_agent: { pool: pool.poolPda, agent: agentPubkey } },
    });
    if (!policy) {
      throw new NotFoundException(
        `no V2Policy for agent=${agentPubkey} hostname=${hostname}`
      );
    }
    return serializePolicy(policy);
  }
}
