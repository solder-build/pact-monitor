/**
 * `update_config` (disc 1) — partial-update on ProtocolConfig.
 *
 * Covered:
 *   - happy: protocol_fee_bps mutates
 *   - happy: paused=true sets the kill switch
 *   - safety floors:
 *       protocol_fee_bps > ABSOLUTE_MAX_PROTOCOL_FEE_BPS (3000)  → 6022
 *       min_pool_deposit < ABSOLUTE_MIN_POOL_DEPOSIT (1_000_000) → 6022
 *       withdrawal_cooldown_seconds < ABSOLUTE_MIN_WITHDRAWAL_COOLDOWN (3600) → 6022
 *       aggregate_cap_bps > ABSOLUTE_MAX_AGGREGATE_CAP_BPS (8000) → 6022
 *       claim_window_seconds < ABSOLUTE_MIN_CLAIM_WINDOW (60) → 6022
 *   - non-authority reject (6018)
 *   - frozen-field reject (treasury / usdc_mint Some) requires bypassing the
 *     client (which OMITS those fields from the param type per HIGH-4) —
 *     deferred to a hand-rolled-bytes follow-up.
 */
import { describe, expect, it } from "vitest";
import { LiteSVM } from "litesvm";
import { Transaction } from "@solana/web3.js";
import {
  PROGRAM_ID,
  buildUpdateConfigIx,
  decodeProtocolConfig,
} from "@q3labs/pact-protocol-v2-client";
import {
  airdrop,
  generateKeypair,
  getAccountData,
  loadProgram,
  sendAndExtractCode,
} from "./helpers.js";
import { setupProtocol } from "./fixtures.js";

describe("update_config — happy path", () => {
  it("mutates protocol_fee_bps when within cap", () => {
    const svm = new LiteSVM();
    loadProgram(svm, { bypass: true });
    const proto = setupProtocol(svm);

    const ix = buildUpdateConfigIx({
      programId: PROGRAM_ID,
      configPda: proto.configPda,
      authority: proto.authority.publicKey,
      protocolFeeBps: 2500,
    });
    expect(sendAndExtractCode(svm, new Transaction().add(ix), proto.authority)).toBeUndefined();
    const cfg = decodeProtocolConfig(getAccountData(svm, proto.configPda)!);
    expect(cfg.protocolFeeBps).toBe(2500);
  });

  it("sets paused = 1 when toggled", () => {
    const svm = new LiteSVM();
    loadProgram(svm, { bypass: true });
    const proto = setupProtocol(svm);

    const ix = buildUpdateConfigIx({
      programId: PROGRAM_ID,
      configPda: proto.configPda,
      authority: proto.authority.publicKey,
      paused: true,
    });
    expect(sendAndExtractCode(svm, new Transaction().add(ix), proto.authority)).toBeUndefined();
    expect(
      decodeProtocolConfig(getAccountData(svm, proto.configPda)!).paused
    ).toBe(1);
  });

  it("leaves untouched fields unchanged when only one option is Some", () => {
    const svm = new LiteSVM();
    loadProgram(svm, { bypass: true });
    const proto = setupProtocol(svm);
    const before = decodeProtocolConfig(getAccountData(svm, proto.configPda)!);

    const ix = buildUpdateConfigIx({
      programId: PROGRAM_ID,
      configPda: proto.configPda,
      authority: proto.authority.publicKey,
      defaultInsuranceRateBps: 100,
    });
    expect(sendAndExtractCode(svm, new Transaction().add(ix), proto.authority)).toBeUndefined();

    const after = decodeProtocolConfig(getAccountData(svm, proto.configPda)!);
    expect(after.defaultInsuranceRateBps).toBe(100);
    expect(after.protocolFeeBps).toBe(before.protocolFeeBps);
    expect(after.minPoolDeposit).toBe(before.minPoolDeposit);
    expect(after.minPremiumBps).toBe(before.minPremiumBps);
    expect(after.aggregateCapBps).toBe(before.aggregateCapBps);
  });
});

describe("update_config — safety floors (6022 ConfigSafetyFloorViolation)", () => {
  it("rejects protocol_fee_bps > 3000", () => {
    const svm = new LiteSVM();
    loadProgram(svm, { bypass: true });
    const proto = setupProtocol(svm);
    const ix = buildUpdateConfigIx({
      programId: PROGRAM_ID,
      configPda: proto.configPda,
      authority: proto.authority.publicKey,
      protocolFeeBps: 3001,
    });
    expect(sendAndExtractCode(svm, new Transaction().add(ix), proto.authority)).toBe(6022);
  });

  it("rejects min_pool_deposit < 1_000_000", () => {
    const svm = new LiteSVM();
    loadProgram(svm, { bypass: true });
    const proto = setupProtocol(svm);
    const ix = buildUpdateConfigIx({
      programId: PROGRAM_ID,
      configPda: proto.configPda,
      authority: proto.authority.publicKey,
      minPoolDeposit: 999_999n,
    });
    expect(sendAndExtractCode(svm, new Transaction().add(ix), proto.authority)).toBe(6022);
  });

  it("rejects withdrawal_cooldown_seconds < 3600", () => {
    const svm = new LiteSVM();
    loadProgram(svm, { bypass: true });
    const proto = setupProtocol(svm);
    const ix = buildUpdateConfigIx({
      programId: PROGRAM_ID,
      configPda: proto.configPda,
      authority: proto.authority.publicKey,
      withdrawalCooldownSeconds: 3599n,
    });
    expect(sendAndExtractCode(svm, new Transaction().add(ix), proto.authority)).toBe(6022);
  });

  it("rejects aggregate_cap_bps > 8000", () => {
    const svm = new LiteSVM();
    loadProgram(svm, { bypass: true });
    const proto = setupProtocol(svm);
    const ix = buildUpdateConfigIx({
      programId: PROGRAM_ID,
      configPda: proto.configPda,
      authority: proto.authority.publicKey,
      aggregateCapBps: 8001,
    });
    expect(sendAndExtractCode(svm, new Transaction().add(ix), proto.authority)).toBe(6022);
  });

  it("rejects claim_window_seconds < 60", () => {
    const svm = new LiteSVM();
    loadProgram(svm, { bypass: true });
    const proto = setupProtocol(svm);
    const ix = buildUpdateConfigIx({
      programId: PROGRAM_ID,
      configPda: proto.configPda,
      authority: proto.authority.publicKey,
      claimWindowSeconds: 59n,
    });
    expect(sendAndExtractCode(svm, new Transaction().add(ix), proto.authority)).toBe(6022);
  });
});

describe("update_config — authority gate", () => {
  it("rejects a non-authority signer with 6018 Unauthorized", () => {
    const svm = new LiteSVM();
    loadProgram(svm, { bypass: true });
    const proto = setupProtocol(svm);
    const stranger = generateKeypair(svm);
    airdrop(svm, stranger.publicKey);

    const ix = buildUpdateConfigIx({
      programId: PROGRAM_ID,
      configPda: proto.configPda,
      authority: stranger.publicKey,
      protocolFeeBps: 1000,
    });
    expect(sendAndExtractCode(svm, new Transaction().add(ix), stranger)).toBe(6018);
  });
});

// Frozen-field rejection (treasury / usdc_mint Some → 6026) is enforced
// on chain but requires a hand-rolled payload because the client builder
// type (per critique HIGH-4) omits both fields entirely. The TS-level
// invariant is tested by @q3labs/pact-protocol-v2-client's own
// instructions.test.ts; the on-chain 6026 path is deferred to a follow-up
// raw-bytes shim (out of scope here).
