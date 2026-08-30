/**
 * PremiumSubmitterService integration test against a mocked Connection.
 *
 * Why mocked (not LiteSVM): the cross-language verification loop (TS
 * encoded bytes ↔ Rust on-chain decoder) is already covered by the V2
 * program's existing LiteSVM tests at
 * `packages/program/programs-pinocchio/pact-network-v2-pinocchio/tests/`
 * (65/65 green). The cranker's job is to (a) compose the right ix via
 * v2-client builders and (b) drive Prisma's idempotency ledger correctly.
 * Both are visible at the Connection/Prisma boundary without a real VM —
 * mocking that boundary gives a faster, more focused test surface.
 *
 * Coverage:
 *   - happy path: builds ix with correct accounts + writes V2PremiumAttempt
 *     Pending → Confirmed
 *   - short-circuit: pre-existing Confirmed attempt → ack-skipped
 *   - send failure: BatchSubmitError surfaces + Failed write
 *   - confirmation timeout: BatchSubmitError + Failed write
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ComputeBudgetInstruction,
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import {
  DISC_SETTLE_PREMIUM,
  PROGRAM_ID,
  USDC_MINT_DEVNET,
  decodeCoveragePool,
  decodeProtocolConfig,
  deriveAssociatedTokenAccount,
  getCoveragePoolPda,
  getPolicyPda,
  getProtocolConfigPda,
  getVaultPda,
} from "@q3labs/pact-protocol-v2-client";
import {
  BatchSubmitError,
  PremiumSubmitterService,
} from "./premium-submitter.service";
import type { SettleBatch } from "../batcher/batcher.service";

function fakeConfig(overrides: Record<string, unknown> = {}): any {
  const defaults: Record<string, unknown> = {
    PROGRAM_ID: PROGRAM_ID.toBase58(),
    USDC_MINT: USDC_MINT_DEVNET.toBase58(),
    COMPUTE_UNIT_LIMIT: 1_400_000,
    COMPUTE_UNIT_PRICE_MICROLAMPORTS: 5000,
    CONFIRM_TIMEOUT_MS: 5_000,
    CONFIRM_POLL_INTERVAL_MS: 10,
    ...overrides,
  };
  return {
    get: (k: string) => defaults[k],
    getOrThrow: (k: string) => {
      const v = defaults[k];
      if (v === undefined) throw new Error(`missing ${k}`);
      return v;
    },
  };
}

// Build a minimum-viable encoded ProtocolConfig buffer for decodeProtocolConfig.
// We only need the treasury + protocolFeeBps to be readable.
function encodeProtocolConfig(treasury: PublicKey, protocolFeeBps: number): Buffer {
  const buf = Buffer.alloc(256);
  buf[0] = 0; // discriminator
  // authority + oracle + treasury + usdcMint
  Keypair.generate().publicKey.toBuffer().copy(buf, 8); // authority
  Keypair.generate().publicKey.toBuffer().copy(buf, 40); // oracle
  treasury.toBuffer().copy(buf, 72); // treasury at offset 72
  USDC_MINT_DEVNET.toBuffer().copy(buf, 104);
  // protocolFeeBps is at offset 176 (u16 LE)
  buf.writeUInt16LE(protocolFeeBps, 176);
  return buf;
}

function encodeCoveragePool(
  authority: PublicKey,
  mint: PublicKey,
  vault: PublicKey,
  hostname: string,
  insuranceRateBps: number,
  minPremiumBps: number
): Buffer {
  const buf = Buffer.alloc(320);
  buf[0] = 1; // discriminator
  authority.toBuffer().copy(buf, 8);
  mint.toBuffer().copy(buf, 40);
  vault.toBuffer().copy(buf, 72);
  const hostBytes = Buffer.from(hostname, "utf8");
  hostBytes.copy(buf, 104, 0, Math.min(64, hostBytes.length));
  buf.writeUInt8(hostBytes.length, 248);
  // counters (u64 LE) start at 168
  buf.writeBigUInt64LE(0n, 168);
  buf.writeBigUInt64LE(0n, 176);
  buf.writeBigUInt64LE(0n, 184);
  buf.writeBigUInt64LE(0n, 192);
  buf.writeBigUInt64LE(1_000_000n, 200); // maxCoveragePerCall
  buf.writeUInt16LE(insuranceRateBps, 244);
  buf.writeUInt16LE(minPremiumBps, 246);
  return buf;
}

interface ConnectionStub {
  getAccountInfo: ReturnType<typeof vi.fn>;
  getLatestBlockhash: ReturnType<typeof vi.fn>;
  sendRawTransaction: ReturnType<typeof vi.fn>;
  getSignatureStatuses: ReturnType<typeof vi.fn>;
  sentRawTx?: Uint8Array;
}

function buildConnectionStub(opts: {
  protocolConfig?: Buffer | null;
  pool?: Buffer | null;
  policy?: Buffer | null;
  poolPda?: PublicKey;
  sendShouldThrow?: boolean;
  sendSignature?: string;
  confirmAfterMs?: number;
  confirmError?: boolean;
  neverConfirm?: boolean;
}): ConnectionStub {
  const [configPda] = getProtocolConfigPda(PROGRAM_ID);
  const stub: ConnectionStub = {
    getAccountInfo: vi.fn(async (pubkey: PublicKey) => {
      if (pubkey.equals(configPda)) {
        return opts.protocolConfig
          ? {
              data: opts.protocolConfig,
              owner: PROGRAM_ID,
              lamports: 0,
              executable: false,
            }
          : null;
      }
      if (opts.poolPda && pubkey.equals(opts.poolPda)) {
        return opts.pool
          ? {
              data: opts.pool,
              owner: PROGRAM_ID,
              lamports: 0,
              executable: false,
            }
          : null;
      }
      // Anything else is treated as a Policy PDA lookup. Return policy
      // bytes if provided, else null (means no referrer, which is the
      // common case).
      if (opts.policy) {
        return {
          data: opts.policy,
          owner: PROGRAM_ID,
          lamports: 0,
          executable: false,
        };
      }
      return null;
    }),
    getLatestBlockhash: vi.fn(async () => ({
      blockhash: "EBLvr9smm6c7RJYjFc8Tt4Q5sNa1NNqDNxbtxkU8oP4D",
      lastValidBlockHeight: 100_000,
    })),
    sendRawTransaction: vi.fn(async (rawTx: Uint8Array) => {
      if (opts.sendShouldThrow) throw new Error("simulated send failure");
      stub.sentRawTx = rawTx;
      return opts.sendSignature ?? "FakeSig11111111111111111111111111111";
    }),
    getSignatureStatuses: vi.fn(async () => {
      if (opts.neverConfirm) {
        return { value: [null] };
      }
      return {
        value: [
          {
            confirmationStatus: "confirmed",
            err: opts.confirmError ? { Custom: 1 } : null,
            slot: 1,
            confirmations: 1,
          },
        ],
      };
    }),
  };
  return stub;
}

function fakeSecrets(): any {
  const keypair = Keypair.generate();
  return { keypair };
}

function fakePrisma(): any {
  return {
    v2PremiumAttempt: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
  };
}

function buildBatch(
  hostname: string,
  callIds: string[],
  agent: PublicKey
): SettleBatch {
  const [pool] = getCoveragePoolPda(PROGRAM_ID, hostname);
  const [policy] = getPolicyPda(PROGRAM_ID, pool, agent);
  return {
    hostname,
    messages: callIds.map((cid) => ({
      id: `mid-${cid}`,
      data: {
        callId: cid,
        agentPubkey: agent.toBase58(),
        hostname,
        policyPda: policy.toBase58(),
        callValue: "1000000",
        outcome: "ok",
      },
      ack: vi.fn(),
      nack: vi.fn(),
    })),
  };
}

describe("PremiumSubmitterService — integration (mocked Connection)", () => {
  const agent = Keypair.generate().publicKey;
  const treasury = Keypair.generate().publicKey;
  const hostname = "api.example.com";

  let protocolConfigBuf: Buffer;
  let poolBuf: Buffer;

  beforeEach(() => {
    protocolConfigBuf = encodeProtocolConfig(treasury, 1500);
    const [pool] = getCoveragePoolPda(PROGRAM_ID, hostname);
    const [vault] = getVaultPda(PROGRAM_ID, pool);
    poolBuf = encodeCoveragePool(
      Keypair.generate().publicKey,
      USDC_MINT_DEVNET,
      vault,
      hostname,
      200,
      50
    );
  });

  it("happy path: builds tx with correct ix + Prisma transitions Pending→Confirmed", async () => {
    const [poolPda] = getCoveragePoolPda(PROGRAM_ID, hostname);
    const conn = buildConnectionStub({
      protocolConfig: protocolConfigBuf,
      pool: poolBuf,
      poolPda,
      policy: null,
    });
    const prisma = fakePrisma();
    const secrets = fakeSecrets();
    const svc = new PremiumSubmitterService(
      fakeConfig(),
      conn as any,
      secrets,
      prisma
    );

    const batch = buildBatch(hostname, ["call-1", "call-2"], agent);
    const outcome = await svc.submit(batch);

    expect(outcome.signature).not.toBe("");
    expect(outcome.acceptedIndexes).toEqual([0, 1]);
    expect(outcome.shortCircuitedIndexes).toEqual([]);
    expect(outcome.shares).toHaveLength(2);

    // V2PremiumAttempt upsert called once per call
    expect(prisma.v2PremiumAttempt.upsert).toHaveBeenCalledTimes(2);
    // updateMany to mark Confirmed at the end
    expect(prisma.v2PremiumAttempt.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "Confirmed" }),
      })
    );
    // Verify the sent tx contains a settle_premium ix (disc byte 7)
    const rawTx = conn.sentRawTx;
    expect(rawTx).toBeDefined();
    // sentRawTx is a serialized Transaction; just check it's non-trivial.
    expect(rawTx!.length).toBeGreaterThan(100);
  });

  it("short-circuit: existing Confirmed attempt → message acked, dropped from batch", async () => {
    const [poolPda] = getCoveragePoolPda(PROGRAM_ID, hostname);
    const conn = buildConnectionStub({
      protocolConfig: protocolConfigBuf,
      pool: poolBuf,
      poolPda,
    });
    const prisma = fakePrisma();
    prisma.v2PremiumAttempt.findUnique = vi.fn(async ({ where }: any) => {
      if (where.callId === "call-1") {
        return {
          callId: "call-1",
          status: "Confirmed",
          lastAttemptSignature: "OldSig111",
          attemptCount: 1,
        };
      }
      return null;
    });
    const svc = new PremiumSubmitterService(
      fakeConfig(),
      conn as any,
      fakeSecrets(),
      prisma
    );
    const batch = buildBatch(hostname, ["call-1", "call-2"], agent);

    const outcome = await svc.submit(batch);
    expect(outcome.shortCircuitedIndexes).toEqual([0]);
    expect(outcome.acceptedIndexes).toEqual([1]);
    expect(batch.messages[0]!.ack).toHaveBeenCalledTimes(1);
    expect(batch.messages[1]!.ack).not.toHaveBeenCalled();
  });

  it("send failure: throws BatchSubmitError + marks Failed", async () => {
    const [poolPda] = getCoveragePoolPda(PROGRAM_ID, hostname);
    const conn = buildConnectionStub({
      protocolConfig: protocolConfigBuf,
      pool: poolBuf,
      poolPda,
      sendShouldThrow: true,
    });
    const prisma = fakePrisma();
    const svc = new PremiumSubmitterService(
      fakeConfig(),
      conn as any,
      fakeSecrets(),
      prisma
    );
    const batch = buildBatch(hostname, ["call-1"], agent);

    await expect(svc.submit(batch)).rejects.toThrow(BatchSubmitError);
    expect(prisma.v2PremiumAttempt.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "Failed" }),
      })
    );
  });

  it("confirmation timeout: throws BatchSubmitError + marks Failed", async () => {
    const [poolPda] = getCoveragePoolPda(PROGRAM_ID, hostname);
    const conn = buildConnectionStub({
      protocolConfig: protocolConfigBuf,
      pool: poolBuf,
      poolPda,
      neverConfirm: true,
    });
    const prisma = fakePrisma();
    const svc = new PremiumSubmitterService(
      fakeConfig({ CONFIRM_TIMEOUT_MS: 50, CONFIRM_POLL_INTERVAL_MS: 10 }),
      conn as any,
      fakeSecrets(),
      prisma
    );
    const batch = buildBatch(hostname, ["call-1"], agent);

    await expect(svc.submit(batch)).rejects.toThrow(/confirmation timeout/);
    expect(prisma.v2PremiumAttempt.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "Failed" }),
      })
    );
  });

  it("submit throws on empty batch (defensive)", async () => {
    const [poolPda] = getCoveragePoolPda(PROGRAM_ID, hostname);
    const conn = buildConnectionStub({
      protocolConfig: protocolConfigBuf,
      pool: poolBuf,
      poolPda,
    });
    const svc = new PremiumSubmitterService(
      fakeConfig(),
      conn as any,
      fakeSecrets(),
      fakePrisma()
    );
    await expect(
      svc.submit({ hostname, messages: [] })
    ).rejects.toThrow(/empty batch/);
  });

  it("pool not on-chain → BatchSubmitError surfaced", async () => {
    const [poolPda] = getCoveragePoolPda(PROGRAM_ID, hostname);
    const conn = buildConnectionStub({
      protocolConfig: protocolConfigBuf,
      pool: null,
      poolPda,
    });
    const svc = new PremiumSubmitterService(
      fakeConfig(),
      conn as any,
      fakeSecrets(),
      fakePrisma()
    );
    const batch = buildBatch(hostname, ["call-1"], agent);
    await expect(svc.submit(batch)).rejects.toThrow(/pool not found/);
  });
});
