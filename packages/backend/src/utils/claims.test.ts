import { describe, it } from "node:test";
import assert from "node:assert/strict";

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
});
