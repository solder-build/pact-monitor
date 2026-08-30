import { describe, it, expect, vi } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  PROGRAM_ID,
  USDC_MINT_DEVNET,
  decodeClaim,
  getClaimPda,
  getCoveragePoolPda,
  getPolicyPda,
  getProtocolConfigPda,
} from "@q3labs/pact-protocol-v2-client";
import {
  ClaimSubmitError,
  ClaimSubmitterService,
} from "./claim-submitter.service";

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

function fakeSecrets(): any {
  return { keypair: Keypair.generate() };
}

function encodeProtocolConfig(): Buffer {
  const buf = Buffer.alloc(256);
  buf[0] = 0;
  Keypair.generate().publicKey.toBuffer().copy(buf, 8);
  Keypair.generate().publicKey.toBuffer().copy(buf, 40);
  Keypair.generate().publicKey.toBuffer().copy(buf, 72);
  USDC_MINT_DEVNET.toBuffer().copy(buf, 104);
  return buf;
}

function encodePool(): Buffer {
  const buf = Buffer.alloc(320);
  buf[0] = 1;
  Keypair.generate().publicKey.toBuffer().copy(buf, 8);
  USDC_MINT_DEVNET.toBuffer().copy(buf, 40);
  Keypair.generate().publicKey.toBuffer().copy(buf, 72);
  const host = Buffer.from("api.example.com", "utf8");
  host.copy(buf, 104);
  buf.writeUInt8(host.length, 248);
  buf.writeBigUInt64LE(1_000_000n, 200);
  return buf;
}

function encodePolicy(agent: PublicKey, pool: PublicKey): Buffer {
  const buf = Buffer.alloc(320);
  buf[0] = 3;
  agent.toBuffer().copy(buf, 8);
  pool.toBuffer().copy(buf, 40);
  // agent_token_account at offset 72 — use derived ATA.
  Keypair.generate().publicKey.toBuffer().copy(buf, 72);
  buf.writeUInt8(0, 208); // agentIdLen=0
  buf.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000) + 86400), 200); // expiresAt
  buf.writeUInt8(1, 209); // active=1
  return buf;
}

function buildBreachMessage(
  callId: string,
  agent: PublicKey,
  hostname: string
): any {
  const [pool] = getCoveragePoolPda(PROGRAM_ID, hostname);
  const [policy] = getPolicyPda(PROGRAM_ID, pool, agent);
  return {
    id: `mid-${callId}`,
    data: {
      callId,
      agentPubkey: agent.toBase58(),
      hostname,
      policyPda: policy.toBase58(),
      callValue: "1000000",
      outcome: "server_error",
      paymentAmount: "1000000",
      evidenceHash: "deadbeef".repeat(8),
      statusCode: 503,
      triggerType: 1,
      callTimestamp: Math.floor(Date.now() / 1000).toString(),
      latencyMs: 50,
    },
    ack: vi.fn(),
    nack: vi.fn(),
  };
}

function buildConnectionStub(opts: {
  claimExists?: boolean;
  policyExists?: boolean;
  poolExists?: boolean;
  protocolConfigExists?: boolean;
  sendThrows?: boolean;
  neverConfirm?: boolean;
}): any {
  const agent = Keypair.generate().publicKey;
  return {
    getAccountInfo: vi.fn(async (pubkey: PublicKey) => {
      const [cfg] = getProtocolConfigPda(PROGRAM_ID);
      if (pubkey.equals(cfg)) {
        return opts.protocolConfigExists !== false
          ? { data: encodeProtocolConfig(), owner: PROGRAM_ID, lamports: 0, executable: false }
          : null;
      }
      // Heuristic: by call order, the FIRST non-config getAccountInfo is the
      // claim PDA check, SECOND is policy, THIRD is pool, FOURTH is config
      // re-check inside ensureProtocolConfigExists.
      // Simpler: return based on the prefix of the pubkey. Tests don't need
      // perfect routing — just need to make the right outcomes happen.
      return null;
    }),
    sendRawTransaction: vi.fn(async () => {
      if (opts.sendThrows) throw new Error("send failed");
      return "ClaimSig111111111111111111111111";
    }),
    getLatestBlockhash: vi.fn(async () => ({
      blockhash: "EBLvr9smm6c7RJYjFc8Tt4Q5sNa1NNqDNxbtxkU8oP4D",
      lastValidBlockHeight: 100_000,
    })),
    getSignatureStatuses: vi.fn(async () => ({
      value: opts.neverConfirm
        ? [null]
        : [{ confirmationStatus: "confirmed", err: null, slot: 1, confirmations: 1 }],
    })),
  };
}

describe("ClaimSubmitterService — unit", () => {
  const agent = Keypair.generate().publicKey;
  const hostname = "api.example.com";

  it("short-circuits when Claim PDA already exists", async () => {
    const [pool] = getCoveragePoolPda(PROGRAM_ID, hostname);
    const [policy] = getPolicyPda(PROGRAM_ID, pool, agent);
    const conn: any = {
      getAccountInfo: vi.fn(async (pubkey: PublicKey) => {
        // Claim PDA check is the first non-config call. Return non-null.
        const [cfg] = getProtocolConfigPda(PROGRAM_ID);
        if (pubkey.equals(cfg)) {
          return { data: encodeProtocolConfig(), owner: PROGRAM_ID, lamports: 0, executable: false };
        }
        // Treat any other PDA as the Claim and return existing.
        return {
          data: Buffer.alloc(288, 4), // discriminator=4 for Claim
          owner: PROGRAM_ID,
          lamports: 0,
          executable: false,
        };
      }),
      sendRawTransaction: vi.fn(),
      getLatestBlockhash: vi.fn(),
      getSignatureStatuses: vi.fn(),
    };
    const svc = new ClaimSubmitterService(
      fakeConfig(),
      conn,
      fakeSecrets()
    );

    const msg = buildBreachMessage("call-dup", agent, hostname);
    const outcome = await svc.submit(msg);

    expect(outcome.shortCircuited).toBe(true);
    expect(outcome.signature).toBe("");
    expect(conn.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("rejects malformed breach event (missing evidenceHash)", async () => {
    const conn = buildConnectionStub({});
    const svc = new ClaimSubmitterService(fakeConfig(), conn, fakeSecrets());
    const msg = buildBreachMessage("call-bad", agent, hostname);
    (msg.data as Record<string, unknown>).evidenceHash = "deadbeef"; // too short
    await expect(svc.submit(msg)).rejects.toThrow(ClaimSubmitError);
  });

  it("rejects malformed breach event (paymentAmount=0)", async () => {
    const conn = buildConnectionStub({});
    const svc = new ClaimSubmitterService(fakeConfig(), conn, fakeSecrets());
    const msg = buildBreachMessage("call-zero", agent, hostname);
    (msg.data as Record<string, unknown>).paymentAmount = "0";
    await expect(svc.submit(msg)).rejects.toThrow(ClaimSubmitError);
  });

  it("rejects out-of-range triggerType", async () => {
    const conn = buildConnectionStub({});
    const svc = new ClaimSubmitterService(fakeConfig(), conn, fakeSecrets());
    const msg = buildBreachMessage("call-trig", agent, hostname);
    (msg.data as Record<string, unknown>).triggerType = 99;
    await expect(svc.submit(msg)).rejects.toThrow(ClaimSubmitError);
  });
});
