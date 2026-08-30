/**
 * Instruction builder tests.
 *
 * Each test asserts (a) the discriminator byte, (b) the data byte layout
 * (snapshot of `ix.data.toString("hex")`), and (c) the account list
 * (program ID identity, isSigner / isWritable flags).
 *
 * Particular attention on `enable_insurance` — critique CRIT-1 confirmed
 * the on-chain decoder always reads a fixed 35-byte referrer tail, never
 * a Borsh Option. Both with-referrer and without-referrer branches are
 * exercised here.
 */
import { describe, expect, it } from "vitest";
import {
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
} from "@solana/web3.js";
import {
  PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  buildCreatePoolIx,
  buildDepositIx,
  buildDisablePolicyIx,
  buildEnableInsuranceIx,
  buildInitializeProtocolIx,
  buildSettlePremiumIx,
  buildSubmitClaimIx,
  buildUpdateConfigIx,
  buildUpdateOracleIx,
  buildUpdateRatesIx,
  buildWithdrawIx,
} from "../src/index.js";
import { TriggerType } from "../src/state.js";

const fillKey = (b: number) => new PublicKey(new Uint8Array(32).fill(b));
const hex = (buf: Buffer | Uint8Array) =>
  Buffer.from(buf).toString("hex");

describe("buildInitializeProtocolIx", () => {
  it("emits disc 0 + 128 bytes of 4 raw addresses (no Borsh framing)", () => {
    const ix = buildInitializeProtocolIx({
      programId: PROGRAM_ID,
      configPda: fillKey(0x10),
      deployer: fillKey(0x11),
      authority: fillKey(0xaa),
      oracle: fillKey(0xbb),
      treasury: fillKey(0xcc),
      usdcMint: fillKey(0xdd),
    });
    expect(ix.data[0]).toBe(0);
    expect(ix.data.length).toBe(1 + 128);
    expect(hex(ix.data.subarray(1, 33))).toBe("aa".repeat(32));
    expect(hex(ix.data.subarray(33, 65))).toBe("bb".repeat(32));
    expect(hex(ix.data.subarray(65, 97))).toBe("cc".repeat(32));
    expect(hex(ix.data.subarray(97, 129))).toBe("dd".repeat(32));

    expect(ix.keys.length).toBe(3);
    expect(ix.keys[0].pubkey.toBase58()).toBe(fillKey(0x10).toBase58());
    expect(ix.keys[0].isSigner).toBe(false);
    expect(ix.keys[0].isWritable).toBe(true);
    expect(ix.keys[1].pubkey.toBase58()).toBe(fillKey(0x11).toBase58());
    expect(ix.keys[1].isSigner).toBe(true);
    expect(ix.keys[1].isWritable).toBe(true);
    expect(ix.keys[2].pubkey.toBase58()).toBe(
      SystemProgram.programId.toBase58()
    );
  });
});

describe("buildUpdateConfigIx", () => {
  it("writes 13 Option tags with treasury+usdcMint frozen-to-None", () => {
    const ix = buildUpdateConfigIx({
      programId: PROGRAM_ID,
      configPda: fillKey(0x10),
      authority: fillKey(0x20),
      protocolFeeBps: 2000,
      paused: true,
    });
    // disc + 11 controllable options + 2 frozen Nones
    // protocol_fee_bps Some(2000)  → 01 d007
    // min_pool_deposit None        → 00
    // default_insurance_rate_bps None → 00
    // default_max_coverage_per_call None → 00
    // min_premium_bps None         → 00
    // withdrawal_cooldown_seconds None → 00
    // aggregate_cap_bps None       → 00
    // aggregate_cap_window_seconds None → 00
    // claim_window_seconds None    → 00
    // max_claims_per_batch None    → 00
    // paused Some(true)            → 01 01
    // treasury None                → 00 (frozen)
    // usdc_mint None               → 00 (frozen)
    // 9 single-byte None tags between protocol_fee_bps and paused
    expect(hex(ix.data)).toBe(
      "01" + "01d007" + "00".repeat(9) + "0101" + "00" + "00"
    );
    expect(ix.keys.length).toBe(2);
    expect(ix.keys[0].isWritable).toBe(true);
    expect(ix.keys[1].isSigner).toBe(true);
  });

  it("with no fields set, emits 13 None tags (11 + 2 frozen)", () => {
    const ix = buildUpdateConfigIx({
      programId: PROGRAM_ID,
      configPda: fillKey(0x10),
      authority: fillKey(0x20),
    });
    // 1 disc + 13 None tags = 14 bytes
    expect(ix.data.length).toBe(14);
    expect(ix.data[0]).toBe(1);
    for (let i = 1; i < 14; i++) expect(ix.data[i]).toBe(0);
  });
});

