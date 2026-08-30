import { describe, it, expect, vi } from "vitest";
import { wrapFetch } from "../wrapFetch";
import { defaultClassifier } from "../classifier";
import { MemoryEventSink } from "../eventSink";
import { HEADERS } from "../headers";
import type { PolicyConfig } from "../types";

const policy: PolicyConfig = {
  hostname: "api.openai.com",
  policyPda: "PolicyPda111111111111111111111111111111111111",
  sla_latency_ms: 1000,
  insurance_rate_bps: 200,
  min_premium_bps: 50,
  max_coverage_per_call: 10_000_000n,
};

const CALL_VALUE = 1_000_000n; // 1 USDC

function buildOpts(overrides: Partial<Parameters<typeof wrapFetch>[0]> = {}) {
  const sink = new MemoryEventSink();
  return {
    sink,
    base: {
      hostname: policy.hostname,
      walletPubkey: "AgentPubkey1111111111111111111111111111111111",
      upstreamUrl: "https://upstream.example",
      classifier: defaultClassifier,
      sink,
      policyConfig: policy,
      callValue: CALL_VALUE,
      callId: "callid-fixed",
      ...overrides,
    },
  };
}

describe("wrapFetch — happy path", () => {
  it("publishes V2SettlementEvent with no breach tail on outcome=ok", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("payload", { status: 200, headers: { "content-type": "text/plain" } })
    ) as unknown as typeof fetch;
    const { sink, base } = buildOpts();
    let t = 1_000_000;
    const result = await wrapFetch({
      ...base,
      fetchImpl,
      now: () => {
        t += 100;
        return t;
      },
    });

    expect(result.outcome).toBe("ok");
    expect(result.premiumLamports).toBe(20_000n);
    expect(result.paymentAmountLamports).toBe(0n);
    expect(result.latencyMs).toBe(100);

    expect(sink.events).toHaveLength(1);
    const ev = sink.events[0];
    expect(ev.outcome).toBe("ok");
    expect(ev.callValue).toBe(CALL_VALUE.toString());
    expect(ev.paymentAmount).toBeUndefined();
    expect(ev.evidenceHash).toBeUndefined();
    expect(ev.triggerType).toBeUndefined();
  });

  it("attaches X-Pact-* headers including hostname + policyPda", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(null, { status: 200 })
    ) as unknown as typeof fetch;
    const { base } = buildOpts();
    const { response } = await wrapFetch({ ...base, fetchImpl, now: () => 1 });
    expect(response.headers.get(HEADERS.HOSTNAME)).toBe(policy.hostname);
    expect(response.headers.get(HEADERS.POLICY)).toBe(policy.policyPda);
    expect(response.headers.get(HEADERS.OUTCOME)).toBe("ok");
    expect(response.headers.get(HEADERS.SETTLEMENT_PENDING)).toBe("1");
    expect(response.headers.get(HEADERS.CALL_VALUE)).toBe(CALL_VALUE.toString());
  });
});

describe("wrapFetch — breach paths populate breach tail", () => {
  it("server_error (5xx) → event carries paymentAmount, evidence, triggerType=Error, statusCode", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(null, { status: 503 })
    ) as unknown as typeof fetch;
    const { sink, base } = buildOpts();
    let t = 1_000_000;
    await wrapFetch({
      ...base,
      fetchImpl,
      now: () => {
        t += 100;
        return t;
      },
    });
    const ev = sink.events[0];
    expect(ev.outcome).toBe("server_error");
    expect(ev.paymentAmount).toBe(CALL_VALUE.toString());
    expect(ev.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(ev.statusCode).toBe(503);
    expect(ev.triggerType).toBe(1); // TRIGGER_ERROR
    expect(ev.callTimestamp).toBeDefined();
  });

  it("network_error (fetch throws) → outcome network_error, statusCode 0", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const { sink, base } = buildOpts();
    const { response, outcome } = await wrapFetch({
      ...base,
      fetchImpl,
      now: () => 1,
    });
    expect(outcome).toBe("network_error");
    expect(response.status).toBe(502); // synthesized
    expect(sink.events[0].statusCode).toBe(0);
    expect(sink.events[0].triggerType).toBe(0); // TRIGGER_TIMEOUT
  });

  it("latency_breach → triggerType=LatencySla", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(null, { status: 200 })
    ) as unknown as typeof fetch;
    const { sink, base } = buildOpts();
    let t = 0;
    await wrapFetch({
      ...base,
      fetchImpl,
      now: () => {
        const v = t;
        t = 2000;
        return v;
      },
    });
    const ev = sink.events[0];
    expect(ev.outcome).toBe("latency_breach");
    expect(ev.triggerType).toBe(3); // TRIGGER_LATENCY_SLA
  });

  it("4xx → no premium, no refund, no breach tail", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(null, { status: 404 })
    ) as unknown as typeof fetch;
    const { sink, base } = buildOpts();
    const r = await wrapFetch({ ...base, fetchImpl, now: () => 1 });
    expect(r.outcome).toBe("client_error");
    expect(r.premiumLamports).toBe(0n);
    expect(r.paymentAmountLamports).toBe(0n);
    expect(sink.events[0].paymentAmount).toBeUndefined();
  });
});

