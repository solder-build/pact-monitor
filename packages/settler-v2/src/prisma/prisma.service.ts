import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@pact-network/db-v2";

/**
 * Thin NestJS lifecycle wrapper around the V2 Prisma client.
 *
 * Reads PG_V2_URL from process env (Prisma reads it natively via the
 * datasource block — see @pact-network/db-v2/prisma/schema.prisma).
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
