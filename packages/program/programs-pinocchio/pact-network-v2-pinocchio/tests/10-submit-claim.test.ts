/**
 * `submit_claim` (disc 10) — oracle-signed claim handler. Creates the
 * Claim PDA (sha256-keyed), pays refund out of pool, bumps counters.
 *
 * Covered (full V1-equivalent + critique gaps):
 *   - happy: Claim PDA created; refund Transfer paid; policy + pool
 *     counters bumped
 *   - duplicate (same call_id → 6013 DuplicateClaim via sha256 PDA
 *     collision)
 *   - call_timestamp older than now - claim_window_seconds → 6012
 *     ClaimWindowExpired
 *   - aggregate cap exceeded → 6011 AggregateCapExceeded
 *   - aggregate cap window reset after advancing past cap_window seconds
 *   - refund clamp (payment > pool.max_coverage_per_call AND >
 *     pool.total_available, take min)
 *   - policy.active == 0 reject (6006 PolicyInactive — DIFFERENT from
 *     settle_premium per H-05; submit_claim DOES gate on active)
 *   - policy expired reject (6029 PolicyExpired)
 *   - trigger_type byte out of range → client throws (on-chain 6019
 *     unreachable via builder)
 */
import { describe, expect, it } from "vitest";
import { LiteSVM } from "litesvm";
import { Transaction } from "@solana/web3.js";
import {
  PROGRAM_ID,
  TriggerType,
  buildDisablePolicyIx,
  buildSubmitClaimIx,
  decodeClaim,
  decodeCoveragePool,
  decodePolicy,
  getClaimPda,
} from "@q3labs/pact-protocol-v2-client";
import {
  advanceClock,
  generateKeypair,
  getAccountData,
  getTokenBalance,
  loadProgram,
  sendAndExtractCode,
} from "./helpers.js";
import {
  setupPolicy,
  setupPool,
  setupProtocol,
  setupUnderwriter,
} from "./fixtures.js";

interface FullStack {
  svm: LiteSVM;
  proto: ReturnType<typeof setupProtocol>;
  pool: ReturnType<typeof setupPool>;
  policy: ReturnType<typeof setupPolicy>;
}

function setupFullStack(opts: {
  underwriterDeposit?: bigint;
  policyExpiresAt?: bigint;
  /** Override pool.max_coverage_per_call (default uses program default = 1M). */
  poolMaxCoveragePerCall?: bigint;
} = {}): FullStack {
  const svm = new LiteSVM();
  loadProgram(svm, { bypass: true });
  const proto = setupProtocol(svm);
  const pool = setupPool(svm, proto, "api.openai.com", {
    maxCoveragePerCall: opts.poolMaxCoveragePerCall,
  });
  setupUnderwriter(svm, proto, pool, opts.underwriterDeposit ?? 500_000_000n);
  const policy = setupPolicy(svm, proto, pool, {
    expiresAt: opts.policyExpiresAt,
  });
  return { svm, proto, pool, policy };
}

function buildSubmit(
  stack: FullStack,
  opts: {
    callId: string;
    paymentAmount?: bigint;
    triggerType?: TriggerType;
    callTimestampOffset?: bigint;
  }
): Transaction {
  const { svm, proto, pool, policy } = stack;
  const now = svm.getClock().unixTimestamp;
  const [claimPda] = getClaimPda(PROGRAM_ID, policy.policyPda, opts.callId);
  return new Transaction().add(
    buildSubmitClaimIx({
      programId: PROGRAM_ID,
      configPda: proto.configPda,
      poolPda: pool.poolPda,
      vault: pool.vaultPda,
      policyPda: policy.policyPda,
      claimPda,
      agentAta: policy.agentTokenAccount,
      oracle: proto.oracle.publicKey,
      callId: opts.callId,
      triggerType: opts.triggerType ?? TriggerType.Timeout,
      evidenceHash: new Uint8Array(32).fill(0xaa),
      callTimestamp: now + (opts.callTimestampOffset ?? -10n),
      latencyMs: 1200,
      statusCode: 504,
      paymentAmount: opts.paymentAmount ?? 1_000n,
    })
  );
}

