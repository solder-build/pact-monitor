// @pact-network/wrap-v2 — X-Pact-* response headers.
//
// Identical headers to V1 plus three V2 additions (hostname, policy PDA, and
// breach evidence digest). Headers are set on a NEW Response — original is
// not mutated.

import type { Outcome } from "./types";

export const HEADERS = {
  PREMIUM: "X-Pact-Premium",
  REFUND: "X-Pact-Refund",
  LATENCY_MS: "X-Pact-Latency-Ms",
  OUTCOME: "X-Pact-Outcome",
  POOL: "X-Pact-Pool",
  HOSTNAME: "X-Pact-Hostname",
  POLICY: "X-Pact-Policy",
  EVIDENCE_HASH: "X-Pact-Evidence",
  SETTLEMENT_PENDING: "X-Pact-Settlement-Pending",
  CALL_ID: "X-Pact-Call-Id",
  CALL_VALUE: "X-Pact-Call-Value",
} as const;

export interface PactHeaderInputs {
  callId: string;
  outcome: Outcome;
  premiumLamports: bigint;
  paymentAmountLamports: bigint;
  callValueLamports: bigint;
  latencyMs: number;
  hostname?: string;
  policyPda?: string;
  pool?: string;
  evidenceHash?: string;
  settlementPending?: boolean;
}

export function attachPactHeaders(
  response: Response,
  inputs: PactHeaderInputs
): Response {
  const headers = new Headers(response.headers);
  headers.set(HEADERS.PREMIUM, inputs.premiumLamports.toString());
  headers.set(HEADERS.REFUND, inputs.paymentAmountLamports.toString());
  headers.set(HEADERS.LATENCY_MS, inputs.latencyMs.toString());
  headers.set(HEADERS.OUTCOME, inputs.outcome);
  headers.set(HEADERS.CALL_VALUE, inputs.callValueLamports.toString());
  if (inputs.hostname !== undefined) headers.set(HEADERS.HOSTNAME, inputs.hostname);
  if (inputs.policyPda !== undefined) headers.set(HEADERS.POLICY, inputs.policyPda);
  if (inputs.pool !== undefined) headers.set(HEADERS.POOL, inputs.pool);
  if (inputs.evidenceHash !== undefined) {
    headers.set(HEADERS.EVIDENCE_HASH, inputs.evidenceHash);
  }
  if (inputs.settlementPending) headers.set(HEADERS.SETTLEMENT_PENDING, "1");
  headers.set(HEADERS.CALL_ID, inputs.callId);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
