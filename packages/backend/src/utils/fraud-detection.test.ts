import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeLoadingFactor, isOutage } from "./fraud-detection.js";

describe("computeLoadingFactor", () => {
  it("returns 1.0 when agent rate <= 2x network rate", () => {
    assert.equal(computeLoadingFactor(10, 6), 1.0);
  });

  it("returns 1.0 when agent rate equals network rate", () => {
    assert.equal(computeLoadingFactor(5, 5), 1.0);
  });

  it("returns 1.5 when agent rate is 2x-5x network rate", () => {
    assert.equal(computeLoadingFactor(15, 5), 1.5);
  });

  it("returns 1.5 at exactly 2x boundary", () => {
    assert.equal(computeLoadingFactor(10.01, 5), 1.5);
  });

  it("returns 2.5 when agent rate > 5x network rate", () => {
    assert.equal(computeLoadingFactor(30, 5), 2.5);
  });

  it("returns 2.5 at exactly 5x boundary", () => {
    assert.equal(computeLoadingFactor(25.01, 5), 2.5);
  });

  it("returns 1.0 when network rate is 0 and agent rate is 0", () => {
    assert.equal(computeLoadingFactor(0, 0), 1.0);
  });

  it("returns 2.5 when network rate is 0 but agent has failures", () => {
    assert.equal(computeLoadingFactor(5, 0), 2.5);
  });

  it("returns 1.0 when agent rate is 0", () => {
    assert.equal(computeLoadingFactor(0, 10), 1.0);
  });
});

describe("isOutage", () => {
  it("returns true when 5+ established agents report failures", () => {
    assert.equal(isOutage(5), true);
  });

  it("returns true when more than 5 agents report", () => {
    assert.equal(isOutage(10), true);
  });

  it("returns false when fewer than 5 agents report", () => {
    assert.equal(isOutage(4), false);
  });

  it("returns false when 0 agents report", () => {
    assert.equal(isOutage(0), false);
  });
});
