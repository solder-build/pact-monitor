// @pact-network/wrap-v2 — main entry point.
//
// Lifecycle:
//   1. generate callId
//   2. (optional) balance check vs premium (computed from callValue * rate);
//      short-circuits with 402 if agent's ATA delegation is insufficient
//   3. record t_start
//   4. forward fetch upstream; catch network errors as `network_error`
//   5. record t_end → latency
//   6. classify (response, latency, callValue, policy) → outcome + premium +
//      paymentAmount + triggerType
//   7. derive evidenceHash sha256(requestFingerprint || responseHash) if
//      paymentAmount > 0
//   8. fire-and-forget sink.publish(V2SettlementEvent) — failures swallowed
//   9. attach X-Pact-* headers
//   10. return result

import { sha256 } from "@noble/hashes/sha2";
import { attachPactHeaders } from "./headers";
import type { BalanceCheck, BalanceCheckResult } from "./balanceCheck";
import type { Classifier } from "./classifier";
import type { EventSink } from "./eventSink";
import type { Outcome, PolicyConfig, TriggerType, V2SettlementEvent } from "./types";

export interface V2WrapFetchOptions {
  hostname: string;
  walletPubkey: string;
  upstreamUrl: string;
  init?: RequestInit;
  classifier: Classifier;
  sink: EventSink;
  balanceCheck?: BalanceCheck;
  policyConfig: PolicyConfig;
  /** The value of THIS call, in lamports of the settlement mint. */
  callValue: bigint;
  /** Optional fetch override (tests). */
  fetchImpl?: typeof fetch;
  /** Optional clock override (tests). */
  now?: () => number;
  /** Optional callId override; if absent, one is generated. */
  callId?: string;
  /** Optional pool slug surfaced in X-Pact-Pool. */
  pool?: string;
}

export interface V2WrapFetchResult {
  response: Response;
  outcome: Outcome;
  premiumLamports: bigint;
  paymentAmountLamports: bigint;
  latencyMs: number;
  callId: string;
  triggerType?: TriggerType;
  evidenceHash?: string;
}

const ZERO = 0n;