describe("buildUpdateOracleIx", () => {
  it("emits disc 2 + raw 32-byte new_oracle", () => {
    const ix = buildUpdateOracleIx({
      programId: PROGRAM_ID,
      configPda: fillKey(0x10),
      authority: fillKey(0x20),
      newOracle: fillKey(0xee),
    });
    expect(ix.data.length).toBe(33);
    expect(ix.data[0]).toBe(2);
    expect(hex(ix.data.subarray(1))).toBe("ee".repeat(32));
    expect(ix.keys[1].isSigner).toBe(true);
  });
});

describe("buildCreatePoolIx", () => {
  it("emits Borsh String hostname + Option<u16> + Option<u64>", () => {
    const ix = buildCreatePoolIx({
      programId: PROGRAM_ID,
      configPda: fillKey(0x10),
      poolPda: fillKey(0x11),
      vaultPda: fillKey(0x12),
      poolUsdcMint: fillKey(0x13),
      authority: fillKey(0x14),
      hostname: "api.openai.com",
      insuranceRateBps: 25,
      maxCoveragePerCall: 1_000_000n,
    });
    // disc 03 + len=14 (0e000000) + "api.openai.com" (hex) + 01 1900 (Some 25)
    // + 01 (Some) + 0x40420f0000000000 (1_000_000 LE)
    const hostnameHex = Buffer.from("api.openai.com", "utf8").toString("hex");
    expect(hex(ix.data)).toBe(
      "03" + "0e000000" + hostnameHex + "011900" + "0140420f0000000000"
    );
    expect(ix.keys.length).toBe(8);
    expect(ix.keys[7].pubkey.toBase58()).toBe(SYSVAR_RENT_PUBKEY.toBase58());
    expect(ix.keys[6].pubkey.toBase58()).toBe(TOKEN_PROGRAM_ID.toBase58());
  });

  it("rejects hostnames longer than 64 bytes", () => {
    expect(() =>
      buildCreatePoolIx({
        programId: PROGRAM_ID,
        configPda: fillKey(0x10),
        poolPda: fillKey(0x11),
        vaultPda: fillKey(0x12),
        poolUsdcMint: fillKey(0x13),
        authority: fillKey(0x14),
        hostname: "x".repeat(65),
      })
    ).toThrow(/hostname too long/);
  });
});

describe("buildDepositIx", () => {
  it("emits disc 4 + u64 amount", () => {
    const ix = buildDepositIx({
      programId: PROGRAM_ID,
      configPda: fillKey(0x10),
      poolPda: fillKey(0x11),
      vault: fillKey(0x12),
      positionPda: fillKey(0x13),
      underwriterTokenAccount: fillKey(0x14),
      underwriter: fillKey(0x15),
      amount: 1_000n,
    });
    expect(hex(ix.data)).toBe("04" + "e803000000000000");
    expect(ix.keys.length).toBe(8);
    expect(ix.keys[5].isSigner).toBe(true);
    expect(ix.keys[5].isWritable).toBe(true);
  });

  it("rejects zero amount", () => {
    expect(() =>
      buildDepositIx({
        programId: PROGRAM_ID,
        configPda: fillKey(0x10),
        poolPda: fillKey(0x11),
        vault: fillKey(0x12),
        positionPda: fillKey(0x13),
        underwriterTokenAccount: fillKey(0x14),
        underwriter: fillKey(0x15),
        amount: 0n,
      })
    ).toThrow(/> 0/);
  });
});

