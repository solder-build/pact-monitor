import { describe, it, expect } from "vitest";
import { attachPactHeaders, HEADERS } from "../headers";

describe("attachPactHeaders", () => {
  it("returns a NEW Response with X-Pact-* headers; original is not mutated", () => {
    const original = new Response("body", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
    const wrapped = attachPactHeaders(original, {
      callId: "abc-123",
      outcome: "ok",
      premiumLamports: 1_000n,
      paymentAmountLamports: 0n,
      callValueLamports: 1_000_000n,
      latencyMs: 42,
      hostname: "api.openai.com",
      policyPda: "PolicyPda111111111111111111111111111111111111",
      pool: "openai-prod",
    });

    expect(wrapped).not.toBe(original);
    expect(wrapped.status).toBe(200);
    expect(wrapped.headers.get(HEADERS.PREMIUM)).toBe("1000");
    expect(wrapped.headers.get(HEADERS.REFUND)).toBe("0");
    expect(wrapped.headers.get(HEADERS.LATENCY_MS)).toBe("42");
    expect(wrapped.headers.get(HEADERS.OUTCOME)).toBe("ok");
    expect(wrapped.headers.get(HEADERS.CALL_ID)).toBe("abc-123");
    expect(wrapped.headers.get(HEADERS.HOSTNAME)).toBe("api.openai.com");
    expect(wrapped.headers.get(HEADERS.POLICY)).toBe(
      "PolicyPda111111111111111111111111111111111111"
    );
    expect(wrapped.headers.get(HEADERS.POOL)).toBe("openai-prod");
    expect(wrapped.headers.get(HEADERS.CALL_VALUE)).toBe("1000000");
    expect(original.headers.get(HEADERS.PREMIUM)).toBeNull();
  });

  it("omits POOL / HOSTNAME / POLICY / EVIDENCE headers when not provided", () => {
    const wrapped = attachPactHeaders(new Response(null, { status: 200 }), {
      callId: "abc",
      outcome: "ok",
      premiumLamports: 0n,
      paymentAmountLamports: 0n,
      callValueLamports: 0n,
      latencyMs: 0,
    });
    expect(wrapped.headers.get(HEADERS.POOL)).toBeNull();
    expect(wrapped.headers.get(HEADERS.HOSTNAME)).toBeNull();
    expect(wrapped.headers.get(HEADERS.POLICY)).toBeNull();
    expect(wrapped.headers.get(HEADERS.EVIDENCE_HASH)).toBeNull();
  });

  it("sets SETTLEMENT_PENDING when flag is true", () => {
    const wrapped = attachPactHeaders(new Response(null, { status: 200 }), {
      callId: "abc",
      outcome: "ok",
      premiumLamports: 0n,
      paymentAmountLamports: 0n,
      callValueLamports: 0n,
      latencyMs: 0,
      settlementPending: true,
    });
    expect(wrapped.headers.get(HEADERS.SETTLEMENT_PENDING)).toBe("1");
  });

  it("attaches evidence hash on breach", () => {
    const wrapped = attachPactHeaders(new Response(null, { status: 503 }), {
      callId: "abc",
      outcome: "server_error",
      premiumLamports: 100n,
      paymentAmountLamports: 1_000_000n,
      callValueLamports: 1_000_000n,
      latencyMs: 50,
      evidenceHash: "deadbeef".repeat(8),
    });
    expect(wrapped.headers.get(HEADERS.EVIDENCE_HASH)).toBe("deadbeef".repeat(8));
  });
});