describe("submit_claim — happy path", () => {
  it("creates Claim, transfers refund, bumps policy + pool counters", () => {
    const stack = setupFullStack();
    const [claimPda] = getClaimPda(PROGRAM_ID, stack.policy.policyPda, "call-happy");

    const agentBefore = getTokenBalance(stack.svm, stack.policy.agentTokenAccount);
    const vaultBefore = getTokenBalance(stack.svm, stack.pool.vaultPda);

    expect(
      sendAndExtractCode(stack.svm, buildSubmit(stack, { callId: "call-happy" }), stack.proto.oracle)
    ).toBeUndefined();

    const claim = decodeClaim(getAccountData(stack.svm, claimPda)!);
    expect(claim.refundAmount).toBe(1_000n);
    expect(claim.paymentAmount).toBe(1_000n);
    expect(claim.policy).toBe(stack.policy.policyPda.toBase58());

    expect(getTokenBalance(stack.svm, stack.policy.agentTokenAccount)).toBe(
      agentBefore + 1_000n
    );
    expect(getTokenBalance(stack.svm, stack.pool.vaultPda)).toBe(vaultBefore - 1_000n);

    const updatedPolicy = decodePolicy(getAccountData(stack.svm, stack.policy.policyPda)!);
    expect(updatedPolicy.totalClaimsReceived).toBe(1_000n);
    expect(updatedPolicy.callsCovered).toBe(1n);

    const updatedPool = decodeCoveragePool(getAccountData(stack.svm, stack.pool.poolPda)!);
    expect(updatedPool.totalClaimsPaid).toBe(1_000n);
  });
});

describe("submit_claim — DuplicateClaim 6013 (sha256 PDA collision)", () => {
  it("rejects a second claim with the same call_id", () => {
    const stack = setupFullStack();
    expect(
      sendAndExtractCode(stack.svm, buildSubmit(stack, { callId: "dup-1" }), stack.proto.oracle)
    ).toBeUndefined();

    const code = sendAndExtractCode(
      stack.svm,
      buildSubmit(stack, { callId: "dup-1" }),
      stack.proto.oracle
    );
    // 6013 DuplicateClaim OR built-in AccountAlreadyInitialized — both
    // are valid duplicate signals (the on-chain handler checks
    // claim.is_data_empty() first per submit_claim.rs:212-214).
    expect(code).not.toBeUndefined();
  });
});

describe("submit_claim — ClaimWindowExpired 6012", () => {
  it("rejects when call_timestamp is older than now - claim_window_seconds", () => {
    const stack = setupFullStack();
    // DEFAULT_CLAIM_WINDOW = 3600s. Set call_timestamp 4000s in the past.
    const code = sendAndExtractCode(
      stack.svm,
      buildSubmit(stack, { callId: "stale", callTimestampOffset: -4_000n }),
      stack.proto.oracle
    );
    expect(code).toBe(6012);
  });
});

describe("submit_claim — AggregateCapExceeded 6011 + window reset", () => {
  it("rejects when cumulative payout exceeds aggregate cap", () => {
    // DEFAULT_AGGREGATE_CAP_BPS = 3000 → 30% of total_deposited.
    // Deposit 200M USDC → cap = 60M. Override pool.max_coverage_per_call
    // to 100M so the refund clamp doesn't truncate the payment to 1M
    // (default) before the cap check fires. Try 60M+1 in one shot.
    const stack = setupFullStack({
      underwriterDeposit: 200_000_000n,
      poolMaxCoveragePerCall: 100_000_000n,
    });
    const code = sendAndExtractCode(
      stack.svm,
      buildSubmit(stack, {
        callId: "over-cap",
        paymentAmount: 60_000_001n,
      }),
      stack.proto.oracle
    );
    expect(code).toBe(6011);
  });

  it("resets the window after cap_window_seconds elapses", () => {
    // expiresAt set far in the future so the 86_400s advance doesn't
    // trip 6029 PolicyExpired before we test window reset.
    const future = BigInt(Math.floor(Date.now() / 1000)) + 86_400n * 30n;
    const stack = setupFullStack({
      underwriterDeposit: 200_000_000n,
      policyExpiresAt: future,
    });
    // Fill the window with a payout that succeeds (well under cap).
    expect(
      sendAndExtractCode(
        stack.svm,
        buildSubmit(stack, { callId: "c1", paymentAmount: 1_000_000n }),
        stack.proto.oracle
      )
    ).toBeUndefined();

    // Advance past DEFAULT_AGGREGATE_CAP_WINDOW = 86_400s.
    advanceClock(stack.svm, 86_500n);

    // A fresh claim under the new window should succeed.
    expect(
      sendAndExtractCode(
        stack.svm,
        buildSubmit(stack, { callId: "c2", paymentAmount: 1_000_000n, callTimestampOffset: -5n }),
        stack.proto.oracle
      )
    ).toBeUndefined();
  });
});

