import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@pact-network/db-v2";
import { EventsService } from "./events.service";

function fakePrisma() {
  const v2Agent = { upsert: vi.fn(async () => ({})) };
  const v2PremiumSettlement = { create: vi.fn(async () => ({})) };
  const v2Claim = { create: vi.fn(async () => ({})) };
  const $transaction = vi.fn(async (cb: any) =>
    cb({ v2Agent, v2PremiumSettlement, v2Claim })
  );
  return {
    v2Agent,
    v2PremiumSettlement,
    v2Claim,
    $transaction,
    asService: { v2Agent, v2PremiumSettlement, v2Claim, $transaction },
  };
}

describe("EventsService.ingestSettlePremium", () => {
  it("inserts one settlement row per call + upserts agents in lex order", async () => {
    const prisma = fakePrisma();
    const svc = new EventsService(prisma.asService as any);

    const dto = {
      signature: "Sig123",
      ts: "2026-05-20T10:00:00Z",
      calls: [
        {
          callId: "c-1",
          callIdHash: "a".repeat(64),
          agentPubkey: "AgentZ",
          policyPda: "Policy1",
          callValue: "1000000",
          poolCut: "17000",
          treasuryCut: "3000",
          referrerCut: "0",
        },
        {
          callId: "c-2",
          callIdHash: "b".repeat(64),
          agentPubkey: "AgentA",
          policyPda: "Policy2",
          callValue: "2000000",
          poolCut: "34000",
          treasuryCut: "6000",
          referrerCut: "0",
        },
      ],
    };

    const result = await svc.ingestSettlePremium(dto);
    expect(result.inserted).toBe(2);
    expect(prisma.v2PremiumSettlement.create).toHaveBeenCalledTimes(2);
    // Agents upserted: AgentA then AgentZ (lex order)
    expect(prisma.v2Agent.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.v2Agent.upsert.mock.calls[0]?.[0]?.where?.pubkey).toBe("AgentA");
    expect(prisma.v2Agent.upsert.mock.calls[1]?.[0]?.where?.pubkey).toBe("AgentZ");
  });

  it("ignores P2002 duplicate constraint and continues", async () => {
    const prisma = fakePrisma();
    prisma.v2PremiumSettlement.create = vi.fn(async () => {
      throw new Prisma.PrismaClientKnownRequestError("dup", {
        code: "P2002",
        clientVersion: "5.22.0",
      });
    });
    const svc = new EventsService(prisma.asService as any);
    const dto = {
      signature: "S",
      ts: "2026-05-20T10:00:00Z",
      calls: [
        {
          callId: "c",
          callIdHash: "x".repeat(64),
          agentPubkey: "A",
          policyPda: "P",
          callValue: "1",
          poolCut: "0",
          treasuryCut: "0",
          referrerCut: "0",
        },
      ],
    };
    const result = await svc.ingestSettlePremium(dto);
    expect(result.inserted).toBe(0);
  });

  it("rejects empty calls array", async () => {
    const prisma = fakePrisma();
    const svc = new EventsService(prisma.asService as any);
    await expect(
      svc.ingestSettlePremium({ signature: "S", ts: "2026-05-20T10:00:00Z", calls: [] })
    ).rejects.toThrow(/missing signature or calls/);
  });
});

describe("EventsService.ingestSubmitClaim", () => {
  it("inserts a V2Claim with mapped triggerType + status enums", async () => {
    const prisma = fakePrisma();
    const svc = new EventsService(prisma.asService as any);
    const result = await svc.ingestSubmitClaim({
      signature: "ClaimSig",
      ts: "2026-05-20T10:00:00Z",
      claim: {
        callId: "c-1",
        callIdHash: "f".repeat(64),
        claimPda: "ClaimPda1",
        policyPda: "Policy1",
        pool: "Pool1",
        agentPubkey: "Agent1",
        paymentAmount: "1000000",
        refundAmount: "500000",
        evidenceHash: "e".repeat(64),
        statusCode: 503,
        latencyMs: 100,
        triggerType: 1, // Error
        callTimestamp: "1748180000",
      },
    });
    expect(result.inserted).toBe(true);
    expect(prisma.v2Claim.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          claimPda: "ClaimPda1",
          triggerType: "Error",
          status: "Approved",
        }),
      })
    );
  });

  it("skips duplicate Claim via P2002", async () => {
    const prisma = fakePrisma();
    prisma.v2Claim.create = vi.fn(async () => {
      throw new Prisma.PrismaClientKnownRequestError("dup", {
        code: "P2002",
        clientVersion: "5.22.0",
      });
    });
    const svc = new EventsService(prisma.asService as any);
    const result = await svc.ingestSubmitClaim({
      signature: "ClaimSig",
      ts: "2026-05-20T10:00:00Z",
      claim: {
        callId: "c-dup",
        callIdHash: "f".repeat(64),
        claimPda: "P",
        policyPda: "Po",
        pool: "Pl",
        agentPubkey: "A",
        paymentAmount: "1",
        refundAmount: "1",
        evidenceHash: "e".repeat(64),
        statusCode: 500,
        latencyMs: 0,
        triggerType: 1,
        callTimestamp: "0",
      },
    });
    expect(result.inserted).toBe(false);
  });

  it("rejects missing required fields", async () => {
    const prisma = fakePrisma();
    const svc = new EventsService(prisma.asService as any);
    await expect(
      svc.ingestSubmitClaim({ signature: "", ts: "x", claim: {} as any })
    ).rejects.toThrow(/missing required fields/);
  });
});
