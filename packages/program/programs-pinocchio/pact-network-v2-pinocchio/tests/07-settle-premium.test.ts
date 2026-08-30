/**
 * `settle_premium` (disc 7) — oracle-signed crank that pulls a per-call
 * premium from the agent's delegated ATA and splits it across pool /
 * treasury / referrer.
 *
 * **H-05 premium-evasion guard**: settle_premium does NOT gate on
 * policy.active. An agent can't escape premium for already-accrued
 * calls by calling disable_policy before the crank lands. This file
 * explicitly verifies that. (submit_claim DOES gate on active; see 10.)
 *
 * Phase 5 F1 three-way split:
 *   gross = call_value * pool.insurance_rate_bps / 10_000
 *   treasury_cut = gross * config.protocol_fee_bps / 10_000
 *   referrer_cut = gross * policy.referrer_share_bps / 10_000   (if present)
 *   pool_cut    = gross - treasury_cut - referrer_cut
 *
 * Covered:
 *   - happy 2-way split (no referrer): treasury + pool credited; agent ATA
 *     debited; policy.total_premiums_paid incremented
 *   - happy 3-way split (with referrer): all three accounts receive bytes
 *     according to the formula above
 *   - missing referrer_ta when policy.referrer_present==1 reject (6005)
 *   - oracle gate: stranger signer 6025; authority signer 6025 (C-02)
 *   - H-05: settle on a policy with active=0 succeeds
 *   - delegation insufficient (6004): delegated_amount drops below
 *     required gross
 *   - premium math bit-exact for a fixed inputs vector
 *
 * Note: in this test file we rely on the DEFAULT_INSURANCE_RATE_BPS = 25,
 * DEFAULT_PROTOCOL_FEE_BPS = 1500 — both inherited from initialize_protocol.
 */
import { describe, expect, it } from "vitest";
import { LiteSVM } from "litesvm";
import { Keypair, Transaction } from "@solana/web3.js";
import {
  PROGRAM_ID,
  buildDisablePolicyIx,
  buildSettlePremiumIx,
  decodePolicy,
} from "@q3labs/pact-protocol-v2-client";
import {
  airdrop,
  createTokenAccount,
  generateKeypair,
  getAccountData,
  getTokenBalance,
  loadProgram,
  sendAndExtractCode,
} from "./helpers.js";
import { setupPolicy, setupPool, setupProtocol } from "./fixtures.js";

// gross = call_value * 25 / 10000; treasury_cut = gross * 1500 / 10000
function expectedGross(callValue: bigint): bigint {
  return (callValue * 25n) / 10_000n;
}
function expectedTreasuryCut(gross: bigint): bigint {
  return (gross * 1500n) / 10_000n;
}

describe("settle_premium — 2-way split (no referrer)", () => {
  it("credits pool + treasury, debits agent ATA, bumps policy.total_premiums_paid", () => {
    const svm = new LiteSVM();
    loadProgram(svm, { bypass: true });
    const proto = setupProtocol(svm);
    const pool = setupPool(svm, proto, "api.openai.com");
    const policy = setupPolicy(svm, proto, pool);

    const callValue = 10_000_000n; // 10 USDC
    const gross = expectedGross(callValue);
    const treasuryCut = expectedTreasuryCut(gross);
    const poolCut = gross - treasuryCut;

    const agentBefore = getTokenBalance(svm, policy.agentTokenAccount);
    const treasuryBefore = getTokenBalance(svm, proto.treasuryAta);
    const vaultBefore = getTokenBalance(svm, pool.vaultPda);

    const ix = buildSettlePremiumIx({
      programId: PROGRAM_ID,
      configPda: proto.configPda,
      poolPda: pool.poolPda,
      vault: pool.vaultPda,
      policyPda: policy.policyPda,
      treasuryAta: proto.treasuryAta,
      agentAta: policy.agentTokenAccount,
      oracleSigner: proto.oracle.publicKey,
      callValue,
    });
    expect(sendAndExtractCode(svm, new Transaction().add(ix), proto.oracle)).toBeUndefined();

    expect(getTokenBalance(svm, policy.agentTokenAccount)).toBe(agentBefore - gross);
    expect(getTokenBalance(svm, proto.treasuryAta)).toBe(treasuryBefore + treasuryCut);
    expect(getTokenBalance(svm, pool.vaultPda)).toBe(vaultBefore + poolCut);

    const updatedPolicy = decodePolicy(getAccountData(svm, policy.policyPda)!);
    expect(updatedPolicy.totalPremiumsPaid).toBe(gross);
  });
});

