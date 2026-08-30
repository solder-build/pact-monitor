/**
 * State-decoder tests for V2 accounts.
 *
 * Each test hand-rolls a fixture buffer at the documented offsets, decodes
 * via the V2 client, and asserts round-trip equality. Wrong-length and
 * wrong-discriminator inputs are expected to throw.
 *
 * Tests intentionally do NOT depend on the Rust side at runtime — the
 * cross-language invariant is enforced separately by `pda.test.ts` (which
 * pins PDA derivation to Rust fixtures) and by the Rust `state.rs` const
 * asserts (which break the Rust build if any offset drifts).
 */
import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import {
  ACCOUNT_DISC_CLAIM,
  ACCOUNT_DISC_COVERAGE_POOL,
  ACCOUNT_DISC_POLICY,
  ACCOUNT_DISC_PROTOCOL_CONFIG,
  ACCOUNT_DISC_UNDERWRITER_POSITION,
  CLAIM_LEN,
  COVERAGE_POOL_LEN,
  ClaimStatus,
  POLICY_LEN,
  PROTOCOL_CONFIG_LEN,
  TriggerType,
  UNDERWRITER_POSITION_LEN,
  decodeClaim,
  decodeCoveragePool,
  decodePolicy,
  decodeProtocolConfig,
  decodeUnderwriterPosition,
} from "../src/state.js";

function fillKey(byte: number): PublicKey {
  return new PublicKey(new Uint8Array(32).fill(byte));
}

function writePubkey(buf: Buffer, offset: number, key: PublicKey) {
  Buffer.from(key.toBytes()).copy(buf, offset);
}

describe("decodeProtocolConfig", () => {
  it("round-trips a fully-populated fixture", () => {
    const buf = Buffer.alloc(PROTOCOL_CONFIG_LEN);
    buf.writeUInt8(ACCOUNT_DISC_PROTOCOL_CONFIG, 0);
    writePubkey(buf, 8, fillKey(0x01));
    writePubkey(buf, 40, fillKey(0x02));
    writePubkey(buf, 72, fillKey(0x03));
    writePubkey(buf, 104, fillKey(0x04));
    buf.writeBigUInt64LE(100_000_000n, 136);
    buf.writeBigUInt64LE(1_500_000n, 144);
    buf.writeBigInt64LE(604_800n, 152);
    buf.writeBigInt64LE(86_400n, 160);
    buf.writeBigInt64LE(3600n, 168);
    buf.writeUInt16LE(1500, 176);
    buf.writeUInt16LE(25, 178);
    buf.writeUInt16LE(5, 180);
    buf.writeUInt16LE(3000, 182);
    buf.writeUInt8(10, 184);
    buf.writeUInt8(1, 185);
    buf.writeUInt8(255, 186);

    const cfg = decodeProtocolConfig(buf);
    expect(cfg.authority).toBe(fillKey(0x01).toBase58());
    expect(cfg.oracle).toBe(fillKey(0x02).toBase58());
    expect(cfg.treasury).toBe(fillKey(0x03).toBase58());
    expect(cfg.usdcMint).toBe(fillKey(0x04).toBase58());
    expect(cfg.minPoolDeposit).toBe(100_000_000n);
    expect(cfg.defaultMaxCoveragePerCall).toBe(1_500_000n);
    expect(cfg.withdrawalCooldownSeconds).toBe(604_800n);
    expect(cfg.aggregateCapWindowSeconds).toBe(86_400n);
    expect(cfg.claimWindowSeconds).toBe(3600n);
    expect(cfg.protocolFeeBps).toBe(1500);
    expect(cfg.defaultInsuranceRateBps).toBe(25);
    expect(cfg.minPremiumBps).toBe(5);
    expect(cfg.aggregateCapBps).toBe(3000);
    expect(cfg.maxClaimsPerBatch).toBe(10);
    expect(cfg.paused).toBe(1);
    expect(cfg.bump).toBe(255);
  });

  it("rejects wrong length", () => {
    expect(() => decodeProtocolConfig(Buffer.alloc(PROTOCOL_CONFIG_LEN - 1))).toThrow(
      /invalid length/
    );
  });

  it("rejects wrong discriminator", () => {
    const buf = Buffer.alloc(PROTOCOL_CONFIG_LEN);
    buf.writeUInt8(99, 0);
    expect(() => decodeProtocolConfig(buf)).toThrow(/invalid discriminator/);
  });
});

