import { describe, expect, it } from "vitest";
import { AccountInfo, Connection, PublicKey } from "@solana/web3.js";
import {
  PROGRAM_ID,
  deriveAssociatedTokenAccount,
  getAgentPolicyState,
  getPoolState,
  getUnderwriterPositionState,
  hashCallId,
} from "../src/index.js";
import {
  getCoveragePoolPda,
  getPolicyPda,
  getUnderwriterPositionPda,
} from "../src/pda.js";
import {
  ACCOUNT_DISC_COVERAGE_POOL,
  ACCOUNT_DISC_POLICY,
  ACCOUNT_DISC_UNDERWRITER_POSITION,
  COVERAGE_POOL_LEN,
  POLICY_LEN,
  UNDERWRITER_POSITION_LEN,
} from "../src/state.js";

const fillKey = (b: number) => new PublicKey(new Uint8Array(32).fill(b));

function writePubkey(buf: Buffer, off: number, key: PublicKey) {
  Buffer.from(key.toBytes()).copy(buf, off);
}

function buildPolicy(opts: {
  agent: PublicKey;
  pool: PublicKey;
  active: 0 | 1;
  expiresAt: bigint;
}): Buffer {
  const buf = Buffer.alloc(POLICY_LEN);
  buf.writeUInt8(ACCOUNT_DISC_POLICY, 0);
  writePubkey(buf, 8, opts.agent);
  writePubkey(buf, 40, opts.pool);
  writePubkey(buf, 72, fillKey(0x33));
  Buffer.from("agent-007", "utf8").copy(buf, 104);
  buf.writeUInt8(9, 208);
  buf.writeBigInt64LE(opts.expiresAt, 200);
  buf.writeUInt8(opts.active, 209);
  buf.writeUInt8(254, 210);
  return buf;
}

function buildPool(): Buffer {
  const buf = Buffer.alloc(COVERAGE_POOL_LEN);
  buf.writeUInt8(ACCOUNT_DISC_COVERAGE_POOL, 0);
  writePubkey(buf, 8, fillKey(0x11));
  writePubkey(buf, 40, fillKey(0x12));
  writePubkey(buf, 72, fillKey(0x13));
  Buffer.from("api.openai.com", "utf8").copy(buf, 104);
  buf.writeUInt8(14, 248);
  return buf;
}

function buildPosition(opts: {
  pool: PublicKey;
  underwriter: PublicKey;
  deposited: bigint;
  depositTimestamp: bigint;
}): Buffer {
  const buf = Buffer.alloc(UNDERWRITER_POSITION_LEN);
  buf.writeUInt8(ACCOUNT_DISC_UNDERWRITER_POSITION, 0);
  writePubkey(buf, 8, opts.pool);
  writePubkey(buf, 40, opts.underwriter);
  buf.writeBigUInt64LE(opts.deposited, 72);
  buf.writeBigInt64LE(opts.depositTimestamp, 96);
  return buf;
}

function mockConn(byKey: Map<string, Buffer>): Connection {
  return {
    async getAccountInfo(
      key: PublicKey
    ): Promise<AccountInfo<Buffer> | null> {
      const data = byKey.get(key.toBase58());
      if (!data) return null;
      return {
        executable: false,
        owner: PROGRAM_ID,
        lamports: 1,
        data,
      };
    },
  } as unknown as Connection;
}

