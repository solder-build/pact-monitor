// Internal sandbox failure-injection driver (F3).
//
// Shared entry point that the HTTP route, scripting, and tests all go through.
// Wraps the existing on-chain settlement path in services/claim-settlement.ts
// (submitClaimOnChain) without touching packages/program/. Policy provisioning
// is intentionally OUT of the hot path — pool agents are pre-funded + pre-
// policied by scripts/topup-sandbox-pool.sh. If an agent has no active policy
// for a hostname at request time we return a structured PolicyNotProvisioned
// error (route translates to 503 with a provisioning hint).

import { randomUUID } from "node:crypto";
import type { Keypair } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import {
  submitClaimOnChain,
  hasActiveOnChainPolicy,
  type CallRecord,
} from "./claim-settlement.js";
import { derivePolicyPda, derivePoolPda, getSolanaConfig } from "../utils/solana.js";
import { canonicalHostname } from "../utils/hostname.js";

export type SandboxClassification =
  | "provider_5xx"
  | "provider_timeout"
  | "provider_rate_limit";

export const SANDBOX_CLASSIFICATIONS: readonly SandboxClassification[] = [
  "provider_5xx",
  "provider_timeout",
  "provider_rate_limit",
] as const;

export interface TriggerClaimDemoParams {
  hostname: string;
  classification: SandboxClassification;
  simulatedLatencyMs: number;
  agentKeypair: Keypair;
}

export interface TriggerClaimDemoResult {
  sandbox_policy_pda: string;
  sandbox_agent_pubkey: string;
  injected_failure: {
    classification: SandboxClassification;
    call_id: string;
    simulated_latency_ms: number;
  };
  claim: {
    tx_hash: string;
    refund_amount_usdc: string;
    settled_at: string;
  };
  explorer_url: string;
}

export class PolicyNotProvisionedError extends Error {
  constructor(agentPubkey: string, hostname: string) {
    super(
      `No active on-chain policy for sandbox agent ${agentPubkey} @ ${hostname}. ` +
        `Run scripts/topup-sandbox-pool.sh to provision.`,
    );
    this.name = "PolicyNotProvisionedError";
  }
}

// Map sandbox-facing classification to the CallRecord classification and
// synthetic HTTP status the on-chain trigger type expects. The 4 on-chain
// triggers in claim-settlement.ts:35 are `timeout | error | schema_mismatch
// | latency_sla`. `provider_rate_limit` maps to `error` with status 429 so
// on-chain accounting treats it the same as any other upstream failure.
function mapClassification(c: SandboxClassification): {
  callClassification: CallRecord["classification"];
  statusCode: number;
} {
  switch (c) {
    case "provider_5xx":
      return { callClassification: "error", statusCode: 503 };
    case "provider_timeout":
      return { callClassification: "timeout", statusCode: 0 };
    case "provider_rate_limit":
      return { callClassification: "error", statusCode: 429 };
  }
}

function buildExplorerUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}

/**
 * Internal: fire a synthetic failure claim on devnet on behalf of a pooled
 * agent keypair. No DB writes — this is a pure on-chain side effect observed
 * by the settlement service. Callers are expected to have gated on
 * `isDevnet()`, rate-limited the API key, and validated `classification`
 * against SANDBOX_CLASSIFICATIONS.
 */
export async function triggerClaimDemo(
  params: TriggerClaimDemoParams,
): Promise<TriggerClaimDemoResult> {
  const hostname = canonicalHostname(params.hostname);
  const agentPubkey = params.agentKeypair.publicKey.toBase58();

  // Pre-flight: is the pooled agent actually ready to receive a claim? If
  // topup-sandbox-pool.sh hasn't run against this hostname yet there's no
  // policy on-chain and submit_claim would revert with a confusing error.
  const hasPolicy = await hasActiveOnChainPolicy(agentPubkey, hostname);
  if (!hasPolicy) {
    throw new PolicyNotProvisionedError(agentPubkey, hostname);
  }

  // Build a synthetic CallRecord. `id` seeds the claim PDA, so a fresh uuid
  // per invocation guarantees a unique PDA even when the same pooled agent
  // is re-used against the same pool.
  const callId = randomUUID();
  const { callClassification, statusCode } = mapClassification(
    params.classification,
  );

  const callRecord: CallRecord = {
    id: callId,
    agent_id: `sandbox-${agentPubkey.slice(0, 8)}`,
    agent_pubkey: agentPubkey,
    api_provider: hostname,
    payment_amount: 100_000, // 0.1 USDC synthetic call cost
    latency_ms: params.simulatedLatencyMs,
    status_code: statusCode,
    classification: callClassification,
    created_at: new Date(),
  };

  const settlement = await submitClaimOnChain(callRecord, hostname);

  // Re-derive the policy PDA for the response (no extra RPC call required —
  // same input seeds as claim-settlement.ts).
  const { programId: programIdStr } = getSolanaConfig();
  const programId = new PublicKey(programIdStr);
  const [poolPda] = derivePoolPda(programId, hostname);
  const [policyPda] = derivePolicyPda(
    programId,
    poolPda,
    params.agentKeypair.publicKey,
  );

  // settlement.refundAmount is raw USDC (6-decimal). Format as a fixed-point
  // string to match the public-facing USDC convention used elsewhere in the
  // API (premium endpoint, partners endpoint).
  const refundUsdc = (settlement.refundAmount / 1_000_000).toFixed(6);

  return {
    sandbox_policy_pda: policyPda.toBase58(),
    sandbox_agent_pubkey: agentPubkey,
    injected_failure: {
      classification: params.classification,
      call_id: callId,
      simulated_latency_ms: params.simulatedLatencyMs,
    },
    claim: {
      tx_hash: settlement.signature,
      refund_amount_usdc: refundUsdc,
      settled_at: new Date().toISOString(),
    },
    explorer_url: buildExplorerUrl(settlement.signature),
  };
}
