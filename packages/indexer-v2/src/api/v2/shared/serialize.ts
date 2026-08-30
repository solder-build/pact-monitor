// Shared row serializers. Prisma returns BigInt for u64 columns; the API
// surface stringifies them so the response is JSON-safe (no precision
// loss in the browser).

import type {
  V2Agent,
  V2Claim,
  V2Policy,
  V2Pool,
  V2Position,
  V2PremiumSettlement,
  V2ProtocolConfig,
} from "@pact-network/db-v2";

export function serializePool(p: V2Pool) {
  return {
    poolPda: p.poolPda,
    authority: p.authority,
    usdcMint: p.usdcMint,
    vault: p.vault,
    providerHostname: p.providerHostname,
    totalDeposited: p.totalDeposited.toString(),
    totalAvailable: p.totalAvailable.toString(),
    totalPremiumsEarned: p.totalPremiumsEarned.toString(),
    totalClaimsPaid: p.totalClaimsPaid.toString(),
    maxCoveragePerCall: p.maxCoveragePerCall.toString(),
    payoutsThisWindow: p.payoutsThisWindow.toString(),
    windowStart: p.windowStart.toString(),
    createdAtOnChain: p.createdAtOnChain.toString(),
    updatedAtOnChain: p.updatedAtOnChain.toString(),
    activePolicies: p.activePolicies,
    insuranceRateBps: p.insuranceRateBps,
    minPremiumBps: p.minPremiumBps,
    bump: p.bump,
    vaultBump: p.vaultBump,
    slot: p.slot.toString(),
    ingestedAt: p.ingestedAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

export function serializePosition(p: V2Position) {
  return {
    positionPda: p.positionPda,
    pool: p.pool,
    underwriter: p.underwriter,
    deposited: p.deposited.toString(),
    earnedPremiums: p.earnedPremiums.toString(),
    lossesAbsorbed: p.lossesAbsorbed.toString(),
    depositTimestamp: p.depositTimestamp.toString(),
    lastClaimTimestamp: p.lastClaimTimestamp.toString(),
    bump: p.bump,
    slot: p.slot.toString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

export function serializePolicy(p: V2Policy) {
  return {
    policyPda: p.policyPda,
    agent: p.agent,
    pool: p.pool,
    agentTokenAccount: p.agentTokenAccount,
    agentId: p.agentId,
    totalPremiumsPaid: p.totalPremiumsPaid.toString(),
    totalClaimsReceived: p.totalClaimsReceived.toString(),
    callsCovered: p.callsCovered.toString(),
    createdAtOnChain: p.createdAtOnChain.toString(),
    expiresAt: p.expiresAt.toString(),
    active: p.active,
    bump: p.bump,
    referrer: p.referrer,
    referrerShareBps: p.referrerShareBps,
    referrerPresent: p.referrerPresent,
    slot: p.slot.toString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

export interface SerializedClaim {
  claimPda: string;
  policy: string;
  pool: string;
  agent: string;
  callIdHash: string;
  evidenceHash: string;
  paymentAmount: string;
  refundAmount: string;
  callTimestamp: string;
  createdAtOnChain: string;
  resolvedAt: string;
  latencyMs: number;
  statusCode: number;
  triggerType: string;
  status: string;
  bump: number;
  slot: string;
  ingestedAt: string;
  updatedAt: string;
}

export function serializeClaim(c: V2Claim): SerializedClaim {
  return {
    claimPda: c.claimPda,
    policy: c.policy,
    pool: c.pool,
    agent: c.agent,
    callIdHash: c.callIdHash,
    evidenceHash: c.evidenceHash,
    paymentAmount: c.paymentAmount.toString(),
    refundAmount: c.refundAmount.toString(),
    callTimestamp: c.callTimestamp.toString(),
    createdAtOnChain: c.createdAtOnChain.toString(),
    resolvedAt: c.resolvedAt.toString(),
    latencyMs: c.latencyMs,
    statusCode: c.statusCode,
    triggerType: String(c.triggerType),
    status: String(c.status),
    bump: c.bump,
    slot: c.slot.toString(),
    ingestedAt: c.ingestedAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

export function serializeSettlement(s: V2PremiumSettlement) {
  return {
    id: s.id,
    signature: s.signature,
    policy: s.policy,
    callId: s.callId,
    callIdHash: s.callIdHash,
    callValue: s.callValue.toString(),
    poolCut: s.poolCut.toString(),
    treasuryCut: s.treasuryCut.toString(),
    referrerCut: s.referrerCut.toString(),
    settledAt: s.settledAt.toISOString(),
    ingestedAt: s.ingestedAt.toISOString(),
  };
}

export function serializeAgent(a: V2Agent) {
  return {
    pubkey: a.pubkey,
    displayName: a.displayName,
    totalPremiumsPaid: a.totalPremiumsPaid.toString(),
    totalClaimsReceived: a.totalClaimsReceived.toString(),
    callsCovered: a.callsCovered.toString(),
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

export function serializeConfig(c: V2ProtocolConfig) {
  return {
    configPda: c.configPda,
    authority: c.authority,
    oracle: c.oracle,
    treasury: c.treasury,
    usdcMint: c.usdcMint,
    minPoolDeposit: c.minPoolDeposit.toString(),
    defaultMaxCoveragePerCall: c.defaultMaxCoveragePerCall.toString(),
    withdrawalCooldownSeconds: c.withdrawalCooldownSeconds.toString(),
    aggregateCapWindowSeconds: c.aggregateCapWindowSeconds.toString(),
    claimWindowSeconds: c.claimWindowSeconds.toString(),
    protocolFeeBps: c.protocolFeeBps,
    defaultInsuranceRateBps: c.defaultInsuranceRateBps,
    minPremiumBps: c.minPremiumBps,
    aggregateCapBps: c.aggregateCapBps,
    maxClaimsPerBatch: c.maxClaimsPerBatch,
    paused: c.paused,
    bump: c.bump,
    slot: c.slot.toString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}