describe("decodeCoveragePool", () => {
  it("round-trips with hostname + vault_bump", () => {
    const buf = Buffer.alloc(COVERAGE_POOL_LEN);
    buf.writeUInt8(ACCOUNT_DISC_COVERAGE_POOL, 0);
    writePubkey(buf, 8, fillKey(0x11));
    writePubkey(buf, 40, fillKey(0x12));
    writePubkey(buf, 72, fillKey(0x13));

    const hostname = "api.openai.com";
    const hostnameBytes = Buffer.from(hostname, "utf8");
    hostnameBytes.copy(buf, 104);
    buf.writeUInt8(hostnameBytes.length, 248);

    buf.writeBigUInt64LE(1_000_000n, 168);
    buf.writeBigUInt64LE(900_000n, 176);
    buf.writeBigUInt64LE(50_000n, 184);
    buf.writeBigUInt64LE(25_000n, 192);
    buf.writeBigUInt64LE(2_000_000n, 200);
    buf.writeBigUInt64LE(7_500n, 208);
    buf.writeBigInt64LE(1_700_000_000n, 216);
    buf.writeBigInt64LE(1_699_900_000n, 224);
    buf.writeBigInt64LE(1_700_050_000n, 232);
    buf.writeUInt32LE(42, 240);
    buf.writeUInt16LE(100, 244);
    buf.writeUInt16LE(5, 246);
    buf.writeUInt8(254, 249);
    buf.writeUInt8(253, 250); // vault_bump

    const pool = decodeCoveragePool(buf);
    expect(pool.authority).toBe(fillKey(0x11).toBase58());
    expect(pool.usdcMint).toBe(fillKey(0x12).toBase58());
    expect(pool.vault).toBe(fillKey(0x13).toBase58());
    expect(pool.providerHostname).toBe(hostname);
    expect(pool.providerHostnameLen).toBe(hostname.length);
    expect(pool.totalDeposited).toBe(1_000_000n);
    expect(pool.totalAvailable).toBe(900_000n);
    expect(pool.totalPremiumsEarned).toBe(50_000n);
    expect(pool.totalClaimsPaid).toBe(25_000n);
    expect(pool.maxCoveragePerCall).toBe(2_000_000n);
    expect(pool.payoutsThisWindow).toBe(7_500n);
    expect(pool.windowStart).toBe(1_700_000_000n);
    expect(pool.createdAt).toBe(1_699_900_000n);
    expect(pool.updatedAt).toBe(1_700_050_000n);
    expect(pool.activePolicies).toBe(42);
    expect(pool.insuranceRateBps).toBe(100);
    expect(pool.minPremiumBps).toBe(5);
    expect(pool.bump).toBe(254);
    expect(pool.vaultBump).toBe(253);
  });

  it("rejects wrong discriminator", () => {
    const buf = Buffer.alloc(COVERAGE_POOL_LEN);
    buf.writeUInt8(0, 0);
    expect(() => decodeCoveragePool(buf)).toThrow(/invalid discriminator/);
  });
});

describe("decodeUnderwriterPosition", () => {
  it("round-trips a fully-populated fixture", () => {
    const buf = Buffer.alloc(UNDERWRITER_POSITION_LEN);
    buf.writeUInt8(ACCOUNT_DISC_UNDERWRITER_POSITION, 0);
    writePubkey(buf, 8, fillKey(0x21));
    writePubkey(buf, 40, fillKey(0x22));
    buf.writeBigUInt64LE(500_000n, 72);
    buf.writeBigUInt64LE(12_345n, 80);
    buf.writeBigUInt64LE(6_789n, 88);
    buf.writeBigInt64LE(1_700_000_000n, 96);
    buf.writeBigInt64LE(1_700_001_000n, 104);
    buf.writeUInt8(252, 112);

    const pos = decodeUnderwriterPosition(buf);
    expect(pos.pool).toBe(fillKey(0x21).toBase58());
    expect(pos.underwriter).toBe(fillKey(0x22).toBase58());
    expect(pos.deposited).toBe(500_000n);
    expect(pos.earnedPremiums).toBe(12_345n);
    expect(pos.lossesAbsorbed).toBe(6_789n);
    expect(pos.depositTimestamp).toBe(1_700_000_000n);
    expect(pos.lastClaimTimestamp).toBe(1_700_001_000n);
    expect(pos.bump).toBe(252);
  });
});

