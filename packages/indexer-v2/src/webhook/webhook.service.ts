// WebhookService — ingests Helius account-change webhooks and upserts the
// corresponding V2 row with last-write-wins on `slot`.
//
// AUTHORITATIVE-SOURCE RULE (Locked decision §Architecture):
//   This service owns V2Pool, V2Position, V2Policy, V2ProtocolConfig
//   counter and identity fields. /events ingest paths are NOT permitted to
//   write to these tables' counter columns.
//
// Last-write-wins on `slot`:
//   Every upsert is `WHERE slot < $newSlot`. An older slot wins → no-op.
//   This handles webhook redelivery + reconnection-pass divergence
//   gracefully.
//
// Account dispatch:
//   Discriminator byte (offset 0) selects the V2 account type.
//   0 = ProtocolConfig, 1 = CoveragePool, 2 = UnderwriterPosition,
//   3 = Policy, 4 = Claim.

import { Injectable, Logger } from "@nestjs/common";
import {
  ACCOUNT_DISC_CLAIM,
  ACCOUNT_DISC_COVERAGE_POOL,
  ACCOUNT_DISC_POLICY,
  ACCOUNT_DISC_PROTOCOL_CONFIG,
  ACCOUNT_DISC_UNDERWRITER_POSITION,
  TriggerType as TriggerEnum,
  ClaimStatus as ClaimStatusEnum,
  decodeClaim,
  decodeCoveragePool,
  decodePolicy,
  decodeProtocolConfig,
  decodeUnderwriterPosition,
} from "@q3labs/pact-protocol-v2-client";
import { PrismaService } from "../prisma/prisma.service";
import type { HeliusAccountChange } from "./webhook.dto";

