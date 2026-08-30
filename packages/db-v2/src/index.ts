// Import from the package-local generated client (see prisma/schema.prisma
// `output`), NOT the shared @prisma/client — that one is owned by the v1
// @pact-network/db package and carries the unprefixed models.
export { Prisma, PrismaClient } from "./generated/client";
export type {
  V2ProtocolConfig,
  V2Pool,
  V2Position,
  V2Policy,
  V2Claim,
  V2PremiumSettlement,
  V2PremiumAttempt,
  V2Agent,
  V2OperatorAllowlist,
  V2ClaimStatus,
  V2TriggerType,
  V2PremiumAttemptStatus,
} from "./generated/client";
