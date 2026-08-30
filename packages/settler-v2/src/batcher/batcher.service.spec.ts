import { describe, it, expect, vi } from "vitest";
import { BatcherService, SettleBatch } from "./batcher.service";
import type { SettleMessage } from "../consumer/consumer.service";

function fakeConfig(overrides: Record<string, unknown> = {}): any {
  const defaults: Record<string, unknown> = {
    MAX_IXS_PER_TX: 6,
    FLUSH_INTERVAL_MS: 5000,
    ...overrides,
  };
  return { get: (k: string) => defaults[k] };
}

function makeMessage(
  callId: string,
  hostname: string,
  callValue: string,
  outcome: string = "ok"
): SettleMessage & { ackSpy: ReturnType<typeof vi.fn> } {
  const ack = vi.fn();
  const nack = vi.fn();
  return {
    id: `msg-${callId}`,
    data: { callId, hostname, callValue, outcome, policyPda: "X" },
    ack,
    nack,
    ackSpy: ack,
  };
}

describe("BatcherService", () => {
  it("groups by hostname and flushes at MAX_IXS_PER_TX", async () => {
    vi.useFakeTimers();
    const flushed: SettleBatch[] = [];
    const svc = new BatcherService(fakeConfig({ MAX_IXS_PER_TX: 3 }));
    svc.setFlushCallback(async (b) => {
      flushed.push(b);
    });

    for (let i = 0; i < 3; i++) {
      svc.push(makeMessage(`a-${i}`, "api.openai.com", "1000000"));
    }
    // Synchronously dispatched via void Promise; need microtask drain.
    await vi.runAllTimersAsync();

    expect(flushed).toHaveLength(1);
    expect(flushed[0]!.hostname).toBe("api.openai.com");
    expect(flushed[0]!.messages).toHaveLength(3);
    vi.useRealTimers();
  });

  it("does not mix hostnames in one batch", async () => {
    vi.useFakeTimers();
    const flushed: SettleBatch[] = [];
    const svc = new BatcherService(fakeConfig({ MAX_IXS_PER_TX: 2 }));
    svc.setFlushCallback(async (b) => {
      flushed.push(b);
    });

    svc.push(makeMessage("a", "api.openai.com", "1000000"));
    svc.push(makeMessage("b", "api.helius.dev", "2000000"));
    svc.push(makeMessage("c", "api.openai.com", "1000000")); // openai hits cap=2 → flush
    await vi.runAllTimersAsync();

    const openai = flushed.find((b) => b.hostname === "api.openai.com");
    expect(openai).toBeDefined();
    expect(openai!.messages).toHaveLength(2);

    // helius has only 1 — not flushed until timer fires.
    vi.advanceTimersByTime(5001);
    await vi.runAllTimersAsync();
    const helius = flushed.find((b) => b.hostname === "api.helius.dev");
    expect(helius).toBeDefined();
    expect(helius!.messages).toHaveLength(1);
    vi.useRealTimers();
  });

  it("flushes per-hostname buffers on the timer when below cap", async () => {
    vi.useFakeTimers();
    const flushed: SettleBatch[] = [];
    const svc = new BatcherService(
      fakeConfig({ MAX_IXS_PER_TX: 6, FLUSH_INTERVAL_MS: 500 })
    );
    svc.setFlushCallback(async (b) => {
      flushed.push(b);
    });

    svc.push(makeMessage("a", "h.com", "1000"));
    expect(flushed).toHaveLength(0);

    vi.advanceTimersByTime(500);
    await vi.runAllTimersAsync();
    expect(flushed).toHaveLength(1);
    expect(flushed[0]!.messages).toHaveLength(1);
    vi.useRealTimers();
  });

  it("drops zero-callValue events and acks them", () => {
    const svc = new BatcherService(fakeConfig());
    svc.setFlushCallback(async () => {});
    const m = makeMessage("zero", "h.com", "0");
    svc.push(m);
    expect(m.ackSpy).toHaveBeenCalledTimes(1);
    expect(svc.pendingCount).toBe(0);
  });

  it("drops events with non-numeric callValue", () => {
    const svc = new BatcherService(fakeConfig());
    svc.setFlushCallback(async () => {});
    const m = makeMessage("bad", "h.com", "not-a-number");
    svc.push(m);
    expect(m.ackSpy).toHaveBeenCalledTimes(1);
    expect(svc.pendingCount).toBe(0);
  });

  it("drops events missing hostname", () => {
    const svc = new BatcherService(fakeConfig());
    svc.setFlushCallback(async () => {});
    const m = makeMessage("nohost", "", "1000");
    svc.push(m);
    expect(m.ackSpy).toHaveBeenCalledTimes(1);
  });

  it("flushNow flushes every pending hostname", async () => {
    const flushed: SettleBatch[] = [];
    const svc = new BatcherService(fakeConfig({ MAX_IXS_PER_TX: 10 }));
    svc.setFlushCallback(async (b) => {
      flushed.push(b);
    });

    svc.push(makeMessage("a", "h1.com", "1000"));
    svc.push(makeMessage("b", "h2.com", "2000"));
    expect(svc.pendingCount).toBe(2);

    await svc.flushNow();
    expect(flushed).toHaveLength(2);
    expect(svc.pendingCount).toBe(0);
  });

  it("onModuleDestroy clears timers and flushes", async () => {
    const flushed: SettleBatch[] = [];
    const svc = new BatcherService(fakeConfig());
    svc.setFlushCallback(async (b) => {
      flushed.push(b);
    });
    svc.push(makeMessage("a", "h.com", "1000"));
    await svc.onModuleDestroy();
    expect(flushed).toHaveLength(1);
  });
});
