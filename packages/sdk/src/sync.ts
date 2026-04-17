import type { CallRecord } from "./types.js";
import type { PactStorage } from "./storage.js";
import { serializeRecords, createSignature } from "./signing.js";
import bs58 from "bs58";

export class PactSync {
  private storage: PactStorage;
  private backendUrl: string;
  private apiKey: string;
  private intervalMs: number;
  private batchSize: number;
  private readonly keypair: { publicKey: Uint8Array; secretKey: Uint8Array } | null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushInFlight: Promise<void> | null = null;

  constructor(
    storage: PactStorage,
    backendUrl: string,
    apiKey: string,
    intervalMs: number,
    batchSize: number,
    keypair: { publicKey: Uint8Array; secretKey: Uint8Array } | null,
  ) {
    this.storage = storage;
    this.backendUrl = backendUrl;
    this.apiKey = apiKey;
    this.intervalMs = intervalMs;
    this.batchSize = batchSize;
    this.keypair = keypair;
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
    // Re-entrancy guard: if a previous flush is still in flight (e.g. the
    // interval timer fired again, or shutdown() races with the timer), join
    // the existing promise instead of reading storage a second time. Two
    // parallel flushes would both getUnsynced() the same records and POST
    // them twice, creating duplicate call_records rows on the backend —
    // each deriving a distinct claim PDA via sha256 and settling a fresh
    // on-chain refund. Sequencing the flushes eliminates the duplication.
    if (this.flushInFlight) {
      return this.flushInFlight;
    }
    this.flushInFlight = this.doFlush().finally(() => {
      this.flushInFlight = null;
    });
    return this.flushInFlight;
  }

  private async doFlush(): Promise<void> {
    const unsynced = this.storage.getUnsynced();
    if (unsynced.length === 0) return;

    const batch = unsynced.slice(0, this.batchSize);
    const records = batch.map((r) => ({
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
    }));

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };

    if (this.keypair) {
      try {
        const serialized = serializeRecords(records);
        headers["X-Pact-Signature"] = createSignature(serialized, this.keypair.secretKey);
        headers["X-Pact-Pubkey"] = bs58.encode(this.keypair.publicKey);
      } catch (err) {
        console.warn("[pact-monitor] record signing failed, sending unsigned:", (err as Error).message);
      }
    }

    const response = await globalThis.fetch(`${this.backendUrl}/api/v1/records`, {
      method: "POST",
      headers,
      body: JSON.stringify({ records }),
    });

    if (response.ok) {
      this.storage.markSynced(batch.length);
    }
  }
}
