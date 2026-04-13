import { EventEmitter } from "events";
import type { CallRecord, PactConfig, PactFetchOptions } from "./types.js";
import { classify } from "./classifier.js";
import { extractPaymentData, enrichWithManualAmount } from "./payment-extractor.js";
import { PactStorage } from "./storage.js";
import { PactSync } from "./sync.js";

export class PactMonitor {
  private config: Required<PactConfig>;
  private storage: PactStorage;
  private sync: PactSync | null = null;
  private events = new EventEmitter();

  constructor(config: PactConfig = {}) {
    this.config = {
      apiKey: config.apiKey || "",
      backendUrl: config.backendUrl || "https://pactnetwork.io",
      syncEnabled: config.syncEnabled ?? false,
      syncIntervalMs: config.syncIntervalMs ?? 30_000,
      syncBatchSize: config.syncBatchSize ?? 100,
      latencyThresholdMs: config.latencyThresholdMs ?? 5_000,
      storagePath: config.storagePath || "",
      agentPubkey: config.agentPubkey || "",
    };

    this.storage = new PactStorage(this.config.storagePath || undefined);

    if (this.config.syncEnabled && this.config.apiKey) {
      this.sync = new PactSync(
        this.storage,
        this.config.backendUrl,
        this.config.apiKey,
        this.config.syncIntervalMs,
        this.config.syncBatchSize,
      );
      this.sync.start();
    }
  }

  async fetch(
    url: string | URL,
    init?: RequestInit,
    pactOptions?: PactFetchOptions,
  ): Promise<Response> {
    const urlStr = url.toString();
    const parsed = new URL(urlStr);
    const hostname = parsed.hostname;
    const endpoint = parsed.pathname;

    const start = Date.now();
    let response: Response;
    let networkError = false;

    try {
      response = await globalThis.fetch(url, init);
    } catch (err) {
      networkError = true;
      // Record the failure but rethrow so the agent sees the original error
      const latencyMs = Date.now() - start;
      try {
        this.recordCall(hostname, endpoint, 0, latencyMs, networkError, null, null, pactOptions);
      } catch { /* golden rule: never break the agent */ }
      throw err;
    }

    const latencyMs = Date.now() - start;

    try {
      let body: unknown;
      if (pactOptions?.expectedSchema) {
        try {
          body = await response.clone().json();
        } catch {
          body = undefined;
        }
      }

      this.recordCall(
        hostname, endpoint, response.status, latencyMs,
        networkError, response.headers, body, pactOptions,
      );
    } catch { /* golden rule: never break the agent */ }

    return response;
  }

  private recordCall(
    hostname: string,
    endpoint: string,
    statusCode: number,
    latencyMs: number,
    networkError: boolean,
    headers: Headers | null,
    body: unknown,
    pactOptions?: PactFetchOptions,
  ): void {
    const classification = classify(
      statusCode,
      latencyMs,
      this.config.latencyThresholdMs,
      body,
      pactOptions?.expectedSchema,
      networkError,
    );

    let payment = headers ? extractPaymentData(headers) : null;
    payment = enrichWithManualAmount(payment, pactOptions?.usdcAmount);

    const record: CallRecord = {
      hostname,
      endpoint,
      timestamp: new Date().toISOString(),
      statusCode,
      latencyMs,
      classification,
      payment,
      synced: false,
      agentPubkey: this.config.agentPubkey || null,
    };

    this.storage.append(record);

    if (record.classification !== "success") {
      this.events.emit("failure", record);
    }
    this.events.emit("billed", { callCost: payment?.amount ?? 0 });
  }

  on(event: "failure", listener: (record: CallRecord) => void): this;
  on(event: "billed", listener: (payload: { callCost: number }) => void): this;
  on(event: string, listener: (...args: any[]) => void): this {
    this.events.on(event, listener);
    return this;
  }

  off(event: string, listener: (...args: any[]) => void): this {
    this.events.off(event, listener);
    return this;
  }

  emit(event: string, ...args: any[]): boolean {
    return this.events.emit(event, ...args);
  }

  getStats() {
    return this.storage.getStats();
  }

  getRecords(options?: { limit?: number; provider?: string }) {
    return this.storage.getRecords(options);
  }

  shutdown(): void {
    if (this.sync) {
      this.sync.flush();
      this.sync.stop();
    }
  }
}
