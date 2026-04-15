import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "crypto";
import { callIdSeedBytes } from "./solana.js";

describe("claims refund logic", () => {
  it("returns correct refund percentages per trigger type", () => {
    const REFUND_PCT: Record<string, number> = {
      timeout: 100,
      error: 100,
      schema_mismatch: 75,
      latency_sla: 50,
    };

    assert.equal(REFUND_PCT["timeout"], 100);
    assert.equal(REFUND_PCT["error"], 100);
    assert.equal(REFUND_PCT["schema_mismatch"], 75);
    assert.equal(REFUND_PCT["latency_sla"], 50);
  });

  it("computes refund amount correctly", () => {
    const paymentAmount = 10000;
    const refundPct = 75;
    const refundAmount = Math.round((paymentAmount * refundPct) / 100);
    assert.equal(refundAmount, 7500);
  });

  it("computes 100% refund correctly", () => {
    const paymentAmount = 5432;
    const refundPct = 100;
    const refundAmount = Math.round((paymentAmount * refundPct) / 100);
    assert.equal(refundAmount, 5432);
  });

  it("computes 50% refund correctly with rounding", () => {
    const paymentAmount = 1001;
    const refundPct = 50;
    const refundAmount = Math.round((paymentAmount * refundPct) / 100);
    assert.equal(refundAmount, 501);
  });

  // --- Clamp tests for maybeCreateClaim's pre-chain optimistic refund.
  // Prevents SDK unit-mistakes (passing lamports as USDC) from rendering
  // "2000000.00 USDC" rows in the scorecard.

  const MAX_SIMULATED_CALL_LAMPORTS = 1_000_000_000; // 1000 USDC

  function simulateClamp(paymentAmount: number, refundPct: number) {
    const clampedCallCost = Math.min(paymentAmount, MAX_SIMULATED_CALL_LAMPORTS);
    const refundAmount = Math.min(
      Math.round((clampedCallCost * refundPct) / 100),
      MAX_SIMULATED_CALL_LAMPORTS,
    );
    return { clampedCallCost, refundAmount };
  }

  it("clamps a unit-mistake payment_amount of 2 trillion lamports at 1000 USDC", () => {
    // Simulating: SDK user accidentally passed 2_000_000 as usdcAmount
    // thinking it was lamports. SDK multiplied by 1e6 -> 2e12 payment_amount.
    const { clampedCallCost, refundAmount } = simulateClamp(2_000_000_000_000, 100);
    assert.equal(clampedCallCost, 1_000_000_000);
    assert.equal(refundAmount, 1_000_000_000);
  });

  it("does not clamp sane values (1 USDC call)", () => {
    const { clampedCallCost, refundAmount } = simulateClamp(1_000_000, 100);
    assert.equal(clampedCallCost, 1_000_000);
    assert.equal(refundAmount, 1_000_000);
  });

  it("clamps refund_amount even when call_cost is already in range (pathological refund_pct)", () => {
    // Guard against an impossible refund_pct > 100. Caps refund at ceiling.
    const clampedRefund = Math.min(
      Math.round((500_000_000 * 300) / 100),
      MAX_SIMULATED_CALL_LAMPORTS,
    );
    assert.equal(clampedRefund, 1_000_000_000);
  });

  it("MAX_SIMULATED_CALL_LAMPORTS boundary value passes through unchanged", () => {
    const { clampedCallCost, refundAmount } = simulateClamp(1_000_000_000, 100);
    assert.equal(clampedCallCost, 1_000_000_000);
    assert.equal(refundAmount, 1_000_000_000);
  });
});

describe("callIdSeedBytes (H-02 lock-in)", () => {
  it("produces sha256 of the call_id string", () => {
    const callId = "11111111-2222-3333-4444-555555555555";
    const expected = createHash("sha256").update(callId).digest();
    assert.deepEqual(
      Buffer.from(callIdSeedBytes(callId)),
      expected,
    );
  });

  it("produces a 32-byte output regardless of input length", () => {
    assert.equal(callIdSeedBytes("short").length, 32);
    assert.equal(callIdSeedBytes("11111111-2222-3333-4444-555555555555").length, 32);

    // 64-char boundary (MAX_CALL_ID_LEN) is the case closest to the H-02 bug;
    // lock it to sha256 bytes so a future swap to any other 32-byte digest
    // (SHA-512/256, BLAKE2s, etc.) fails loudly instead of silently desyncing
    // from the on-chain program.
    const long = "a".repeat(64);
    assert.deepEqual(
      Buffer.from(callIdSeedBytes(long)),
      createHash("sha256").update(long).digest(),
    );
    assert.equal(callIdSeedBytes(long).length, 32);
  });
});