describe("buildEnableInsuranceIx (CRIT-1: fixed 35-byte referrer tail)", () => {
  it("emits 35 bytes of zero-fill referrer tail when referrer is absent", () => {
    const ix = buildEnableInsuranceIx({
      programId: PROGRAM_ID,
      configPda: fillKey(0x10),
      poolPda: fillKey(0x11),
      policyPda: fillKey(0x12),
      agentTokenAccount: fillKey(0x13),
      agent: fillKey(0x14),
      agentId: "agent-1",
      expiresAt: 1_900_000_000n,
    });
    // disc 05 + len=7 (07000000) + "agent-1" + i64 LE expires_at + zero tail
    const idHex = Buffer.from("agent-1", "utf8").toString("hex");
    const expiresHex = Buffer.alloc(8);
    expiresHex.writeBigInt64LE(1_900_000_000n);
    const tail = "00".repeat(32) + "00" + "0000";
    expect(hex(ix.data)).toBe(
      "05" + "07000000" + idHex + expiresHex.toString("hex") + tail
    );
    // verify length is exactly disc + len-prefix + id-bytes + 8 + 35
    expect(ix.data.length).toBe(1 + 4 + 7 + 8 + 35);
  });

  it("emits referrer destination + present=1 + share_bps when present", () => {
    const referrer = fillKey(0xab);
    const ix = buildEnableInsuranceIx({
      programId: PROGRAM_ID,
      configPda: fillKey(0x10),
      poolPda: fillKey(0x11),
      policyPda: fillKey(0x12),
      agentTokenAccount: fillKey(0x13),
      agent: fillKey(0x14),
      agentId: "agent-1",
      expiresAt: 1_900_000_000n,
      referrer: { destination: referrer, shareBps: 1500 },
    });
    const idHex = Buffer.from("agent-1", "utf8").toString("hex");
    const expiresHex = Buffer.alloc(8);
    expiresHex.writeBigInt64LE(1_900_000_000n);
    // referrer 32B + 01 present + dc05 (1500 LE)
    const tail = "ab".repeat(32) + "01" + "dc05";
    expect(hex(ix.data)).toBe(
      "05" + "07000000" + idHex + expiresHex.toString("hex") + tail
    );
  });

  it("rejects referrer.shareBps > MAX_REFERRER_SHARE_BPS (3000)", () => {
    expect(() =>
      buildEnableInsuranceIx({
        programId: PROGRAM_ID,
        configPda: fillKey(0x10),
        poolPda: fillKey(0x11),
        policyPda: fillKey(0x12),
        agentTokenAccount: fillKey(0x13),
        agent: fillKey(0x14),
        agentId: "x",
        expiresAt: 0n,
        referrer: { destination: fillKey(0xab), shareBps: 3001 },
      })
    ).toThrow(/out of range/);
  });

  it("rejects referrer.shareBps == 0 (use undefined to mean absent)", () => {
    expect(() =>
      buildEnableInsuranceIx({
        programId: PROGRAM_ID,
        configPda: fillKey(0x10),
        poolPda: fillKey(0x11),
        policyPda: fillKey(0x12),
        agentTokenAccount: fillKey(0x13),
        agent: fillKey(0x14),
        agentId: "x",
        expiresAt: 0n,
        referrer: { destination: fillKey(0xab), shareBps: 0 },
      })
    ).toThrow(/out of range/);
  });
});

describe("buildDisablePolicyIx", () => {
  it("emits a single discriminator byte with no payload", () => {
    const ix = buildDisablePolicyIx({
      programId: PROGRAM_ID,
      poolPda: fillKey(0x11),
      policyPda: fillKey(0x12),
      agent: fillKey(0x14),
    });
    expect(ix.data.length).toBe(1);
    expect(ix.data[0]).toBe(6);
    expect(ix.keys[0].isWritable).toBe(true);
    expect(ix.keys[1].isWritable).toBe(true);
    expect(ix.keys[2].isSigner).toBe(true);
    expect(ix.keys[2].isWritable).toBe(false);
  });
});

describe("buildSettlePremiumIx", () => {
  it("emits 8 base accounts when referrer is absent", () => {
    const ix = buildSettlePremiumIx({
      programId: PROGRAM_ID,
      configPda: fillKey(0x10),
      poolPda: fillKey(0x11),
      vault: fillKey(0x12),
      policyPda: fillKey(0x13),
      treasuryAta: fillKey(0x14),
      agentAta: fillKey(0x15),
      oracleSigner: fillKey(0x16),
      callValue: 500_000n,
    });
    expect(ix.data[0]).toBe(7);
    expect(ix.keys.length).toBe(8);
    expect(ix.keys[6].isSigner).toBe(true);
    expect(ix.keys[7].pubkey.toBase58()).toBe(TOKEN_PROGRAM_ID.toBase58());
  });

  it("appends referrerTokenAccount as a 9th account when provided", () => {
    const ix = buildSettlePremiumIx({
      programId: PROGRAM_ID,
      configPda: fillKey(0x10),
      poolPda: fillKey(0x11),
      vault: fillKey(0x12),
      policyPda: fillKey(0x13),
      treasuryAta: fillKey(0x14),
      agentAta: fillKey(0x15),
      oracleSigner: fillKey(0x16),
      callValue: 500_000n,
      referrerTokenAccount: fillKey(0xab),
    });
    expect(ix.keys.length).toBe(9);
    expect(ix.keys[8].pubkey.toBase58()).toBe(fillKey(0xab).toBase58());
    expect(ix.keys[8].isWritable).toBe(true);
  });
});

