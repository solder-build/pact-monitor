// @pact-network/wrap-v2 — shared types.
//
// V2 differs from V1's wrap in three places:
//   * `EndpointConfig` (slug-keyed, flat premium) → `PolicyConfig`
//     (hostname-keyed + per-call premium derived from on-chain Pool rate).
//   * `SettlementEvent` carries V2's per-call settle inputs plus an optional
//     breach tail consumed by the claim cranker.
//   * `Outcome` is unchanged from V1 — same five values.

export type Outcome =
  | "ok"
  | "latency_breach"
  | "server_error"
  | "client_error"
  | "network_error";

/**
 * V2 TriggerType for `submit_claim`. Mirrors
 * `@q3labs/pact-protocol-v2-client/src/state.ts::TriggerType`.
 */
export type TriggerType = 0 | 1 | 2 | 3;
export const TRIGGER_TIMEOUT: TriggerType = 0;
export const TRIGGER_ERROR: TriggerType = 1;
export const TRIGGER_SCHEMA_MISMATCH: TriggerType = 2;
export const TRIGGER_LATENCY_SLA: TriggerType = 3;

/**
 * Wrap-relevant slice of a V2 (Pool, Policy) pair. The consumer pre-derives
 * the policy PDA and reads the pool's rate + cap; wrap does NOT load these
 * from chain itself — the consumer can cache them across many calls.
 */
export interface PolicyConfig {
  /** Provider hostname, e.g. "api.openai.com" — the V2 pool key. */
  hostname: string;
  /** Policy PDA, base58. Consumer derived via getPolicyPda(programId, pool, agent). */
  policyPda: string;
  /** SLA latency threshold in ms. Above this is `latency_breach`. */
  sla_latency_ms: number;
  /** From CoveragePool.insuranceRateBps. premium = callValue * rate / 10_000. */
  insurance_rate_bps: number;
  /** From CoveragePool.minPremiumBps. premium is floored at callValue * min / 10_000. */
  min_premium_bps: number;
  /** From CoveragePool.maxCoveragePerCall. Refund is min(paymentAmount, this). */
  max_coverage_per_call: bigint;
}

/**
 * V2 settlement event published fire-and-forget after every wrapped call.
 * Settler-v2 (oracle-cranker) consumes these — every event drives a
 * settle_premium ix; events with a populated breach tail also drive
 * submit_claim.
 *
 * bigint fields serialize as decimal strings (JSON-safe).
 */
export interface V2SettlementEvent {
  callId: string;
  agentPubkey: string;
  hostname: string;
  policyPda: string;
  /** Input to settle_premium. Bigint as decimal string. */
  callValue: string;
  latencyMs: number;
  outcome: Outcome;
  /** ISO-8601 timestamp at call completion. */
  ts: string;

  // ---- breach tail (only set when outcome != "ok" and refund > 0) ----
  /** Refund target (input to submit_claim's `paymentAmount`). */
  paymentAmount?: string;
  /** 32-byte sha256 hex of request + response fingerprint. */
  evidenceHash?: string;
  /** Upstream HTTP status code (0 for network_error). */
  statusCode?: number;
  /** TriggerType matching @q3labs/pact-protocol-v2-client TriggerType enum. */
  triggerType?: TriggerType;
  /** On-chain unix-second timestamp the cranker passes to submit_claim. */
  callTimestamp?: string;
}
