import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeInsuranceRate, computeTier } from "./insurance.js";

function assertClose(actual: number, expected: number, epsilon = 1e-10): void {
  assert.ok(
    Math.abs(actual - expected) < epsilon,
    `Expected ${actual} to be close to ${expected}`,
  );
}

describe("computeInsuranceRate", () => {
  it("0.1% failure rate returns ~0.25% insurance rate", () => {
    assertClose(computeInsuranceRate(0.001), 0.0025);
  });

  it("0.3% failure rate returns ~0.55% insurance rate", () => {
    assertClose(computeInsuranceRate(0.003), 0.0055);
  });

  it("1.5% failure rate returns ~2.35% insurance rate", () => {
    assertClose(computeInsuranceRate(0.015), 0.0235);
  });

  it("5% failure rate returns ~7.6% insurance rate", () => {
    assertClose(computeInsuranceRate(0.05), 0.076);
  });

  it("0% failure rate floors at 0.1% (0.001)", () => {
    assert.equal(computeInsuranceRate(0), 0.001);
  });

  it("very high failure rate (50%) computes correctly", () => {
    assertClose(computeInsuranceRate(0.5), 0.751);
  });
});

describe("computeTier", () => {
  it("RELIABLE for insurance rate < 1%", () => {
    assert.equal(computeTier(0.005), "RELIABLE");
    assert.equal(computeTier(0.009), "RELIABLE");
  });

  it("ELEVATED for insurance rate 1%-5%", () => {
    assert.equal(computeTier(0.02), "ELEVATED");
    assert.equal(computeTier(0.03), "ELEVATED");
  });

  it("HIGH_RISK for insurance rate > 5%", () => {
    assert.equal(computeTier(0.06), "HIGH_RISK");
    assert.equal(computeTier(0.1), "HIGH_RISK");
  });

  it("boundary: exactly 1% (0.01) is ELEVATED, not RELIABLE", () => {
    assert.equal(computeTier(0.01), "ELEVATED");
  });

  it("boundary: exactly 5% (0.05) is ELEVATED, not HIGH_RISK", () => {
    assert.equal(computeTier(0.05), "ELEVATED");
  });
});
