export type Classification = "success" | "timeout" | "error" | "schema_mismatch";

export interface PaymentData {
  protocol: "x402" | "mpp";
  amount: number;
  asset: string;
  network: string;
  payerAddress: string;
  recipientAddress: string;
  txHash: string;
  settlementSuccess: boolean;
}

export interface CallRecord {
  hostname: string;
  endpoint: string;
  timestamp: string;
  statusCode: number;
  latencyMs: number;
  classification: Classification;
  payment: PaymentData | null;
  synced: boolean;
  agentPubkey?: string | null;
}

export interface PactConfig {
  apiKey?: string;
  backendUrl?: string;
  syncEnabled?: boolean;
  syncIntervalMs?: number;
  syncBatchSize?: number;
  latencyThresholdMs?: number;
  storagePath?: string;
  agentPubkey?: string;
}

export interface ExpectedSchema {
  type: string;
  required?: string[];
}

export interface FetchOptions extends RequestInit {
  // standard fetch options
}

export interface PactFetchOptions {
  expectedSchema?: ExpectedSchema;
  usdcAmount?: number;
}