describe("wrapFetch — balance check", () => {
  it("short-circuits 402 when allowance insufficient", async () => {
    const balanceCheck = {
      check: vi.fn(async () => ({
        eligible: false as const,
        reason: "insufficient_allowance" as const,
        ataBalance: 100n,
        allowance: 0n,
      })),
    };
    const { sink, base } = buildOpts();
    const r = await wrapFetch({ ...base, balanceCheck, now: () => 1 });
    expect(r.response.status).toBe(402);
    expect(r.outcome).toBe("client_error");
    expect(sink.events).toHaveLength(0); // nothing forwarded upstream
  });

  it("short-circuits 503 when balance check throws", async () => {
    const balanceCheck = {
      check: vi.fn(async () => {
        throw new Error("RPC down");
      }),
    };
    const { sink, base } = buildOpts();
    const r = await wrapFetch({ ...base, balanceCheck, now: () => 1 });
    expect(r.response.status).toBe(503);
    expect(r.outcome).toBe("server_error");
    expect(sink.events).toHaveLength(0);
  });

  it("proceeds when balance check returns eligible", async () => {
    const balanceCheck = {
      check: vi.fn(async () => ({
        eligible: true as const,
        ataBalance: 100_000_000n,
        allowance: 100_000_000n,
      })),
    };
    const fetchImpl = vi.fn(async () =>
      new Response(null, { status: 200 })
    ) as unknown as typeof fetch;
    const { sink, base } = buildOpts();
    const r = await wrapFetch({
      ...base,
      balanceCheck,
      fetchImpl,
      now: () => 1,
    });
    expect(r.outcome).toBe("ok");
    expect(sink.events).toHaveLength(1);
  });
});

describe("wrapFetch — sink error isolation", () => {
  it("does not propagate sink throw", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(null, { status: 200 })
    ) as unknown as typeof fetch;
    const throwingSink = {
      publish: vi.fn(() => {
        throw new Error("sync throw");
      }),
    };
    const { base } = buildOpts({ sink: throwingSink as any });
    const r = await wrapFetch({
      ...base,
      sink: throwingSink as any,
      fetchImpl,
      now: () => 1,
    });
    expect(r.outcome).toBe("ok"); // wrap survives
  });

  it("does not propagate sink async rejection", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(null, { status: 200 })
    ) as unknown as typeof fetch;
    const rejectingSink = {
      publish: vi.fn(async () => {
        throw new Error("async throw");
      }),
    };
    const { base } = buildOpts({ sink: rejectingSink as any });
    const r = await wrapFetch({
      ...base,
      sink: rejectingSink as any,
      fetchImpl,
      now: () => 1,
    });
    expect(r.outcome).toBe("ok");
  });
});

describe("wrapFetch — callId override", () => {
  it("uses provided callId verbatim", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(null, { status: 200 })
    ) as unknown as typeof fetch;
    const { sink, base } = buildOpts();
    const r = await wrapFetch({
      ...base,
      callId: "explicit-callid",
      fetchImpl,
      now: () => 1,
    });
    expect(r.callId).toBe("explicit-callid");
    expect(sink.events[0].callId).toBe("explicit-callid");
  });
});

describe("wrapFetch — evidenceHash is deterministic", () => {
  it("same inputs → same hash", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(null, { status: 503 })
    ) as unknown as typeof fetch;
    const { sink, base } = buildOpts();
    await wrapFetch({ ...base, fetchImpl, now: () => 1 });
    await wrapFetch({ ...base, fetchImpl, now: () => 1 });
    expect(sink.events[0].evidenceHash).toBe(sink.events[1].evidenceHash);
    expect(sink.events[0].evidenceHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
