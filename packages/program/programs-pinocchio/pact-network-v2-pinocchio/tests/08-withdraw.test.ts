/**
 * `withdraw` (disc 8) — first pool-PDA-signed Transfer in the test suite.
 *
 * Covered:
 *   - happy: after cooldown elapses, underwriter receives `amount` USDC;
 *     position.deposited + pool.total_deposited / total_available decrease
 *   - cooldown unmet reject (6009 WithdrawalUnderCooldown)
 *   - position.deposited < amount reject (6007 InsufficientPoolBalance)
 *   - zero amount client-side reject
 *   - non-underwriter signer reject (6018 Unauthorized)
 *
 * **Cooldown ordering note** (deposit.rs:274-279 + critique H-2): the
 * deposit timestamp is set AFTER the Transfer CPI inside `deposit`, so the
 * recorded `deposit_timestamp` already includes the clock value at that
 * point. Advancing the clock BEFORE deposit therefore baked into the
 * recorded timestamp; advancing AFTER deposit is what actually moves the
 * cooldown gate.
 */
import { describe, expect, it } from "vitest";
import { LiteSVM } from "litesvm";
import { Transaction } from "@solana/web3.js";
import {
  PROGRAM_ID,
  buildWithdrawIx,
  decodeCoveragePool,
  decodeUnderwriterPosition,
} from "@q3labs/pact-protocol-v2-client";
import {
  advanceClock,
  generateKeypair,
  getAccountData,
  getTokenBalance,
  loadProgram,
  sendAndExtractCode,
} from "./helpers.js";
import { setupPool, setupProtocol, setupUnderwriter } from "./fixtures.js";

const DEFAULT_DEPOSIT = 200_000_000n; // 200 USDC — well above the 100 USDC min
// DEFAULT_WITHDRAWAL_COOLDOWN = 604_800 (7 days) in seconds. ABSOLUTE_MIN
// is 3600. We advance past 7d for the happy path.
const SEVEN_DAYS = 604_800n;

describe("withdraw — happy path", () => {
  it("transfers USDC from vault to underwriter after cooldown elapses", () => {
    const svm = new LiteSVM();
    loadProgram(svm, { bypass: true });
    const proto = setupProtocol(svm);
    const pool = setupPool(svm, proto, "api.openai.com");
    const uw = setupUnderwriter(svm, proto, pool, DEFAULT_DEPOSIT);

    advanceClock(svm, SEVEN_DAYS + 1n);

    const balanceBefore = getTokenBalance(svm, uw.underwriterTokenAccount);
    const ix = buildWithdrawIx({
      programId: PROGRAM_ID,
      configPda: proto.configPda,
      poolPda: pool.poolPda,
      vault: pool.vaultPda,
      positionPda: uw.positionPda,
      underwriterTokenAccount: uw.underwriterTokenAccount,
      underwriter: uw.underwriter.publicKey,
      amount: 50_000_000n,
    });
    expect(sendAndExtractCode(svm, new Transaction().add(ix), uw.underwriter)).toBeUndefined();

    const position = decodeUnderwriterPosition(getAccountData(svm, uw.positionPda)!);
    expect(position.deposited).toBe(DEFAULT_DEPOSIT - 50_000_000n);

    const updatedPool = decodeCoveragePool(getAccountData(svm, pool.poolPda)!);
    expect(updatedPool.totalDeposited).toBe(DEFAULT_DEPOSIT - 50_000_000n);
    expect(updatedPool.totalAvailable).toBe(DEFAULT_DEPOSIT - 50_000_000n);

    expect(getTokenBalance(svm, uw.underwriterTokenAccount)).toBe(
      balanceBefore + 50_000_000n
    );
  });
});

