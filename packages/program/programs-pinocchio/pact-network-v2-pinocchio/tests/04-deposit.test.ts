/**
 * `deposit` (disc 4) — underwriter-signed Transfer to pool vault.
 *
 * Covered:
 *   - happy: init path creates the position; counters set
 *   - happy: re-open path preserves earned_premiums + losses_absorbed
 *   - cooldown reset on EVERY deposit (Alan #5) — deposit_timestamp
 *     advances on a second deposit even when re-opening
 *   - amount < config.min_pool_deposit reject (6021 BelowMinimumDeposit)
 *   - amount == 0 reject (client throws; chain returns 6020)
 *   - pool counter math: pool.total_deposited / total_available bumped
 */
import { describe, expect, it } from "vitest";
import { LiteSVM } from "litesvm";
import { Transaction } from "@solana/web3.js";
import {
  PROGRAM_ID,
  buildDepositIx,
  decodeCoveragePool,
  decodeUnderwriterPosition,
  getUnderwriterPositionPda,
} from "@q3labs/pact-protocol-v2-client";
import {
  advanceClock,
  createTokenAccount,
  generateKeypair,
  getAccountData,
  getTokenBalance,
  loadProgram,
  mintTokensToAccount,
  sendAndExtractCode,
} from "./helpers.js";
import { setupPool, setupProtocol } from "./fixtures.js";

describe("deposit — init path", () => {
  it("creates UnderwriterPosition + bumps pool counters", () => {
    const svm = new LiteSVM();
    loadProgram(svm, { bypass: true });
    const proto = setupProtocol(svm);
    const pool = setupPool(svm, proto, "api.openai.com");

    const underwriter = generateKeypair(svm);
    const ta = createTokenAccount(svm, proto.mint, underwriter.publicKey);
    // DEFAULT_MIN_POOL_DEPOSIT = 100_000_000 — deposits must be >= 100 USDC.
    mintTokensToAccount(svm, ta, 300_000_000n);

    const [positionPda] = getUnderwriterPositionPda(
      PROGRAM_ID,
      pool.poolPda,
      underwriter.publicKey
    );

    const ix = buildDepositIx({
      programId: PROGRAM_ID,
      configPda: proto.configPda,
      poolPda: pool.poolPda,
      vault: pool.vaultPda,
      positionPda,
      underwriterTokenAccount: ta,
      underwriter: underwriter.publicKey,
      amount: 100_000_000n,
    });
    expect(sendAndExtractCode(svm, new Transaction().add(ix), underwriter)).toBeUndefined();

    const position = decodeUnderwriterPosition(getAccountData(svm, positionPda)!);
    expect(position.deposited).toBe(100_000_000n);
    expect(position.earnedPremiums).toBe(0n);
    expect(position.lossesAbsorbed).toBe(0n);

    const updatedPool = decodeCoveragePool(getAccountData(svm, pool.poolPda)!);
    expect(updatedPool.totalDeposited).toBe(100_000_000n);
    expect(updatedPool.totalAvailable).toBe(100_000_000n);
    expect(getTokenBalance(svm, pool.vaultPda)).toBe(100_000_000n);
    expect(getTokenBalance(svm, ta)).toBe(200_000_000n);
  });
});

describe("deposit — re-open path (Alan #5: cooldown resets on every deposit)", () => {
  it("advances deposit_timestamp on a second deposit and preserves counters", () => {
    const svm = new LiteSVM();
    loadProgram(svm, { bypass: true });
    const proto = setupProtocol(svm);
    const pool = setupPool(svm, proto, "api.openai.com");

    const underwriter = generateKeypair(svm);
    const ta = createTokenAccount(svm, proto.mint, underwriter.publicKey);
    mintTokensToAccount(svm, ta, 500_000_000n);

    const [positionPda] = getUnderwriterPositionPda(
      PROGRAM_ID,
      pool.poolPda,
      underwriter.publicKey
    );
    const ix = (amount: bigint) =>
      buildDepositIx({
        programId: PROGRAM_ID,
        configPda: proto.configPda,
        poolPda: pool.poolPda,
        vault: pool.vaultPda,
        positionPda,
        underwriterTokenAccount: ta,
        underwriter: underwriter.publicKey,
        amount,
      });

    // Both deposits must be >= DEFAULT_MIN_POOL_DEPOSIT (100M).
    expect(sendAndExtractCode(svm, new Transaction().add(ix(150_000_000n)), underwriter)).toBeUndefined();
    const before = decodeUnderwriterPosition(getAccountData(svm, positionPda)!);

    // Advance clock — deposit reads Clock AFTER the Transfer CPI (deposit.rs
    // ordering trap), so calling advanceClock between deposits bumps the
    // recorded timestamp for the second deposit.
    advanceClock(svm, 7200n); // +2h

    expect(sendAndExtractCode(svm, new Transaction().add(ix(120_000_000n)), underwriter)).toBeUndefined();
    const after = decodeUnderwriterPosition(getAccountData(svm, positionPda)!);

    expect(after.deposited).toBe(270_000_000n);
    expect(after.earnedPremiums).toBe(before.earnedPremiums);
    expect(after.lossesAbsorbed).toBe(before.lossesAbsorbed);
    expect(after.depositTimestamp).toBeGreaterThan(before.depositTimestamp);
  });
});

describe("deposit — failure modes", () => {
  it("rejects amount < config.min_pool_deposit with 6021 BelowMinimumDeposit", () => {
    const svm = new LiteSVM();
    loadProgram(svm, { bypass: true });
    const proto = setupProtocol(svm);
    const pool = setupPool(svm, proto, "api.openai.com");

    const underwriter = generateKeypair(svm);
    const ta = createTokenAccount(svm, proto.mint, underwriter.publicKey);
    mintTokensToAccount(svm, ta, 50_000_000n);

    const [positionPda] = getUnderwriterPositionPda(
      PROGRAM_ID,
      pool.poolPda,
      underwriter.publicKey
    );
    // DEFAULT_MIN_POOL_DEPOSIT = 100_000_000 (100 USDC). Send 50 USDC.
    const ix = buildDepositIx({
      programId: PROGRAM_ID,
      configPda: proto.configPda,
      poolPda: pool.poolPda,
      vault: pool.vaultPda,
      positionPda,
      underwriterTokenAccount: ta,
      underwriter: underwriter.publicKey,
      amount: 50_000_000n,
    });
    expect(sendAndExtractCode(svm, new Transaction().add(ix), underwriter)).toBe(6021);
  });

  it("client builder rejects amount == 0 before tx submit", () => {
    const svm = new LiteSVM();
    loadProgram(svm, { bypass: true });
    const proto = setupProtocol(svm);
    const pool = setupPool(svm, proto, "api.openai.com");
    const underwriter = generateKeypair(svm);
    const ta = createTokenAccount(svm, proto.mint, underwriter.publicKey);
    const [positionPda] = getUnderwriterPositionPda(
      PROGRAM_ID,
      pool.poolPda,
      underwriter.publicKey
    );
    expect(() =>
      buildDepositIx({
        programId: PROGRAM_ID,
        configPda: proto.configPda,
        poolPda: pool.poolPda,
        vault: pool.vaultPda,
        positionPda,
        underwriterTokenAccount: ta,
        underwriter: underwriter.publicKey,
        amount: 0n,
      })
    ).toThrow(/> 0/);
  });
});
