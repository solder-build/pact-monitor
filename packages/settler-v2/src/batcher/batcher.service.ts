// V2 BatcherService — groups V2SettlementEvent messages by `policyPda`'s
// parent pool so multiple `settle_premium` ix can pack into one tx with
// shared (config, pool, vault, treasuryAta, oracle, token_program) accounts.
//
// Key V2 differences from V1 batcher:
//   * grouping key is `hostname` (proxy for pool_pda — events carry it
//     directly), not a global sequence. A flushed batch has uniform pool.
//   * zero-callValue events are still acked-and-dropped at the boundary
//     (V2 program rejects with InvalidArgument for callValue=0).
//   * "ok" events still flow through — every successful call also settles
//     premium on-chain in V2.
//   * max ix per tx is read from ConfigService (MAX_IXS_PER_TX, default 6).
//     Per-pool buffers flush independently when they hit the cap.

import { Inject, Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SettleMessage } from "../consumer/consumer.service";

export interface SettleBatch {
  /** Provider hostname — uniform across `messages`. */
  hostname: string;
  messages: SettleMessage[];
}

export const BATCHER_DEFAULTS = {
  MAX_IXS_PER_TX: 6,
  FLUSH_INTERVAL_MS: 5000,
};

@Injectable()
export class BatcherService implements OnModuleDestroy {
  private readonly logger = new Logger(BatcherService.name);
  private readonly buffers = new Map<string, SettleMessage[]>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private onFlush: ((batch: SettleBatch) => Promise<void>) | null = null;
  private readonly maxIxs: number;
  private readonly flushIntervalMs: number;

  constructor(@Inject(ConfigService) config: ConfigService) {
    this.maxIxs =
      Number(config.get("MAX_IXS_PER_TX")) || BATCHER_DEFAULTS.MAX_IXS_PER_TX;
    this.flushIntervalMs =
      Number(config.get("FLUSH_INTERVAL_MS")) ||
      BATCHER_DEFAULTS.FLUSH_INTERVAL_MS;
  }

  setFlushCallback(cb: (batch: SettleBatch) => Promise<void>): void {
    this.onFlush = cb;
  }

  push(message: SettleMessage): void {
    const data = message.data as Record<string, unknown>;
    const hostname = (data["hostname"] as string | undefined) ?? "";
    const callValueRaw =
      (data["callValue"] as string | undefined) ?? "0";

    // Drop zero-value events at the boundary. The V2 program rejects
    // callValue=0 inside settle_premium; leaving these in a batch would
    // nack-loop and infinite-redeliver.
    let callValue: bigint;
    try {
      callValue = BigInt(callValueRaw);
    } catch {
      this.logger.warn(
        `Dropping event ${data["callId"]} with non-numeric callValue=${callValueRaw}`
      );
      message.ack();
      return;
    }
    if (callValue === 0n) {
      this.logger.debug(
        `Skipping zero-callValue event ${data["callId"]} outcome=${data["outcome"]}`
      );
      message.ack();
      return;
    }
    if (!hostname) {
      this.logger.warn(
        `Dropping event ${data["callId"]} missing hostname; cannot route`
      );
      message.ack();
      return;
    }

    let buf = this.buffers.get(hostname);
    if (!buf) {
      buf = [];
      this.buffers.set(hostname, buf);
    }
    buf.push(message);

    // Arm a per-pool flush timer once the buffer becomes non-empty.
    if (buf.length === 1) {
      const timer = setTimeout(() => {
        void this.flushHostname(hostname);
      }, this.flushIntervalMs);
      this.timers.set(hostname, timer);
    }

    if (buf.length >= this.maxIxs) {
      this.cancelTimer(hostname);
      void this.flushHostname(hostname);
    }
  }

  /** Force flush of every per-hostname buffer (used on shutdown). */
  async flushNow(): Promise<void> {
    const hosts = Array.from(this.buffers.keys());
    await Promise.all(hosts.map((h) => this.flushHostname(h)));
  }

  /** Flush a single hostname buffer. Idempotent — empty buffers no-op. */
  private async flushHostname(hostname: string): Promise<void> {
    this.cancelTimer(hostname);
    const buf = this.buffers.get(hostname);
    if (!buf || buf.length === 0) {
      this.buffers.delete(hostname);
      return;
    }
    const messages = buf.splice(0, buf.length);
    this.buffers.delete(hostname);

    const batch: SettleBatch = { hostname, messages };
    this.logger.log(
      `Flushing ${messages.length} settle_premium events for hostname=${hostname}`
    );

    if (this.onFlush) {
      await this.onFlush(batch);
    }
  }

  async onModuleDestroy(): Promise<void> {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    await this.flushNow();
  }

  private cancelTimer(hostname: string): void {
    const t = this.timers.get(hostname);
    if (t !== undefined) {
      clearTimeout(t);
      this.timers.delete(hostname);
    }
  }

  /** Total pending events across all hostnames. */
  get pendingCount(): number {
    let sum = 0;
    for (const b of this.buffers.values()) sum += b.length;
    return sum;
  }
}
