import type { CallRecord } from "./types.js";
import type { PactStorage } from "./storage.js";

export class PactSync {
  private storage: PactStorage;
  private backendUrl: string;
  private apiKey: string;
  private intervalMs: number;
  private batchSize: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    storage: PactStorage,
    backendUrl: string,
    apiKey: string,
    intervalMs: number,
    batchSize: number,
  ) {
    this.storage = storage;
    this.backendUrl = backendUrl;
    this.apiKey = apiKey;
    this.intervalMs = intervalMs;
    this.batchSize = batchSize;
  }

  start(): void {
    this.timer = setInterval(() => {
      this.flush().catch(() => { /* retry next interval */ });
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async flush(): Promise<void> {
    const unsynced = this.storage.getUnsynced();
    if (unsynced.length === 0) return;

    const batch = unsynced.slice(0, this.batchSize);
    const payload = {
      records: batch.map((r) => ({
        hostname: r.hostname,
        endpoint: r.endpoint,
        timestamp: r.timestamp,
        status_code: r.statusCode,
        latency_ms: r.latencyMs,
        classification: r.classification,
        payment_protocol: r.payment?.protocol ?? null,
        payment_amount: r.payment?.amount ?? null,
        payment_asset: r.payment?.asset ?? null,
        payment_network: r.payment?.network ?? null,
        payer_address: r.payment?.payerAddress ?? null,
        recipient_address: r.payment?.recipientAddress ?? null,
        tx_hash: r.payment?.txHash ?? null,
        settlement_success: r.payment?.settlementSuccess ?? null,
        agent_pubkey: r.agentPubkey ?? null,
      })),
    };

    const response = await globalThis.fetch(`${this.backendUrl}/api/v1/records`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (response.ok) {
      this.storage.markSynced(batch.length);
    }
  }
}