export async function wrapFetch(
  opts: V2WrapFetchOptions
): Promise<V2WrapFetchResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const callId = opts.callId ?? generateCallId();

  // 1. Optional balance check. Required amount is the worst-case premium
  //    (callValue * insuranceRateBps / 10_000, floored at minPremiumBps).
  //    We do NOT include the breach refund here — that comes from the pool
  //    vault, not the agent's ATA.
  if (opts.balanceCheck) {
    const required = computeMaxPremium(opts.callValue, opts.policyConfig);
    let balance: BalanceCheckResult;
    try {
      balance = await opts.balanceCheck.check(opts.walletPubkey, required);
    } catch (err) {
      const body = JSON.stringify({
        error: "balance_check_failed",
        message: err instanceof Error ? err.message : String(err),
        callId,
      });
      const resp = attachPactHeaders(
        new Response(body, {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
        {
          callId,
          outcome: "server_error",
          premiumLamports: ZERO,
          paymentAmountLamports: ZERO,
          callValueLamports: opts.callValue,
          latencyMs: 0,
          hostname: opts.hostname,
          policyPda: opts.policyConfig.policyPda,
          pool: opts.pool,
        }
      );
      return {
        response: resp,
        outcome: "server_error",
        premiumLamports: ZERO,
        paymentAmountLamports: ZERO,
        latencyMs: 0,
        callId,
      };
    }

    if (!balance.eligible) {
      const body = JSON.stringify({
        error: "payment_required",
        reason: balance.reason,
        callId,
        ataBalance: balance.ataBalance?.toString(),
        allowance: balance.allowance?.toString(),
        requiredLamports: required.toString(),
      });
      const resp = attachPactHeaders(
        new Response(body, {
          status: 402,
          headers: { "content-type": "application/json" },
        }),
        {
          callId,
          outcome: "client_error",
          premiumLamports: ZERO,
          paymentAmountLamports: ZERO,
          callValueLamports: opts.callValue,
          latencyMs: 0,
          hostname: opts.hostname,
          policyPda: opts.policyConfig.policyPda,
          pool: opts.pool,
        }
      );
      return {
        response: resp,
        outcome: "client_error",
        premiumLamports: ZERO,
        paymentAmountLamports: ZERO,
        latencyMs: 0,
        callId,
      };
    }
  }

  // 2. Forward upstream with timing.
  const tStart = now();
  let upstreamResponse: Response | null = null;
  try {
    upstreamResponse = await fetchImpl(opts.upstreamUrl, opts.init);
  } catch {
    upstreamResponse = null;
  }
  const tEnd = now();
  const latencyMs = Math.max(0, tEnd - tStart);

  // 3. Classify.
  const classified = opts.classifier.classify({
    response: upstreamResponse,
    latencyMs,
    callValue: opts.callValue,
    policy: opts.policyConfig,
  });

  // 4. Evidence hash on breach.
  let evidenceHash: string | undefined;
  if (classified.paymentAmount > ZERO) {
    evidenceHash = deriveEvidenceHash({
      callId,
      upstreamUrl: opts.upstreamUrl,
      method: opts.init?.method ?? "GET",
      status: upstreamResponse?.status ?? 0,
      latencyMs,
    });
  }

  // 5. Fire-and-forget event publish.
  const event: V2SettlementEvent = {
    callId,
    agentPubkey: opts.walletPubkey,
    hostname: opts.hostname,
    policyPda: opts.policyConfig.policyPda,
    callValue: opts.callValue.toString(),
    latencyMs,
    outcome: classified.outcome,
    ts: new Date(tEnd).toISOString(),
  };
  if (classified.paymentAmount > ZERO) {
    event.paymentAmount = classified.paymentAmount.toString();
    event.evidenceHash = evidenceHash!;
    event.statusCode = classified.statusCode ?? upstreamResponse?.status ?? 0;
    event.triggerType = classified.triggerType!;
    event.callTimestamp = Math.floor(tEnd / 1000).toString();
  }
  try {
    void Promise.resolve(opts.sink.publish(event)).catch(() => {
      /* sinks swallow; this is the belt to their suspenders */
    });
  } catch {
    /* sync throw from sink.publish */
  }

  // 6. Shape response (synth 502 on network_error).
  const baseResponse =
    upstreamResponse ??
    new Response(JSON.stringify({ error: "upstream_unreachable", callId }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });

  const response = attachPactHeaders(baseResponse, {
    callId,
    outcome: classified.outcome,
    premiumLamports: classified.premium,
    paymentAmountLamports: classified.paymentAmount,
    callValueLamports: opts.callValue,
    latencyMs,
    hostname: opts.hostname,
    policyPda: opts.policyConfig.policyPda,
    pool: opts.pool,
    evidenceHash,
    settlementPending: true,
  });

  return {
    response,
    outcome: classified.outcome,
    premiumLamports: classified.premium,
    paymentAmountLamports: classified.paymentAmount,
    latencyMs,
    callId,
    triggerType: classified.triggerType,
    evidenceHash,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeMaxPremium(callValue: bigint, policy: PolicyConfig): bigint {
  if (callValue === ZERO) return ZERO;
  const rate = BigInt(Math.max(policy.insurance_rate_bps, 0));
  const floor = BigInt(Math.max(policy.min_premium_bps, 0));
  const gross = (callValue * rate) / 10_000n;
  const floored = (callValue * floor) / 10_000n;
  return gross > floored ? gross : floored;
}

function deriveEvidenceHash(input: {
  callId: string;
  upstreamUrl: string;
  method: string;
  status: number;
  latencyMs: number;
}): string {
  const payload = `${input.callId}|${input.method}|${input.upstreamUrl}|${input.status}|${input.latencyMs}`;
  const digest = sha256(new TextEncoder().encode(payload));
  return Array.from(digest)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function generateCallId(): string {
  const c: any =
    typeof globalThis !== "undefined" ? (globalThis as any).crypto : undefined;
  if (c && typeof c.randomUUID === "function") {
    return c.randomUUID();
  }
  const hex = (n: number) =>
    Math.floor(Math.random() * 0xffffffff)
      .toString(16)
      .padStart(8, "0")
      .slice(0, n);
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${hex(4)}-${hex(8)}${hex(4)}`;
}