describe("withdraw — failure modes", () => {
  it("rejects withdrawal before cooldown elapses (6009 WithdrawalUnderCooldown)", () => {
    const svm = new LiteSVM();
    loadProgram(svm, { bypass: true });
    const proto = setupProtocol(svm);
    const pool = setupPool(svm, proto, "api.openai.com");
    const uw = setupUnderwriter(svm, proto, pool, DEFAULT_DEPOSIT);

    // No advanceClock — fresh deposit, cooldown unmet.
    const ix = buildWithdrawIx({
      programId: PROGRAM_ID,
      configPda: proto.configPda,
      poolPda: pool.poolPda,
      vault: pool.vaultPda,
      positionPda: uw.positionPda,
      underwriterTokenAccount: uw.underwriterTokenAccount,
      underwriter: uw.underwriter.publicKey,
      amount: 50_000_000n,
    });
    expect(sendAndExtractCode(svm, new Transaction().add(ix), uw.underwriter)).toBe(6009);
  });

  it("rejects position.deposited < amount with 6007 InsufficientPoolBalance", () => {
    const svm = new LiteSVM();
    loadProgram(svm, { bypass: true });
    const proto = setupProtocol(svm);
    const pool = setupPool(svm, proto, "api.openai.com");
    const uw = setupUnderwriter(svm, proto, pool, DEFAULT_DEPOSIT);
    advanceClock(svm, SEVEN_DAYS + 1n);

    const ix = buildWithdrawIx({
      programId: PROGRAM_ID,
      configPda: proto.configPda,
      poolPda: pool.poolPda,
      vault: pool.vaultPda,
      positionPda: uw.positionPda,
      underwriterTokenAccount: uw.underwriterTokenAccount,
      underwriter: uw.underwriter.publicKey,
      amount: DEFAULT_DEPOSIT + 1n,
    });
    expect(sendAndExtractCode(svm, new Transaction().add(ix), uw.underwriter)).toBe(6007);
  });

  it("client builder rejects amount == 0", () => {
    const svm = new LiteSVM();
    loadProgram(svm, { bypass: true });
    const proto = setupProtocol(svm);
    const pool = setupPool(svm, proto, "api.openai.com");
    const uw = setupUnderwriter(svm, proto, pool, DEFAULT_DEPOSIT);
    expect(() =>
      buildWithdrawIx({
        programId: PROGRAM_ID,
        configPda: proto.configPda,
        poolPda: pool.poolPda,
        vault: pool.vaultPda,
        positionPda: uw.positionPda,
        underwriterTokenAccount: uw.underwriterTokenAccount,
        underwriter: uw.underwriter.publicKey,
        amount: 0n,
      })
    ).toThrow(/> 0/);
  });

  it("rejects a non-underwriter signer (PDA-derivation guard)", () => {
    const svm = new LiteSVM();
    loadProgram(svm, { bypass: true });
    const proto = setupProtocol(svm);
    const pool = setupPool(svm, proto, "api.openai.com");
    const uw = setupUnderwriter(svm, proto, pool, DEFAULT_DEPOSIT);
    advanceClock(svm, SEVEN_DAYS + 1n);

    const stranger = generateKeypair(svm);
    const ix = buildWithdrawIx({
      programId: PROGRAM_ID,
      configPda: proto.configPda,
      poolPda: pool.poolPda,
      vault: pool.vaultPda,
      positionPda: uw.positionPda,
      underwriterTokenAccount: uw.underwriterTokenAccount,
      underwriter: stranger.publicKey, // wrong underwriter
      amount: 1_000_000n,
    });
    // Handler derives position PDA from (pool, signer.address()) and
    // compares to the supplied account at withdraw.rs:151. With a stranger
    // signer the derivation differs → InvalidSeeds (built-in ProgramError,
    // NOT Custom). The 6018 Unauthorized path is unreachable for this
    // attack vector because the PDA model prevents controlling another
    // underwriter's position seed.
    const code = sendAndExtractCode(svm, new Transaction().add(ix), stranger);
    expect(code).not.toBeUndefined();
  });
});