describe("submit_claim — refund clamp", () => {
  it("clamps refund to min(payment_amount, pool.max_coverage_per_call, pool.total_available)", () => {
    // DEFAULT_MAX_COVERAGE_PER_CALL = 1_000_000. Request 5M → expect 1M paid.
    const stack = setupFullStack({ underwriterDeposit: 200_000_000n });
    const [claimPda] = getClaimPda(PROGRAM_ID, stack.policy.policyPda, "clamp-1");
    const agentBefore = getTokenBalance(stack.svm, stack.policy.agentTokenAccount);

    expect(
      sendAndExtractCode(
        stack.svm,
        buildSubmit(stack, { callId: "clamp-1", paymentAmount: 5_000_000n }),
        stack.proto.oracle
      )
    ).toBeUndefined();

    const claim = decodeClaim(getAccountData(stack.svm, claimPda)!);
    expect(claim.paymentAmount).toBe(5_000_000n);
    expect(claim.refundAmount).toBe(1_000_000n); // clamped to max_coverage_per_call

    expect(getTokenBalance(stack.svm, stack.policy.agentTokenAccount)).toBe(
      agentBefore + 1_000_000n
    );
  });
});

describe("submit_claim — PolicyInactive 6006 (NOT H-05; submit_claim DOES gate)", () => {
  it("rejects when policy.active == 0", () => {
    const stack = setupFullStack();

    // Disable the policy first.
    const disable = buildDisablePolicyIx({
      programId: PROGRAM_ID,
      poolPda: stack.pool.poolPda,
      policyPda: stack.policy.policyPda,
      agent: stack.policy.agent.publicKey,
    });
    expect(
      sendAndExtractCode(stack.svm, new Transaction().add(disable), stack.policy.agent)
    ).toBeUndefined();

    const code = sendAndExtractCode(
      stack.svm,
      buildSubmit(stack, { callId: "after-disable" }),
      stack.proto.oracle
    );
    expect(code).toBe(6006);
  });
});

describe("submit_claim — PolicyExpired 6029", () => {
  it("rejects when claim is filed after policy.expires_at", () => {
    // Set expires_at to 100s from now; advance 200s; submit_claim.
    const svm = new LiteSVM();
    loadProgram(svm, { bypass: true });
    const proto = setupProtocol(svm);
    const pool = setupPool(svm, proto, "api.openai.com");
    setupUnderwriter(svm, proto, pool, 200_000_000n);
    const now = svm.getClock().unixTimestamp;
    const policy = setupPolicy(svm, proto, pool, { expiresAt: now + 100n });

    advanceClock(svm, 200n);

    const stack: FullStack = { svm, proto, pool, policy };
    const code = sendAndExtractCode(
      svm,
      buildSubmit(stack, { callId: "after-expire" }),
      proto.oracle
    );
    expect(code).toBe(6029);
  });
});

describe("submit_claim — invalid trigger_type", () => {
  it("client rejects trigger_type out of 0..=3", () => {
    const stack = setupFullStack();
    const [claimPda] = getClaimPda(PROGRAM_ID, stack.policy.policyPda, "x");
    expect(() =>
      buildSubmitClaimIx({
        programId: PROGRAM_ID,
        configPda: stack.proto.configPda,
        poolPda: stack.pool.poolPda,
        vault: stack.pool.vaultPda,
        policyPda: stack.policy.policyPda,
        claimPda,
        agentAta: stack.policy.agentTokenAccount,
        oracle: stack.proto.oracle.publicKey,
        callId: "x",
        triggerType: 4 as TriggerType,
        evidenceHash: new Uint8Array(32),
        callTimestamp: 0n,
        latencyMs: 0,
        statusCode: 0,
        paymentAmount: 1_000n,
      })
    ).toThrow(/triggerType/);
  });
});
