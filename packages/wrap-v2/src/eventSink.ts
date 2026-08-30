// @pact-network/wrap-v2 — event sinks.
//
// Identical contract to @pact-network/wrap (four implementations, all errors
// swallowed) but typed against V2SettlementEvent. The on-the-wire shape
// changes (V2 includes a breach tail); the publisher abstraction does not.

import type { V2SettlementEvent } from "./types";

export interface EventSink {
  publish(event: V2SettlementEvent): Promise<void>;
}

// ---------------------------------------------------------------------------
// MemoryEventSink
// ---------------------------------------------------------------------------

export class MemoryEventSink implements EventSink {
  public readonly events: V2SettlementEvent[] = [];

  async publish(event: V2SettlementEvent): Promise<void> {
    this.events.push(event);
  }

  reset(): void {
    this.events.length = 0;
  }
}

// ---------------------------------------------------------------------------
// HttpEventSink
// ---------------------------------------------------------------------------

export interface HttpEventSinkOptions {
  /** Endpoint that accepts POST {event} JSON. */
  url: string;
  /** Optional bearer secret. Sent as `Authorization: Bearer <secret>`. */
  secret?: string;
  /** Optional fetch override (tests). */
  fetchImpl?: typeof fetch;
  /** Optional logger called with publish failures. Default: console.warn. */
  onError?: (err: unknown) => void;
}

export class HttpEventSink implements EventSink {
  private readonly url: string;
  private readonly secret: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly onError: (err: unknown) => void;

  constructor(opts: HttpEventSinkOptions) {
    this.url = opts.url;
    this.secret = opts.secret;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.onError =
      opts.onError ??
      ((err) => {
        // eslint-disable-next-line no-console
        console.warn("wrap-v2.HttpEventSink: publish failed", err);
      });
  }

  async publish(event: V2SettlementEvent): Promise<void> {
    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (this.secret) headers.authorization = `Bearer ${this.secret}`;

      const resp = await this.fetchImpl(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify(event),
      });
      if (!resp.ok) {
        this.onError(
          new Error(`wrap-v2.HttpEventSink: ${this.url} returned ${resp.status}`)
        );
      }
    } catch (err) {
      this.onError(err);
    }
  }
}

// ---------------------------------------------------------------------------
// PubSubEventSink
// ---------------------------------------------------------------------------

export interface PubSubTopicPublisher {
  publishMessage(args: { json: V2SettlementEvent }): Promise<string>;
}

export interface PubSubEventSinkOptions {
  topic: PubSubTopicPublisher;
  onError?: (err: unknown) => void;
}

export class PubSubEventSink implements EventSink {
  private readonly topic: PubSubTopicPublisher;
  private readonly onError: (err: unknown) => void;

  constructor(opts: PubSubEventSinkOptions) {
    this.topic = opts.topic;
    this.onError =
      opts.onError ??
      ((err) => {
        // eslint-disable-next-line no-console
        console.warn("wrap-v2.PubSubEventSink: publish failed", err);
      });
  }

  async publish(event: V2SettlementEvent): Promise<void> {
    try {
      await this.topic.publishMessage({ json: event });
    } catch (err) {
      this.onError(err);
    }
  }
}

// ---------------------------------------------------------------------------
// RedisStreamsEventSink
// ---------------------------------------------------------------------------

export interface RedisStreamPublisher {
  publish(stream: string, event: V2SettlementEvent): Promise<string>;
}

export interface RedisStreamsEventSinkOptions {
  publisher: RedisStreamPublisher;
  /** Stream name. Default: `"pact-v2-settle-events"`. */
  stream?: string;
  onError?: (err: unknown) => void;
}

export class RedisStreamsEventSink implements EventSink {
  private readonly publisher: RedisStreamPublisher;
  private readonly stream: string;
  private readonly onError: (err: unknown) => void;

  constructor(opts: RedisStreamsEventSinkOptions) {
    this.publisher = opts.publisher;
    this.stream = opts.stream ?? "pact-v2-settle-events";
    this.onError =
      opts.onError ??
      ((err) => {
        // eslint-disable-next-line no-console
        console.warn("wrap-v2.RedisStreamsEventSink: publish failed", err);
      });
  }

  async publish(event: V2SettlementEvent): Promise<void> {
    try {
      await this.publisher.publish(this.stream, event);
    } catch (err) {
      this.onError(err);
    }
  }
}
