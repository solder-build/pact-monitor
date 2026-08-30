// EventsService — ledger-only ingest for settler-v2 events.
//
// AUTHORITATIVE-SOURCE RULE (Locked decision §Architecture):
//   This service writes ONLY V2PremiumSettlement and V2Claim rows. It does
//   NOT mutate V2Pool, V2Policy, V2Position, or V2ProtocolConfig counter
//   fields. The watcher path (webhook from Helius / programSubscribe) owns
//   all on-chain account state.
//
//   The one exception is FK-keeping upserts for V2Agent — denormalized
//   rollup row that exists for dashboard convenience. We bump callsCovered
//   and the rolling totalPremiumsPaid / totalClaimsReceived counters from
//   the ledger rows we just inserted.

import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@pact-network/db-v2";
import { PrismaService } from "../prisma/prisma.service";
import type {
  SettlePremiumEventDto,
  SubmitClaimEventDto,
} from "./events.dto";

const TRIGGER_BY_INDEX = [
  "Timeout",
  "Error",
  "SchemaMismatch",
  "LatencySla",
] as const;

@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async ingestSettlePremium(dto: SettlePremiumEventDto): Promise<{ inserted: number }> {
    if (!dto.signature || dto.calls.length === 0) {
      throw new Error("settle-premium event missing signature or calls");
    }
    const settledAt = new Date(dto.ts);

    // Single transaction; multi-ix txs land N rows sharing one signature.
    const inserted = await this.prisma.$transaction(async (tx) => {
      // Agent upserts in lex order to prevent deadlock under concurrent
      // ingest (V1 pattern, events.service.ts:117-150).
      const agents = Array.from(
        new Set(dto.calls.map((c) => c.agentPubkey))
      ).sort();
      for (const agent of agents) {
        const sumPremium = dto.calls
          .filter((c) => c.agentPubkey === agent)
          .reduce((s, c) => s + BigInt(c.callValue), 0n);
        await tx.v2Agent.upsert({
          where: { pubkey: agent },
          update: {
            totalPremiumsPaid: { increment: sumPremium },
            callsCovered: { increment: BigInt(
              dto.calls.filter((c) => c.agentPubkey === agent).length
            ) },
          },
          create: {
            pubkey: agent,
            totalPremiumsPaid: sumPremium,
            callsCovered: BigInt(
              dto.calls.filter((c) => c.agentPubkey === agent).length
            ),
          },
        });
      }

      let count = 0;
      for (const c of dto.calls) {
        try {
          await tx.v2PremiumSettlement.create({
            data: {
              signature: dto.signature,
              policy: c.policyPda,
              callId: c.callId,
              callIdHash: c.callIdHash,
              callValue: BigInt(c.callValue),
              poolCut: BigInt(c.poolCut),
              treasuryCut: BigInt(c.treasuryCut),
              referrerCut: BigInt(c.referrerCut),
              settledAt,
            },
          });
          count += 1;
        } catch (err) {
          // Idempotency: P2002 unique constraint on (signature, callId)
          // means we already ingested this exact row. Quiet.
          if (
            err instanceof Prisma.PrismaClientKnownRequestError &&
            err.code === "P2002"
          ) {
            this.logger.debug(
              `Duplicate V2PremiumSettlement (sig=${dto.signature}, callId=${c.callId}); skipping`
            );
            continue;
          }
          throw err;
        }
      }
      return count;
    });

    return { inserted };
  }

  async ingestSubmitClaim(dto: SubmitClaimEventDto): Promise<{ inserted: boolean }> {
    if (!dto.signature || !dto.claim?.callIdHash) {
      throw new Error("submit-claim event missing required fields");
    }
    const c = dto.claim;
    const triggerName =
      c.triggerType >= 0 && c.triggerType < TRIGGER_BY_INDEX.length
        ? TRIGGER_BY_INDEX[c.triggerType]
        : "Error";

    return await this.prisma.$transaction(async (tx) => {
      // Agent + Policy upsert for FK consistency. Counter fields stay
      // watcher-owned — increment only V2Agent (denormalized rollup).
      await tx.v2Agent.upsert({
        where: { pubkey: c.agentPubkey },
        update: {
          totalClaimsReceived: { increment: BigInt(c.refundAmount) },
        },
        create: {
          pubkey: c.agentPubkey,
          totalClaimsReceived: BigInt(c.refundAmount),
        },
      });

      try {
        await tx.v2Claim.create({
          data: {
            claimPda: c.claimPda,
            policy: c.policyPda,
            pool: c.pool,
            agent: c.agentPubkey,
            callIdHash: c.callIdHash,
            evidenceHash: c.evidenceHash,
            paymentAmount: BigInt(c.paymentAmount),
            refundAmount: BigInt(c.refundAmount),
            callTimestamp: BigInt(c.callTimestamp),
            createdAtOnChain: BigInt(Math.floor(Date.parse(dto.ts) / 1000)),
            resolvedAt: BigInt(Math.floor(Date.parse(dto.ts) / 1000)),
            latencyMs: c.latencyMs,
            statusCode: c.statusCode,
            triggerType: triggerName as any,
            status: "Approved",
            bump: 0,
          },
        });
        return { inserted: true };
      } catch (err) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === "P2002"
        ) {
          this.logger.debug(
            `Duplicate V2Claim (callIdHash=${c.callIdHash}); skipping`
          );
          return { inserted: false };
        }
        throw err;
      }
    });
  }
}