describe("decodePolicy", () => {
  function buildPolicy(opts: {
    referrerPresent: 0 | 1;
    referrer?: PublicKey;
    referrerShareBps?: number;
  }): Buffer {
    const buf = Buffer.alloc(POLICY_LEN);
    buf.writeUInt8(ACCOUNT_DISC_POLICY, 0);
    writePubkey(buf, 8, fillKey(0x31));
    writePubkey(buf, 40, fillKey(0x32));
    writePubkey(buf, 72, fillKey(0x33));
    const agentId = "agent-007";
    Buffer.from(agentId, "utf8").copy(buf, 104);
    buf.writeUInt8(agentId.length, 208);
    buf.writeBigUInt64LE(7_500n, 168);
    buf.writeBigUInt64LE(2_000n, 176);
    buf.writeBigUInt64LE(150n, 184);
    buf.writeBigInt64LE(1_700_000_000n, 192);
    buf.writeBigInt64LE(1_800_000_000n, 200);
    buf.writeUInt8(1, 209);
    buf.writeUInt8(251, 210);
    if (opts.referrer) writePubkey(buf, 216, opts.referrer);
    buf.writeUInt16LE(opts.referrerShareBps ?? 0, 248);
    buf.writeUInt8(opts.referrerPresent, 250);
    return buf;
  }

  it("round-trips with NO referrer (Phase-5 F1 absent)", () => {
    const buf = buildPolicy({ referrerPresent: 0 });
    const policy = decodePolicy(buf);
    expect(policy.agent).toBe(fillKey(0x31).toBase58());
    expect(policy.pool).toBe(fillKey(0x32).toBase58());
    expect(policy.agentTokenAccount).toBe(fillKey(0x33).toBase58());
    expect(policy.agentId).toBe("agent-007");
    expect(policy.agentIdLen).toBe(9);
    expect(policy.active).toBe(1);
    expect(policy.bump).toBe(251);
    expect(policy.referrer).toBeNull();
    expect(policy.referrerShareBps).toBe(0);
    expect(policy.referrerPresent).toBe(0);
    expect(policy.totalPremiumsPaid).toBe(7_500n);
    expect(policy.expiresAt).toBe(1_800_000_000n);
  });

  it("round-trips with a referrer present (Phase-5 F1)", () => {
    const referrer = fillKey(0xab);
    const buf = buildPolicy({
      referrerPresent: 1,
      referrer,
      referrerShareBps: 1500,
    });
    const policy = decodePolicy(buf);
    expect(policy.referrer).toBe(referrer.toBase58());
    expect(policy.referrerShareBps).toBe(1500);
    expect(policy.referrerPresent).toBe(1);
  });
});

describe("decodeClaim", () => {
  it("round-trips a fully-populated fixture", () => {
    const buf = Buffer.alloc(CLAIM_LEN);
    buf.writeUInt8(ACCOUNT_DISC_CLAIM, 0);
    writePubkey(buf, 8, fillKey(0x41));
    writePubkey(buf, 40, fillKey(0x42));
    writePubkey(buf, 72, fillKey(0x43));
    Buffer.alloc(32, 0x42).copy(buf, 104);
    Buffer.alloc(32, 0xee).copy(buf, 136);
    buf.writeBigUInt64LE(1_000_000n, 168);
    buf.writeBigUInt64LE(950_000n, 176);
    buf.writeBigInt64LE(1_700_000_000n, 184);
    buf.writeBigInt64LE(1_700_000_500n, 192);
    buf.writeBigInt64LE(1_700_001_000n, 200);
    buf.writeUInt32LE(1_200, 208);
    buf.writeUInt16LE(504, 212);
    buf.writeUInt8(TriggerType.LatencySla, 214);
    buf.writeUInt8(ClaimStatus.Approved, 215);
    buf.writeUInt8(250, 216);

    const claim = decodeClaim(buf);
    expect(claim.policy).toBe(fillKey(0x41).toBase58());
    expect(claim.pool).toBe(fillKey(0x42).toBase58());
    expect(claim.agent).toBe(fillKey(0x43).toBase58());
    expect(claim.callId.length).toBe(32);
    expect(claim.callId[0]).toBe(0x42);
    expect(claim.evidenceHash[31]).toBe(0xee);
    expect(claim.paymentAmount).toBe(1_000_000n);
    expect(claim.refundAmount).toBe(950_000n);
    expect(claim.callTimestamp).toBe(1_700_000_000n);
    expect(claim.latencyMs).toBe(1_200);
    expect(claim.statusCode).toBe(504);
    expect(claim.triggerType).toBe(TriggerType.LatencySla);
    expect(claim.status).toBe(ClaimStatus.Approved);
    expect(claim.bump).toBe(250);
  });

  it("rejects an out-of-range trigger_type byte", () => {
    const buf = Buffer.alloc(CLAIM_LEN);
    buf.writeUInt8(ACCOUNT_DISC_CLAIM, 0);
    buf.writeUInt8(7, 214); // invalid
    expect(() => decodeClaim(buf)).toThrow(/invalid trigger_type/);
  });

  it("rejects an out-of-range status byte", () => {
    const buf = Buffer.alloc(CLAIM_LEN);
    buf.writeUInt8(ACCOUNT_DISC_CLAIM, 0);
    buf.writeUInt8(0, 214);
    buf.writeUInt8(9, 215); // invalid
    expect(() => decodeClaim(buf)).toThrow(/invalid status/);
  });

  it("returns a freshly-allocated callId buffer (caller cannot mutate)", () => {
    const buf = Buffer.alloc(CLAIM_LEN);
    buf.writeUInt8(ACCOUNT_DISC_CLAIM, 0);
    Buffer.alloc(32, 0xff).copy(buf, 104);
    buf.writeUInt8(0, 214);
    buf.writeUInt8(0, 215);
    const claim = decodeClaim(buf);
    claim.callId[0] = 0; // mutating the decoded copy
    expect(buf[104]).toBe(0xff); // underlying buffer unaffected
  });
});