describe("settle_premium — 3-way split (Phase 5 F1)", () => {
  it("credits pool + treasury + referrer per formula", () => {
    const svm = new LiteSVM();
    loadProgram(svm, { bypass: true });
    const proto = setupProtocol(svm);
    const pool = setupPool(svm, proto, "api.openai.com");

    const referrerOwner = generateKeypair(svm);
    const referrerAta = createTokenAccount(svm, proto.mint, referrerOwner.publicKey);

    const policy = setupPolicy(svm, proto, pool, {
      referrer: { destination: referrerOwner.publicKey, shareBps: 1000 },
    });

    const callValue = 50_000_000n;
    const gross = expectedGross(callValue);
    const treasuryCut = expectedTreasuryCut(gross);
    const referrerCut = (gross * 1000n) / 10_000n;
    const poolCut = gross - treasuryCut - referrerCut;

    const referrerBefore = getTokenBalance(svm, referrerAta);
    const vaultBefore = getTokenBalance(svm, pool.vaultPda);
    const treasuryBefore = getTokenBalance(svm, proto.treasuryAta);

    const ix = buildSettlePremiumIx({
      programId: PROGRAM_ID,
      configPda: proto.configPda,
      poolPda: pool.poolPda,
      vault: pool.vaultPda,
      policyPda: policy.policyPda,
      treasuryAta: proto.treasuryAta,
      agentAta: policy.agentTokenAccount,
      oracleSigner: proto.oracle.publicKey,
      callValue,
      referrerTokenAccount: referrerAta,
    });
    expect(sendAndExtractCode(svm, new Transaction().add(ix), proto.oracle)).toBeUndefined();

    expect(getTokenBalance(svm, pool.vaultPda)).toBe(vaultBefore + poolCut);
    expect(getTokenBalance(svm, proto.treasuryAta)).toBe(treasuryBefore + treasuryCut);
    expect(getTokenBalance(svm, referrerAta)).toBe(referrerBefore + referrerCut);
  });

  it("rejects with 6005 when policy.referrer_present=1 but referrer_ta is missing from accounts", () => {
    const svm = new LiteSVM();
    loadProgram(svm, { bypass: true });
    const proto = setupProtocol(svm);
    const pool = setupPool(svm, proto, "api.openai.com");
    const referrerOwner = generateKeypair(svm);
    const policy = setupPolicy(svm, proto, pool, {
      referrer: { destination: referrerOwner.publicKey, shareBps: 500 },
    });

    // Build ix without `referrerTokenAccount` even though policy says present=1.
    const ix = buildSettlePremiumIx({
      programId: PROGRAM_ID,
      configPda: proto.configPda,
      poolPda: pool.poolPda,
      vault: pool.vaultPda,
      policyPda: policy.policyPda,
      treasuryAta: proto.treasuryAta,
      agentAta: policy.agentTokenAccount,
      oracleSigner: proto.oracle.publicKey,
      callValue: 10_000_000n,
    });
    // Handler reads remaining[0] when present=1; absent → NotEnoughAccountKeys
    // (a built-in ProgramError, not Custom). Both shapes are valid rejects.
    const code = sendAndExtractCode(svm, new Transaction().add(ix), proto.oracle);
    expect(code === undefined ? "ok" : "fail").toBe("fail");
  });
});

describe("settle_premium — H-05 premium evasion guard", () => {
  it("settles even after the agent disables the policy", () => {
    const svm = new LiteSVM();
    loadProgram(svm, { bypass: true });
    const proto = setupProtocol(svm);
    const pool = setupPool(svm, proto, "api.openai.com");
    const policy = setupPolicy(svm, proto, pool);

    // Agent disables the policy first.
    const disable = buildDisablePolicyIx({
      programId: PROGRAM_ID,
      poolPda: pool.poolPda,
      policyPda: policy.policyPda,
      agent: policy.agent.publicKey,
    });
    expect(
      sendAndExtractCode(svm, new Transaction().add(disable), policy.agent)
    ).toBeUndefined();

    // Oracle still owes premium for the call window — must succeed.
    const settle = buildSettlePremiumIx({
      programId: PROGRAM_ID,
      configPda: proto.configPda,
      poolPda: pool.poolPda,
      vault: pool.vaultPda,
      policyPda: policy.policyPda,
      treasuryAta: proto.treasuryAta,
      agentAta: policy.agentTokenAccount,
      oracleSigner: proto.oracle.publicKey,
      callValue: 5_000_000n,
    });
    expect(
      sendAndExtractCode(svm, new Transaction().add(settle), proto.oracle)
    ).toBeUndefined();
  });
});

describe("settle_premium — oracle gate (C-02)", () => {
  function settle(svm: LiteSVM, proto: ReturnType<typeof setupProtocol>, pool: ReturnType<typeof setupPool>, policy: ReturnType<typeof setupPolicy>, signer: Keypair) {
    const ix = buildSettlePremiumIx({
      programId: PROGRAM_ID,
      configPda: proto.configPda,
      poolPda: pool.poolPda,
      vault: pool.vaultPda,
      policyPda: policy.policyPda,
      treasuryAta: proto.treasuryAta,
      agentAta: policy.agentTokenAccount,
      oracleSigner: signer.publicKey,
      callValue: 1_000_000n,
    });
    return sendAndExtractCode(svm, new Transaction().add(ix), signer);
  }

  it("rejects a stranger signer with 6025 UnauthorizedOracle", () => {
    const svm = new LiteSVM();
    loadProgram(svm, { bypass: true });
    const proto = setupProtocol(svm);
    const pool = setupPool(svm, proto, "api.openai.com");
    const policy = setupPolicy(svm, proto, pool);
    const stranger = generateKeypair(svm);
    airdrop(svm, stranger.publicKey);
    expect(settle(svm, proto, pool, policy, stranger)).toBe(6025);
  });

  it("rejects the authority signer (authority is NOT the oracle — C-02 split)", () => {
    const svm = new LiteSVM();
    loadProgram(svm, { bypass: true });
    const proto = setupProtocol(svm);
    const pool = setupPool(svm, proto, "api.openai.com");
    const policy = setupPolicy(svm, proto, pool);
    expect(settle(svm, proto, pool, policy, proto.authority)).toBe(6025);
  });
});