describe("buildWithdrawIx", () => {
  it("emits disc 8 + amount + the right account list (incl. clock sysvar)", () => {
    const ix = buildWithdrawIx({
      programId: PROGRAM_ID,
      configPda: fillKey(0x10),
      poolPda: fillKey(0x11),
      vault: fillKey(0x12),
      positionPda: fillKey(0x13),
      underwriterTokenAccount: fillKey(0x14),
      underwriter: fillKey(0x15),
      amount: 250n,
    });
    expect(ix.data[0]).toBe(8);
    expect(ix.keys.length).toBe(8);
    expect(ix.keys[5].isSigner).toBe(true);
    expect(ix.keys[5].isWritable).toBe(false);
    expect(ix.keys[7].pubkey.toBase58()).toBe(SYSVAR_CLOCK_PUBKEY.toBase58());
  });
});

describe("buildUpdateRatesIx", () => {
  it("emits disc 9 + u16 LE rate", () => {
    const ix = buildUpdateRatesIx({
      programId: PROGRAM_ID,
      configPda: fillKey(0x10),
      poolPda: fillKey(0x11),
      oracleSigner: fillKey(0x16),
      newRateBps: 50,
    });
    expect(hex(ix.data)).toBe("09" + "3200");
    expect(ix.keys[2].isSigner).toBe(true);
  });

  it("rejects rate > 10000", () => {
    expect(() =>
      buildUpdateRatesIx({
        programId: PROGRAM_ID,
        configPda: fillKey(0x10),
        poolPda: fillKey(0x11),
        oracleSigner: fillKey(0x16),
        newRateBps: 10_001,
      })
    ).toThrow(/out of range/);
  });
});

describe("buildSubmitClaimIx", () => {
  it("emits the full claim payload + 9-account list", () => {
    const ix = buildSubmitClaimIx({
      programId: PROGRAM_ID,
      configPda: fillKey(0x10),
      poolPda: fillKey(0x11),
      vault: fillKey(0x12),
      policyPda: fillKey(0x13),
      claimPda: fillKey(0x14),
      agentAta: fillKey(0x15),
      oracle: fillKey(0x16),
      callId: "call-1",
      triggerType: TriggerType.LatencySla,
      evidenceHash: new Uint8Array(32).fill(0xee),
      callTimestamp: 1_700_000_000n,
      latencyMs: 1_200,
      statusCode: 504,
      paymentAmount: 1_000n,
    });
    const callIdHex = Buffer.from("call-1", "utf8").toString("hex");
    const ts = Buffer.alloc(8);
    ts.writeBigInt64LE(1_700_000_000n);
    const expected =
      "0a" + // disc 10
      "06000000" + // call_id len
      callIdHex +
      "03" + // trigger_type LatencySla = 3
      "ee".repeat(32) + // evidence_hash
      ts.toString("hex") +
      "b0040000" + // latency_ms 1200 u32 LE
      "f801" + // status_code 504 u16 LE
      "e803000000000000"; // payment_amount 1000 u64 LE
    expect(hex(ix.data)).toBe(expected);
    expect(ix.keys.length).toBe(9);
    expect(ix.keys[6].isSigner).toBe(true);
    expect(ix.keys[6].isWritable).toBe(true);
  });

  it("rejects bad evidence hash length", () => {
    expect(() =>
      buildSubmitClaimIx({
        programId: PROGRAM_ID,
        configPda: fillKey(0x10),
        poolPda: fillKey(0x11),
        vault: fillKey(0x12),
        policyPda: fillKey(0x13),
        claimPda: fillKey(0x14),
        agentAta: fillKey(0x15),
        oracle: fillKey(0x16),
        callId: "x",
        triggerType: TriggerType.Timeout,
        evidenceHash: new Uint8Array(31),
        callTimestamp: 0n,
        latencyMs: 0,
        statusCode: 0,
        paymentAmount: 1n,
      })
    ).toThrow(/32 bytes/);
  });

  it("rejects callId > MAX_CALL_ID_LEN", () => {
    expect(() =>
      buildSubmitClaimIx({
        programId: PROGRAM_ID,
        configPda: fillKey(0x10),
        poolPda: fillKey(0x11),
        vault: fillKey(0x12),
        policyPda: fillKey(0x13),
        claimPda: fillKey(0x14),
        agentAta: fillKey(0x15),
        oracle: fillKey(0x16),
        callId: "x".repeat(65),
        triggerType: TriggerType.Timeout,
        evidenceHash: new Uint8Array(32),
        callTimestamp: 0n,
        latencyMs: 0,
        statusCode: 0,
        paymentAmount: 1n,
      })
    ).toThrow(/callId too long/);
  });
});
