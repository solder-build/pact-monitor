import { describe, it, expect } from "vitest";
import { splitPremium } from "./premium-submitter.service";

describe("splitPremium", () => {
  it("computes 2-way split (no referrer)", () => {
    // callValue=1_000_000, rate=200bps, floor=50bps, fee=1500bps, ref=0
    // gross = max(1e6*200/1e4, 1e6*50/1e4) = max(20_000, 5_000) = 20_000
    // treasury = 20_000 * 1500 / 10_000 = 3_000
    // referrer = 0
    // pool = 20_000 - 3_000 - 0 = 17_000
    const s = splitPremium(1_000_000n, 200, 50, 1500, 0);
    expect(s.gross).toBe(20_000n);
    expect(s.treasuryCut).toBe(3_000n);
    expect(s.referrerCut).toBe(0n);
    expect(s.poolCut).toBe(17_000n);
  });

  it("computes 3-way split (with referrer)", () => {
    // rate=200, fee=1500, ref=1500 (15%)
    // gross = 20_000, treasury = 3_000, referrer = 3_000, pool = 14_000
    const s = splitPremium(1_000_000n, 200, 50, 1500, 1500);
    expect(s.treasuryCut).toBe(3_000n);
    expect(s.referrerCut).toBe(3_000n);
    expect(s.poolCut).toBe(14_000n);
    expect(s.poolCut + s.treasuryCut + s.referrerCut).toBe(s.gross);
  });

  it("applies floor when rate is below it", () => {
    // rate=10, floor=50 → grossFloor wins.
    // 1e6 * 50 / 10000 = 5_000
    const s = splitPremium(1_000_000n, 10, 50, 0, 0);
    expect(s.gross).toBe(5_000n);
    expect(s.poolCut).toBe(5_000n);
  });

  it("returns all-zero when callValue=0", () => {
    const s = splitPremium(0n, 200, 50, 1500, 0);
    expect(s.gross).toBe(0n);
    expect(s.poolCut).toBe(0n);
    expect(s.treasuryCut).toBe(0n);
    expect(s.referrerCut).toBe(0n);
  });

  it("clamps negative bps to zero", () => {
    const s = splitPremium(1_000_000n, -1, -1, -1, -1);
    expect(s.gross).toBe(0n);
  });

  it("residual goes to pool — sum invariant holds even on rounding edge", () => {
    // 7_999 * 333 / 10_000 = 266_366.667 → 266 floored
    // No simple way to engineer a non-zero rounding loss in u64 div; the
    // residual subtraction guarantees pool absorbs any rounding remainder.
    const s = splitPremium(7_999n, 333, 0, 100, 100);
    expect(s.poolCut + s.treasuryCut + s.referrerCut).toBe(s.gross);
  });
});
