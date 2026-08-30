-- CreateEnum
CREATE TYPE "V2ClaimStatus" AS ENUM ('Pending', 'Approved', 'Rejected');

-- CreateEnum
CREATE TYPE "V2TriggerType" AS ENUM ('Timeout', 'Error', 'SchemaMismatch', 'LatencySla');

-- CreateEnum
CREATE TYPE "V2PremiumAttemptStatus" AS ENUM ('Pending', 'Confirmed', 'Failed');

-- CreateTable
CREATE TABLE "V2ProtocolConfig" (
    "configPda" VARCHAR(44) NOT NULL,
    "authority" VARCHAR(44) NOT NULL,
    "oracle" VARCHAR(44) NOT NULL,
    "treasury" VARCHAR(44) NOT NULL,
    "usdcMint" VARCHAR(44) NOT NULL,
    "minPoolDeposit" BIGINT NOT NULL,
    "defaultMaxCoveragePerCall" BIGINT NOT NULL,
    "withdrawalCooldownSeconds" BIGINT NOT NULL,
    "aggregateCapWindowSeconds" BIGINT NOT NULL,
    "claimWindowSeconds" BIGINT NOT NULL,
    "protocolFeeBps" INTEGER NOT NULL,
    "defaultInsuranceRateBps" INTEGER NOT NULL,
    "minPremiumBps" INTEGER NOT NULL,
    "aggregateCapBps" INTEGER NOT NULL,
    "maxClaimsPerBatch" INTEGER NOT NULL,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "bump" INTEGER NOT NULL,
    "slot" BIGINT NOT NULL DEFAULT 0,
    "ingestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "V2ProtocolConfig_pkey" PRIMARY KEY ("configPda")
);

-- CreateTable
CREATE TABLE "V2Pool" (
    "poolPda" VARCHAR(44) NOT NULL,
    "authority" VARCHAR(44) NOT NULL,
    "usdcMint" VARCHAR(44) NOT NULL,
    "vault" VARCHAR(44) NOT NULL,
    "providerHostname" VARCHAR(64) NOT NULL,
    "totalDeposited" BIGINT NOT NULL DEFAULT 0,
    "totalAvailable" BIGINT NOT NULL DEFAULT 0,
    "totalPremiumsEarned" BIGINT NOT NULL DEFAULT 0,
    "totalClaimsPaid" BIGINT NOT NULL DEFAULT 0,
    "maxCoveragePerCall" BIGINT NOT NULL,
    "payoutsThisWindow" BIGINT NOT NULL DEFAULT 0,
    "windowStart" BIGINT NOT NULL DEFAULT 0,
    "createdAtOnChain" BIGINT NOT NULL,
    "updatedAtOnChain" BIGINT NOT NULL,
    "activePolicies" INTEGER NOT NULL DEFAULT 0,
    "insuranceRateBps" INTEGER NOT NULL,
    "minPremiumBps" INTEGER NOT NULL,
    "bump" INTEGER NOT NULL,
    "vaultBump" INTEGER NOT NULL,
    "slot" BIGINT NOT NULL DEFAULT 0,
    "ingestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "V2Pool_pkey" PRIMARY KEY ("poolPda")
);

-- CreateTable
CREATE TABLE "V2Position" (
    "positionPda" VARCHAR(44) NOT NULL,
    "pool" VARCHAR(44) NOT NULL,
    "underwriter" VARCHAR(44) NOT NULL,
    "deposited" BIGINT NOT NULL DEFAULT 0,
    "earnedPremiums" BIGINT NOT NULL DEFAULT 0,
    "lossesAbsorbed" BIGINT NOT NULL DEFAULT 0,
    "depositTimestamp" BIGINT NOT NULL,
    "lastClaimTimestamp" BIGINT NOT NULL,
    "bump" INTEGER NOT NULL,
    "slot" BIGINT NOT NULL DEFAULT 0,
    "ingestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "V2Position_pkey" PRIMARY KEY ("positionPda")
);

-- CreateTable
CREATE TABLE "V2Policy" (
    "policyPda" VARCHAR(44) NOT NULL,
    "agent" VARCHAR(44) NOT NULL,
    "pool" VARCHAR(44) NOT NULL,
    "agentTokenAccount" VARCHAR(44) NOT NULL,
    "agentId" VARCHAR(64) NOT NULL,
    "totalPremiumsPaid" BIGINT NOT NULL DEFAULT 0,
    "totalClaimsReceived" BIGINT NOT NULL DEFAULT 0,
    "callsCovered" BIGINT NOT NULL DEFAULT 0,
    "createdAtOnChain" BIGINT NOT NULL,
    "expiresAt" BIGINT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "bump" INTEGER NOT NULL,
    "referrer" VARCHAR(44),
    "referrerShareBps" INTEGER NOT NULL DEFAULT 0,
    "referrerPresent" BOOLEAN NOT NULL DEFAULT false,
    "slot" BIGINT NOT NULL DEFAULT 0,
    "ingestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "V2Policy_pkey" PRIMARY KEY ("policyPda")
);

