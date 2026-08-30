// Minimal Redis-Streams consumer — same shape as V1 settler's
// RedisStreamsQueueConsumer minus the DLQ machinery. C4 may port DLQ
// handling if devnet ops need it; the V2 premium pipeline relies on Pub/Sub
// for production redelivery and the on-chain Claim PDA + V2PremiumAttempt
// ledger for retry idempotency.

import { Logger } from "@nestjs/common";
import type { Redis } from "ioredis";
import type { QueueConsumer, SettleMessage } from "./queue-consumer.interface";

type RawRedis = {
  call(command: string, ...args: (string | number)[]): Promise<unknown>;
};

const READ_BLOCK_MS = 5000;

export interface RedisStreamsQueueConsumerConfig {
  stream: string;
  group: string;
  consumerName?: string;
}

export class RedisStreamsQueueConsumer implements QueueConsumer {
  private readonly logger = new Logger(RedisStreamsQueueConsumer.name);
  private readonly queue: SettleMessage[] = [];
  private onEnqueue: ((msg: SettleMessage) => void) | null = null;
  private running = false;
  private pollLoop: Promise<void> | null = null;
  private readonly consumerName: string;

  constructor(
    private readonly client: Redis,
    private readonly config: RedisStreamsQueueConsumerConfig
  ) {
    this.consumerName = config.consumerName ?? `settler-v2-${process.pid}`;
  }

  async init(): Promise<void> {
    const raw = this.client as unknown as RawRedis;
    try {
      await raw.call(
        "XGROUP",
        "CREATE",
        this.config.stream,
        this.config.group,
        "$",
        "MKSTREAM"
      );
    } catch (err) {
      const message = (err as Error).message ?? "";
      if (!message.includes("BUSYGROUP")) throw err;
    }
    this.running = true;
    this.pollLoop = this.runPollLoop().catch((err) => {
      this.logger.error("Redis Streams poll loop crashed", err);
    });
  }

  async destroy(): Promise<void> {
    this.running = false;
    await this.pollLoop;
  }

  setEnqueueCallback(cb: (msg: SettleMessage) => void): void {
    this.onEnqueue = cb;
  }

  drain(): SettleMessage[] {
    return this.queue.splice(0, this.queue.length);
  }

  ack(messages: SettleMessage[]): void {
    for (const m of messages) m.ack();
  }
  nack(messages: SettleMessage[]): void {
    for (const m of messages) m.nack();
  }
  get queueLength(): number {
    return this.queue.length;
  }

  private async runPollLoop(): Promise<void> {
    const raw = this.client as unknown as RawRedis;
    while (this.running) {
      try {
        const result = (await raw.call(
          "XREADGROUP",
          "GROUP",
          this.config.group,
          this.consumerName,
          "BLOCK",
          READ_BLOCK_MS,
          "COUNT",
          16,
          "STREAMS",
          this.config.stream,
          ">"
        )) as Array<[string, Array<[string, string[]]>]> | null;
        if (!result) {
          await new Promise((r) => setImmediate(r));
          continue;
        }
        for (const [, entries] of result) {
          for (const [id, fields] of entries) {
            this.enqueueEntry(id, fields);
          }
        }
      } catch (err) {
        this.logger.error("XREADGROUP failed", err);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  private enqueueEntry(id: string, fields: string[]): void {
    const raw = this.client as unknown as RawRedis;
    let payload = "";
    for (let i = 0; i + 1 < fields.length; i += 2) {
      if (fields[i] === "event") {
        payload = fields[i + 1] ?? "";
        break;
      }
    }
    if (!payload) {
      void raw
        .call("XACK", this.config.stream, this.config.group, id)
        .catch((err) =>
          this.logger.error(`XACK on malformed entry ${id} failed`, err)
        );
      return;
    }
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(payload) as Record<string, unknown>;
    } catch (err) {
      void raw
        .call("XACK", this.config.stream, this.config.group, id)
        .catch((e) =>
          this.logger.error(`XACK on malformed entry ${id} failed`, e)
        );
      return;
    }
    const message: SettleMessage = {
      id,
      data,
      ack: () => {
        void raw
          .call("XACK", this.config.stream, this.config.group, id)
          .catch((err) => this.logger.error(`XACK ${id} failed`, err));
      },
      nack: () => {
        // No native nack; leave in PEL for XCLAIM redelivery.
      },
    };
    this.queue.push(message);
    this.onEnqueue?.(message);
  }
}
