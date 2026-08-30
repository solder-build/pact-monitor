// @pact-network/wrap-v2 — outcome classifier.
//
// V2 premium math:
//   gross_premium = max(callValue * insuranceRateBps / 10_000,
//                       callValue * minPremiumBps / 10_000)
//
// V2 refund math (on breach):
//   refund = min(callValue, maxCoveragePerCall)
//
// The classifier produces `(outcome, premium, paymentAmount, triggerType)`.
// `paymentAmount` is the *input* to submit_claim (the cranker decides the
// final refund clamp on-chain). For non-breach calls premium is still
// charged but paymentAmount is omitted.

import {
  Outcome,
  PolicyConfig,
  TriggerType,
  TRIGGER_ERROR,
  TRIGGER_LATENCY_SLA,
  TRIGGER_TIMEOUT,
} from "./types";

export interface ClassifierInput {
  /** Upstream Response. `null` if upstream threw (network_error path). */
  response: Response | null;
  latencyMs: number;
  /** The cost/value of THIS API call in lamports of the settlement mint. */
  callValue: bigint;
  policy: Pick<
    PolicyConfig,
    "sla_latency_ms" | "insurance_rate_bps" | "min_premium_bps" | "max_coverage_per_call"
  >;
}

export interface ClassifierResult {
  outcome: Outcome;
  /** Charged via settle_premium (always — including on breach, see H-05). */
  premium: bigint;
  /** Refund target input to submit_claim. Zero when outcome="ok" or "client_error". */
  paymentAmount: bigint;
  /** Set only when paymentAmount > 0. */
  triggerType?: TriggerType;
  /** Set only when paymentAmount > 0. */
  statusCode?: number;
}

export interface Classifier {
  classify(input: ClassifierInput): ClassifierResult;
}

const ZERO = 0n;
const TEN_THOUSAND = 10_000n;

function computePremium(callValue: bigint, rateBps: number, minBps: number): bigint {
  if (callValue === ZERO) return ZERO;
  const rate = BigInt(Math.max(rateBps, 0));
  const floor = BigInt(Math.max(minBps, 0));
  const gross = (callValue * rate) / TEN_THOUSAND;
  const floored = (callValue * floor) / TEN_THOUSAND;
  return gross > floored ? gross : floored;
}

function clampRefund(callValue: bigint, cap: bigint): bigint {
  if (callValue <= ZERO) return ZERO;
  if (cap <= ZERO) return ZERO;
  return callValue < cap ? callValue : cap;
}

/**
 * Default V2 classifier:
 * - network error / no response  → server_error, premium charged, refund=cap(callValue), trigger=Timeout
 * - 5xx                          → server_error, premium charged, refund=cap(callValue), trigger=Error
 * - 429 / 4xx                    → client_error, premium=0, refund=0 (agent's fault)
 * - 2xx + latency > sla          → latency_breach, premium charged, refund=cap, trigger=LatencySla
 * - 2xx + latency <= sla         → ok, premium charged, refund=0
 * - 3xx / other                  → ok, premium charged, refund=0
 *
 * NB: premium IS charged on server_error / latency_breach (V2 H-05 confirmed:
 * settle_premium does NOT gate on policy.active, and the design is "policy
 * fee is owed on every call covered by the insurance, breach or not").
 */
export const defaultClassifier: Classifier = {
  classify({ response, latencyMs, callValue, policy }: ClassifierInput): ClassifierResult {
    const premium = computePremium(
      callValue,
      policy.insurance_rate_bps,
      policy.min_premium_bps
    );
    const cap = policy.max_coverage_per_call;

    if (response === null) {
      return {
        outcome: "network_error",
        premium,
        paymentAmount: clampRefund(callValue, cap),
        triggerType: TRIGGER_TIMEOUT,
        statusCode: 0,
      };
    }

    const status = response.status;
    if (status >= 500 && status <= 599) {
      return {
        outcome: "server_error",
        premium,
        paymentAmount: clampRefund(callValue, cap),
        triggerType: TRIGGER_ERROR,
        statusCode: status,
      };
    }
    if (status >= 400 && status <= 499) {
      // Agent's fault — no premium charged, no refund owed.
      return { outcome: "client_error", premium: ZERO, paymentAmount: ZERO };
    }
    if (status >= 200 && status <= 299) {
      if (latencyMs > policy.sla_latency_ms) {
        return {
          outcome: "latency_breach",
          premium,
          paymentAmount: clampRefund(callValue, cap),
          triggerType: TRIGGER_LATENCY_SLA,
          statusCode: status,
        };
      }
      return { outcome: "ok", premium, paymentAmount: ZERO };
    }
    // 3xx + odd codes: treat as ok (premium charged, no refund).
    return { outcome: "ok", premium, paymentAmount: ZERO };
  },
};

/**
 * Compose a per-endpoint plugin with the default. Mirrors V1's
 * composeWithDefault — plugin returns null to defer to the default rules.
 */
export function composeWithDefault(
  pluginFn: (input: ClassifierInput) => ClassifierResult | null
): Classifier {
  return {
    classify(input: ClassifierInput): ClassifierResult {
      const pluginResult = pluginFn(input);
      if (pluginResult !== null) return pluginResult;
      return defaultClassifier.classify(input);
    },
  };
}

export { computePremium, clampRefund };