-- CreateTable
CREATE TABLE "V2Claim" (
    "claimPda" VARCHAR(44) NOT NULL,
    "policy" VARCHAR(44) NOT NULL,
    "pool" VARCHAR(44) NOT NULL,
    "agent" VARCHAR(44) NOT NULL,
    "callIdHash" VARCHAR(64) NOT NULL,
    "evidenceHash" VARCHAR(64) NOT NULL,
    "paymentAmount" BIGINT NOT NULL,
    "refundAmount" BIGINT NOT NULL,
    "callTimestamp" BIGINT NOT NULL,
    "createdAtOnChain" BIGINT NOT NULL,
    "resolvedAt" BIGINT NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "triggerType" "V2TriggerType" NOT NULL,
    "status" "V2ClaimStatus" NOT NULL,
    "bump" INTEGER NOT NULL,
    "slot" BIGINT NOT NULL DEFAULT 0,
    "ingestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "V2Claim_pkey" PRIMARY KEY ("claimPda")
);

-- CreateTable
CREATE TABLE "V2PremiumSettlement" (
    "id" TEXT NOT NULL,
    "signature" VARCHAR(88) NOT NULL,
    "policy" VARCHAR(44) NOT NULL,
    "callId" VARCHAR(128) NOT NULL,
    "callIdHash" VARCHAR(64) NOT NULL,
    "callValue" BIGINT NOT NULL,
    "poolCut" BIGINT NOT NULL,
    "treasuryCut" BIGINT NOT NULL,
    "referrerCut" BIGINT NOT NULL DEFAULT 0,
    "settledAt" TIMESTAMP(3) NOT NULL,
    "ingestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "V2PremiumSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "V2PremiumAttempt" (
    "callId" VARCHAR(128) NOT NULL,
    "lastAttemptSignature" VARCHAR(88),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "status" "V2PremiumAttemptStatus" NOT NULL DEFAULT 'Pending',
    "policyPda" VARCHAR(44),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "V2PremiumAttempt_pkey" PRIMARY KEY ("callId")
);

-- CreateTable
CREATE TABLE "V2Agent" (
    "pubkey" VARCHAR(44) NOT NULL,
    "displayName" TEXT,
    "totalPremiumsPaid" BIGINT NOT NULL DEFAULT 0,
    "totalClaimsReceived" BIGINT NOT NULL DEFAULT 0,
    "callsCovered" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "V2Agent_pkey" PRIMARY KEY ("pubkey")
);

-- CreateTable
CREATE TABLE "V2OperatorAllowlist" (
    "walletPubkey" VARCHAR(44) NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,

    CONSTRAINT "V2OperatorAllowlist_pkey" PRIMARY KEY ("walletPubkey")
);

-- CreateIndex
CREATE UNIQUE INDEX "V2Pool_providerHostname_key" ON "V2Pool"("providerHostname");

-- CreateIndex
CREATE INDEX "V2Position_underwriter_idx" ON "V2Position"("underwriter");

-- CreateIndex
CREATE INDEX "V2Position_pool_idx" ON "V2Position"("pool");

-- CreateIndex
CREATE INDEX "V2Policy_agent_idx" ON "V2Policy"("agent");

-- CreateIndex
CREATE UNIQUE INDEX "V2Policy_pool_agent_key" ON "V2Policy"("pool", "agent");

-- CreateIndex
CREATE UNIQUE INDEX "V2Claim_callIdHash_key" ON "V2Claim"("callIdHash");

-- CreateIndex
CREATE INDEX "V2Claim_policy_ingestedAt_idx" ON "V2Claim"("policy", "ingestedAt");

-- CreateIndex
CREATE INDEX "V2Claim_agent_idx" ON "V2Claim"("agent");

-- CreateIndex
CREATE INDEX "V2PremiumSettlement_policy_settledAt_idx" ON "V2PremiumSettlement"("policy", "settledAt");

-- CreateIndex
CREATE INDEX "V2PremiumSettlement_signature_idx" ON "V2PremiumSettlement"("signature");

-- CreateIndex
CREATE UNIQUE INDEX "V2PremiumSettlement_signature_callId_key" ON "V2PremiumSettlement"("signature", "callId");

-- CreateIndex
CREATE INDEX "V2PremiumAttempt_status_idx" ON "V2PremiumAttempt"("status");

-- AddForeignKey
ALTER TABLE "V2Position" ADD CONSTRAINT "V2Position_pool_fkey" FOREIGN KEY ("pool") REFERENCES "V2Pool"("poolPda") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "V2Policy" ADD CONSTRAINT "V2Policy_pool_fkey" FOREIGN KEY ("pool") REFERENCES "V2Pool"("poolPda") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "V2Claim" ADD CONSTRAINT "V2Claim_policy_fkey" FOREIGN KEY ("policy") REFERENCES "V2Policy"("policyPda") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "V2PremiumSettlement" ADD CONSTRAINT "V2PremiumSettlement_policy_fkey" FOREIGN KEY ("policy") REFERENCES "V2Policy"("policyPda") ON DELETE RESTRICT ON UPDATE CASCADE;