describe("deriveAssociatedTokenAccount", () => {
  it("derives the canonical ATA for a known (owner, mint) pair", () => {
    const owner = fillKey(0xaa);
    const mint = fillKey(0xbb);
    const ata = deriveAssociatedTokenAccount(owner, mint);
    const ATA_PROGRAM_ID = new PublicKey(
      "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
    );
    const TOKEN_PROGRAM_ID = new PublicKey(
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
    );
    const [expected] = PublicKey.findProgramAddressSync(
      [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
      ATA_PROGRAM_ID
    );
    expect(ata.toBase58()).toBe(expected.toBase58());
  });
});

describe("hashCallId reconciliation", () => {
  it("matches the SHA-256 fixture", () => {
    const h = hashCallId("abc");
    expect(Buffer.from(h).toString("hex")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });
});

describe("getPoolState", () => {
  it("returns exists=false when the pool PDA has no account", async () => {
    const conn = mockConn(new Map());
    const result = await getPoolState(conn, PROGRAM_ID, "api.openai.com");
    expect(result.exists).toBe(false);
    expect(result.pool).toBeUndefined();
  });

  it("returns exists=true + decoded snapshot when the account exists", async () => {
    const [pda] = getCoveragePoolPda(PROGRAM_ID, "api.openai.com");
    const conn = mockConn(new Map([[pda.toBase58(), buildPool()]]));
    const result = await getPoolState(conn, PROGRAM_ID, "api.openai.com");
    expect(result.exists).toBe(true);
    expect(result.pool?.providerHostname).toBe("api.openai.com");
  });
});

describe("getAgentPolicyState", () => {
  const agent = fillKey(0x31);
  const pool = fillKey(0x32);
  const [policyPda] = getPolicyPda(PROGRAM_ID, pool, agent);

  it("returns exists=false / eligibleForClaim=false for an unknown agent", async () => {
    const conn = mockConn(new Map());
    const s = await getAgentPolicyState(conn, agent, pool, PROGRAM_ID, 0);
    expect(s.exists).toBe(false);
    expect(s.eligibleForClaim).toBe(false);
  });

  it("marks an expired policy as ineligible", async () => {
    const buf = buildPolicy({
      agent,
      pool,
      active: 1,
      expiresAt: 1_000n,
    });
    const conn = mockConn(new Map([[policyPda.toBase58(), buf]]));
    const s = await getAgentPolicyState(conn, agent, pool, PROGRAM_ID, 5_000);
    expect(s.exists).toBe(true);
    expect(s.expired).toBe(true);
    expect(s.eligibleForClaim).toBe(false);
  });

  it("marks a disabled policy as ineligible", async () => {
    const buf = buildPolicy({
      agent,
      pool,
      active: 0,
      expiresAt: 10_000n,
    });
    const conn = mockConn(new Map([[policyPda.toBase58(), buf]]));
    const s = await getAgentPolicyState(conn, agent, pool, PROGRAM_ID, 5_000);
    expect(s.active).toBe(false);
    expect(s.eligibleForClaim).toBe(false);
  });

  it("marks active + unexpired as eligible", async () => {
    const buf = buildPolicy({
      agent,
      pool,
      active: 1,
      expiresAt: 10_000n,
    });
    const conn = mockConn(new Map([[policyPda.toBase58(), buf]]));
    const s = await getAgentPolicyState(conn, agent, pool, PROGRAM_ID, 5_000);
    expect(s.eligibleForClaim).toBe(true);
  });
});

describe("getUnderwriterPositionState", () => {
  const underwriter = fillKey(0x21);
  const pool = fillKey(0x22);
  const [positionPda] = getUnderwriterPositionPda(
    PROGRAM_ID,
    pool,
    underwriter
  );

  it("returns deposited=0 + cooldownElapsed=false when absent", async () => {
    const conn = mockConn(new Map());
    const s = await getUnderwriterPositionState(
      conn,
      underwriter,
      pool,
      PROGRAM_ID
    );
    expect(s.exists).toBe(false);
    expect(s.deposited).toBe(0n);
    expect(s.cooldownElapsed(1_000_000, 3600)).toBe(false);
  });

  it("decodes deposited + cooldownElapsed across the threshold", async () => {
    const buf = buildPosition({
      pool,
      underwriter,
      deposited: 500_000n,
      depositTimestamp: 1_700_000_000n,
    });
    const conn = mockConn(new Map([[positionPda.toBase58(), buf]]));
    const s = await getUnderwriterPositionState(
      conn,
      underwriter,
      pool,
      PROGRAM_ID
    );
    expect(s.exists).toBe(true);
    expect(s.deposited).toBe(500_000n);
    expect(s.cooldownElapsed(1_700_000_000 + 3599, 3600)).toBe(false);
    expect(s.cooldownElapsed(1_700_000_000 + 3600, 3600)).toBe(true);
  });
});
