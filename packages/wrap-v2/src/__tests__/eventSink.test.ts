import { describe, it, expect, vi } from "vitest";
import {
  MemoryEventSink,
  HttpEventSink,
  PubSubEventSink,
  RedisStreamsEventSink,
} from "../eventSink";
import type { V2SettlementEvent } from "../types";

function evt(): V2SettlementEvent {
  return {
    callId: "abc-123",
    agentPubkey: "AgentPubkey1111111111111111111111111111111111",
    hostname: "api.openai.com",
    policyPda: "PolicyPda111111111111111111111111111111111111",
    callValue: "1000000",
    latencyMs: 42,
    outcome: "ok",
    ts: "2026-05-20T00:00:00Z",
  };
}

describe("MemoryEventSink", () => {
  it("appends published events", async () => {
    const sink = new MemoryEventSink();
    await sink.publish(evt());
    await sink.publish({ ...evt(), callId: "def-456" });
    expect(sink.events).toHaveLength(2);
    expect(sink.events[0].callId).toBe("abc-123");
    expect(sink.events[1].callId).toBe("def-456");
  });

  it("reset() clears events", async () => {
    const sink = new MemoryEventSink();
    await sink.publish(evt());
    sink.reset();
    expect(sink.events).toHaveLength(0);
  });
});

describe("HttpEventSink", () => {
  it("POSTs JSON to url, includes bearer when configured", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(null, { status: 200 })
    ) as unknown as typeof fetch;
    const sink = new HttpEventSink({
      url: "https://example/ingest",
      secret: "s3cr3t",
      fetchImpl,
    });
    await sink.publish(evt());
    expect((fetchImpl as any).mock.calls).toHaveLength(1);
    const [url, init] = (fetchImpl as any).mock.calls[0];
    expect(url).toBe("https://example/ingest");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer s3cr3t"
    );
    const parsed = JSON.parse(init.body as string);
    expect(parsed.callId).toBe("abc-123");
  });

  it("swallows non-2xx responses through onError", async () => {
    const onError = vi.fn();
    const fetchImpl = vi.fn(async () =>
      new Response(null, { status: 500 })
    ) as unknown as typeof fetch;
    const sink = new HttpEventSink({ url: "https://x", fetchImpl, onError });
    await sink.publish(evt());
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("swallows fetch throws", async () => {
    const onError = vi.fn();
    const fetchImpl = vi.fn(async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    const sink = new HttpEventSink({ url: "https://x", fetchImpl, onError });
    await sink.publish(evt());
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("PubSubEventSink", () => {
  it("delegates to topic.publishMessage", async () => {
    const publish = vi.fn(async () => "msg-id-1");
    const sink = new PubSubEventSink({ topic: { publishMessage: publish } });
    await sink.publish(evt());
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][0].json.callId).toBe("abc-123");
  });

  it("swallows publish errors", async () => {
    const onError = vi.fn();
    const publish = vi.fn(async () => {
      throw new Error("network down");
    });
    const sink = new PubSubEventSink({
      topic: { publishMessage: publish },
      onError,
    });
    await sink.publish(evt());
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("RedisStreamsEventSink", () => {
  it("XADDs to the configured stream", async () => {
    const publisher = { publish: vi.fn(async () => "1-0") };
    const sink = new RedisStreamsEventSink({
      publisher,
      stream: "pact-v2-test",
    });
    await sink.publish(evt());
    expect(publisher.publish).toHaveBeenCalledWith("pact-v2-test", expect.any(Object));
  });

  it("uses default stream name when none provided", async () => {
    const publisher = { publish: vi.fn(async () => "1-0") };
    const sink = new RedisStreamsEventSink({ publisher });
    await sink.publish(evt());
    expect(publisher.publish.mock.calls[0][0]).toBe("pact-v2-settle-events");
  });

  it("swallows errors", async () => {
    const onError = vi.fn();
    const publisher = {
      publish: vi.fn(async () => {
        throw new Error("redis down");
      }),
    };
    const sink = new RedisStreamsEventSink({ publisher, onError });
    await sink.publish(evt());
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