const TRIGGER_NAMES = [
  "Timeout",
  "Error",
  "SchemaMismatch",
  "LatencySla",
] as const;
const STATUS_NAMES = ["Pending", "Approved", "Rejected"] as const;

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(private readonly prisma: PrismaService) {}

  async ingestBatch(
    changes: HeliusAccountChange[]
  ): Promise<{ processed: number; skipped: number }> {
    let processed = 0;
    let skipped = 0;
    for (const change of changes) {
      try {
        const updated = await this.ingest(change);
        if (updated) processed += 1;
        else skipped += 1;
      } catch (err) {
        this.logger.warn(
          `webhook ingest failed for ${change.account}: ${(err as Error).message}`
        );
        skipped += 1;
      }
    }
    return { processed, skipped };
  }

  private async ingest(change: HeliusAccountChange): Promise<boolean> {
    if (change.closed) {
      // Account closed — drop matching row(s). Currently only Claim PDAs
      // could plausibly be closed, but the program does not close any
      // account. No-op.
      return false;
    }
    const buf = Buffer.from(change.data, "base64");
    if (buf.length === 0) return false;
    const disc = buf[0];
    const slotBig = BigInt(change.slot);

    switch (disc) {
      case ACCOUNT_DISC_PROTOCOL_CONFIG:
        return this.upsertProtocolConfig(change.account, buf, slotBig);
      case ACCOUNT_DISC_COVERAGE_POOL:
        return this.upsertPool(change.account, buf, slotBig);
      case ACCOUNT_DISC_UNDERWRITER_POSITION:
        return this.upsertPosition(change.account, buf, slotBig);
      case ACCOUNT_DISC_POLICY:
        return this.upsertPolicy(change.account, buf, slotBig);
      case ACCOUNT_DISC_CLAIM:
        return this.upsertClaim(change.account, buf, slotBig);
      default:
        this.logger.debug(
          `Unknown discriminator ${disc} for account ${change.account}; skipping`
        );
        return false;
    }
  }

  private async upsertProtocolConfig(
    configPda: string,
    data: Buffer,
    slot: bigint
  ): Promise<boolean> {
    const decoded = decodeProtocolConfig(data);
    // Last-write-wins on slot. updateMany returns count > 0 if it ran.
    const updated = await this.prisma.v2ProtocolConfig.updateMany({
      where: { configPda, slot: { lt: slot } },
      data: {
        authority: decoded.authority,
        oracle: decoded.oracle,
        treasury: decoded.treasury,
        usdcMint: decoded.usdcMint,
        minPoolDeposit: decoded.minPoolDeposit,
        defaultMaxCoveragePerCall: decoded.defaultMaxCoveragePerCall,
        withdrawalCooldownSeconds: decoded.withdrawalCooldownSeconds,
        aggregateCapWindowSeconds: decoded.aggregateCapWindowSeconds,
        claimWindowSeconds: decoded.claimWindowSeconds,
        protocolFeeBps: decoded.protocolFeeBps,
        defaultInsuranceRateBps: decoded.defaultInsuranceRateBps,
        minPremiumBps: decoded.minPremiumBps,
        aggregateCapBps: decoded.aggregateCapBps,
        maxClaimsPerBatch: decoded.maxClaimsPerBatch,
        paused: decoded.paused === 1,
        bump: decoded.bump,
        slot,
      },
    });
    if (updated.count > 0) return true;
    // Either no row exists OR our slot is stale.
    const existing = await this.prisma.v2ProtocolConfig.findUnique({
      where: { configPda },
      select: { slot: true },
    });
    if (existing && existing.slot >= slot) return false;
    await this.prisma.v2ProtocolConfig.create({
      data: {
        configPda,
        authority: decoded.authority,
        oracle: decoded.oracle,
        treasury: decoded.treasury,
        usdcMint: decoded.usdcMint,
        minPoolDeposit: decoded.minPoolDeposit,
        defaultMaxCoveragePerCall: decoded.defaultMaxCoveragePerCall,
        withdrawalCooldownSeconds: decoded.withdrawalCooldownSeconds,
        aggregateCapWindowSeconds: decoded.aggregateCapWindowSeconds,
        claimWindowSeconds: decoded.claimWindowSeconds,
        protocolFeeBps: decoded.protocolFeeBps,
        defaultInsuranceRateBps: decoded.defaultInsuranceRateBps,
        minPremiumBps: decoded.minPremiumBps,
        aggregateCapBps: decoded.aggregateCapBps,
        maxClaimsPerBatch: decoded.maxClaimsPerBatch,
        paused: decoded.paused === 1,
        bump: decoded.bump,
        slot,
      },
    });
    return true;
  }

  private async upsertPool(
    poolPda: string,
    data: Buffer,
    slot: bigint
  ): Promise<boolean> {
    const decoded = decodeCoveragePool(data);
    const fields = {
      authority: decoded.authority,
      usdcMint: decoded.usdcMint,
      vault: decoded.vault,
      providerHostname: decoded.providerHostname,
      totalDeposited: decoded.totalDeposited,
      totalAvailable: decoded.totalAvailable,
      totalPremiumsEarned: decoded.totalPremiumsEarned,
      totalClaimsPaid: decoded.totalClaimsPaid,
      maxCoveragePerCall: decoded.maxCoveragePerCall,
      payoutsThisWindow: decoded.payoutsThisWindow,
      windowStart: decoded.windowStart,
      createdAtOnChain: decoded.createdAt,
      updatedAtOnChain: decoded.updatedAt,
      activePolicies: decoded.activePolicies,
      insuranceRateBps: decoded.insuranceRateBps,
      minPremiumBps: decoded.minPremiumBps,
      bump: decoded.bump,
      vaultBump: decoded.vaultBump,
      slot,
    };
    const updated = await this.prisma.v2Pool.updateMany({
      where: { poolPda, slot: { lt: slot } },
      data: fields,
    });
    if (updated.count > 0) return true;
    const existing = await this.prisma.v2Pool.findUnique({
      where: { poolPda },
      select: { slot: true },
    });
    if (existing && existing.slot >= slot) return false;
    await this.prisma.v2Pool.create({ data: { poolPda, ...fields } });
    return true;
  }

  private async upsertPosition(
    positionPda: string,
    data: Buffer,
    slot: bigint
  ): Promise<boolean> {
    const decoded = decodeUnderwriterPosition(data);
    const fields = {
      pool: decoded.pool,
      underwriter: decoded.underwriter,
      deposited: decoded.deposited,
      earnedPremiums: decoded.earnedPremiums,
      lossesAbsorbed: decoded.lossesAbsorbed,
      depositTimestamp: decoded.depositTimestamp,
      lastClaimTimestamp: decoded.lastClaimTimestamp,
      bump: decoded.bump,
      slot,
    };
    const updated = await this.prisma.v2Position.updateMany({
      where: { positionPda, slot: { lt: slot } },
      data: fields,
    });
    if (updated.count > 0) return true;
    const existing = await this.prisma.v2Position.findUnique({
      where: { positionPda },
      select: { slot: true },
    });
    if (existing && existing.slot >= slot) return false;
    await this.prisma.v2Position.create({
      data: { positionPda, ...fields },
    });
    return true;
  }

  private async upsertPolicy(
    policyPda: string,
    data: Buffer,
    slot: bigint
  ): Promise<boolean> {
    const decoded = decodePolicy(data);
    const fields = {
      agent: decoded.agent,
      pool: decoded.pool,
      agentTokenAccount: decoded.agentTokenAccount,
      agentId: decoded.agentId,
      totalPremiumsPaid: decoded.totalPremiumsPaid,
      totalClaimsReceived: decoded.totalClaimsReceived,
      callsCovered: decoded.callsCovered,
      createdAtOnChain: decoded.createdAt,
      expiresAt: decoded.expiresAt,
      active: decoded.active === 1,
      bump: decoded.bump,
      referrer: decoded.referrer ?? null,
      referrerShareBps: decoded.referrerShareBps,
      referrerPresent: decoded.referrerPresent === 1,
      slot,
    };
    const updated = await this.prisma.v2Policy.updateMany({
      where: { policyPda, slot: { lt: slot } },
      data: fields,
    });
    if (updated.count > 0) return true;
    const existing = await this.prisma.v2Policy.findUnique({
      where: { policyPda },
      select: { slot: true },
    });
    if (existing && existing.slot >= slot) return false;
    await this.prisma.v2Policy.create({ data: { policyPda, ...fields } });
    return true;
  }

  private async upsertClaim(
    claimPda: string,
    data: Buffer,
    slot: bigint
  ): Promise<boolean> {
    const decoded = decodeClaim(data);
    const triggerName =
      decoded.triggerType < TRIGGER_NAMES.length
        ? TRIGGER_NAMES[decoded.triggerType]
        : "Error";
    const statusName =
      decoded.status < STATUS_NAMES.length
        ? STATUS_NAMES[decoded.status]
        : "Pending";

    const fields = {
      policy: decoded.policy,
      pool: decoded.pool,
      agent: decoded.agent,
      callIdHash: bytesToHex(decoded.callId),
      evidenceHash: bytesToHex(decoded.evidenceHash),
      paymentAmount: decoded.paymentAmount,
      refundAmount: decoded.refundAmount,
      callTimestamp: decoded.callTimestamp,
      createdAtOnChain: decoded.createdAt,
      resolvedAt: decoded.resolvedAt,
      latencyMs: decoded.latencyMs,
      statusCode: decoded.statusCode,
      triggerType: triggerName as any,
      status: statusName as any,
      bump: decoded.bump,
      slot,
    };
    const updated = await this.prisma.v2Claim.updateMany({
      where: { claimPda, slot: { lt: slot } },
      data: fields,
    });
    if (updated.count > 0) return true;
    const existing = await this.prisma.v2Claim.findUnique({
      where: { claimPda },
      select: { slot: true },
    });
    if (existing && existing.slot >= slot) return false;
    await this.prisma.v2Claim.create({ data: { claimPda, ...fields } });
    return true;
  }
}

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i]!.toString(16).padStart(2, "0");
  }
  return s;
}
