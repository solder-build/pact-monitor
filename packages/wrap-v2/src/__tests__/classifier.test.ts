import { describe, it, expect } from "vitest";
import {
  defaultClassifier,
  composeWithDefault,
  computePremium,
  clampRefund,
} from "../classifier";
import {
  TRIGGER_ERROR,
  TRIGGER_LATENCY_SLA,
  TRIGGER_TIMEOUT,
} from "../types";

const policy = {
  sla_latency_ms: 1000,
  insurance_rate_bps: 200, // 2%
  min_premium_bps: 50, // 0.5% floor
  max_coverage_per_call: 10_000_000n, // 10 USDC cap
};

describe("computePremium", () => {
  it("returns 0 for callValue=0", () => {
    expect(computePremium(0n, 200, 50)).toBe(0n);
  });

  it("applies rate when above floor", () => {
    // 1_000_000 * 200 / 10_000 = 20_000
    expect(computePremium(1_000_000n, 200, 50)).toBe(20_000n);
  });

  it("uses floor when rate is below it", () => {
    // rate=10bps → 1000; floor=50bps → 5000 (winner)
    expect(computePremium(1_000_000n, 10, 50)).toBe(5_000n);
  });

  it("clamps negative bps to zero", () => {
    expect(computePremium(1_000_000n, -10, -5)).toBe(0n);
  });
});

describe("clampRefund", () => {
  it("returns callValue when below cap", () => {
    expect(clampRefund(500_000n, 1_000_000n)).toBe(500_000n);
  });
  it("returns cap when callValue exceeds", () => {
    expect(clampRefund(5_000_000n, 1_000_000n)).toBe(1_000_000n);
  });
  it("returns 0 for non-positive cap or callValue", () => {
    expect(clampRefund(0n, 1_000_000n)).toBe(0n);
    expect(clampRefund(1_000_000n, 0n)).toBe(0n);
    expect(clampRefund(1_000_000n, -1n)).toBe(0n);
  });
});

describe("defaultClassifier — outcomes", () => {
  const callValue = 1_000_000n; // 1 USDC

  it("network_error (null response) → premium charged, refund=cap, Timeout", () => {
    const r = defaultClassifier.classify({
      response: null,
      latencyMs: 0,
      callValue,
      policy,
    });
    expect(r.outcome).toBe("network_error");
    expect(r.premium).toBe(20_000n); // 1 USDC * 2%
    expect(r.paymentAmount).toBe(1_000_000n); // < cap
    expect(r.triggerType).toBe(TRIGGER_TIMEOUT);
    expect(r.statusCode).toBe(0);
  });

  it("5xx → server_error, premium charged, refund clamped to cap, Error", () => {
    const r = defaultClassifier.classify({
      response: new Response(null, { status: 503 }),
      latencyMs: 50,
      callValue: 20_000_000n, // 20 USDC — above 10 USDC cap
      policy,
    });
    expect(r.outcome).toBe("server_error");
    expect(r.paymentAmount).toBe(10_000_000n); // clamped
    expect(r.triggerType).toBe(TRIGGER_ERROR);
    expect(r.statusCode).toBe(503);
  });

  it("4xx → client_error, no premium, no refund", () => {
    const r = defaultClassifier.classify({
      response: new Response(null, { status: 404 }),
      latencyMs: 50,
      callValue,
      policy,
    });
    expect(r.outcome).toBe("client_error");
    expect(r.premium).toBe(0n);
    expect(r.paymentAmount).toBe(0n);
    expect(r.triggerType).toBeUndefined();
  });

  it("429 → client_error, no premium", () => {
    const r = defaultClassifier.classify({
      response: new Response(null, { status: 429 }),
      latencyMs: 50,
      callValue,
      policy,
    });
    expect(r.outcome).toBe("client_error");
    expect(r.premium).toBe(0n);
  });

  it("2xx + latency > sla → latency_breach, premium + refund, LatencySla", () => {
    const r = defaultClassifier.classify({
      response: new Response(null, { status: 200 }),
      latencyMs: 1500,
      callValue,
      policy,
    });
    expect(r.outcome).toBe("latency_breach");
    expect(r.premium).toBe(20_000n);
    expect(r.paymentAmount).toBe(1_000_000n);
    expect(r.triggerType).toBe(TRIGGER_LATENCY_SLA);
    expect(r.statusCode).toBe(200);
  });

  it("2xx + latency <= sla → ok, premium, no refund", () => {
    const r = defaultClassifier.classify({
      response: new Response(null, { status: 200 }),
      latencyMs: 800,
      callValue,
      policy,
    });
    expect(r.outcome).toBe("ok");
    expect(r.premium).toBe(20_000n);
    expect(r.paymentAmount).toBe(0n);
    expect(r.triggerType).toBeUndefined();
  });

  it("3xx → ok (premium charged, no refund)", () => {
    const r = defaultClassifier.classify({
      response: new Response(null, { status: 304 }),
      latencyMs: 100,
      callValue,
      policy,
    });
    expect(r.outcome).toBe("ok");
    expect(r.premium).toBe(20_000n);
    expect(r.paymentAmount).toBe(0n);
  });
});

describe("composeWithDefault", () => {
  it("uses plugin result when non-null", () => {
    const plugin = composeWithDefault(() => ({
      outcome: "server_error" as const,
      premium: 999n,
      paymentAmount: 50n,
      triggerType: TRIGGER_ERROR,
      statusCode: 500,
    }));
    const r = plugin.classify({
      response: new Response(null, { status: 200 }),
      latencyMs: 0,
      callValue: 1_000_000n,
      policy,
    });
    expect(r.outcome).toBe("server_error");
    expect(r.premium).toBe(999n);
  });

  it("falls through to default when plugin returns null", () => {
    const plugin = composeWithDefault(() => null);
    const r = plugin.classify({
      response: new Response(null, { status: 200 }),
      latencyMs: 0,
      callValue: 1_000_000n,
      policy,
    });
    expect(r.outcome).toBe("ok");
    expect(r.premium).toBe(20_000n);
  });
});
