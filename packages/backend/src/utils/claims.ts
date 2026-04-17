import { query, getOne } from "../db.js";
import {
  submitClaimOnChain,
  hasActiveOnChainPolicy,
  type CallRecord,
} from "../services/claim-settlement.js";
import { hasPendingFlag } from "./fraud-detection.js";

const REFUND_PCT: Record<string, number> = {
  timeout: 100,
  error: 100,
  schema_mismatch: 75,
  latency_sla: 50,
};

interface MinimalLogger {
  warn: (obj: unknown, msg?: string) => void;
  error?: (obj: unknown, msg?: string) => void;
}

interface ClaimInput {
  callRecordId: string;
  providerId: string;
  agentId: string | null;
  classification: string;
  paymentAmount: number | null;
  // Optional Phase 3 fields — when provided, we attempt an on-chain
  // settlement in addition to the DB claim row. The SDK/records route will
  // start populating these once Phase 3 lands end-to-end.
  agentPubkey?: string | null;
  providerHostname?: string | null;
  latencyMs?: number | null;
  statusCode?: number | null;
  createdAt?: Date | null;
  logger?: MinimalLogger;
}

export async function maybeCreateClaim(input: ClaimInput): Promise<string | null> {
  const { callRecordId, providerId, agentId, classification, paymentAmount } = input;

  if (classification === "success") return null;
  if (!paymentAmount || paymentAmount <= 0) return null;

  // Anti-fraud: skip claim if agent is flagged (persist audit row)
  if (input.agentId) {
    const flagged = await hasPendingFlag(input.agentId);
    if (flagged) {
      input.logger?.warn(
        { agentId: input.agentId },
        "Skipping claim creation: agent is flagged",
      );
      await query(
        `INSERT INTO claims (call_record_id, provider_id, agent_id, trigger_type, call_cost, refund_pct, refund_amount, status)
         VALUES ($1, $2, $3, $4, $5, 0, 0, 'frozen')`,
        [callRecordId, providerId, agentId, classification, paymentAmount],
      );
      return null;
    }
  }

  // Anti-fraud: daily claim cap per agent
  if (input.agentId) {
    const dailyCount = await getOne<{ cnt: string }>(
      "SELECT COUNT(*) AS cnt FROM claims WHERE agent_id = $1 AND status != 'frozen' AND created_at > NOW() - INTERVAL '1 day'",
      [input.agentId],
    );
    const count = parseInt(dailyCount?.cnt ?? "0", 10);
    if (count >= 1000) {
      input.logger?.warn(
        { agentId: input.agentId, dailyClaims: count },
        "Skipping claim creation: daily cap reached (1000)",
      );
      return null;
    }
  }

  const triggerType = classification;
  const refundPct = REFUND_PCT[triggerType];
  if (refundPct === undefined) return null;

  // Clamp the pre-chain optimistic refund at a sane ceiling. The on-chain
  // program has its own tighter per-pool cap (max_coverage_per_call) which
  // wins on real settlement, but this clamp prevents an SDK unit-mistake
  // from ever rendering "2000000.00 USDC" in the scorecard. 1000 USDC is
  // well above any sane single API call cost.
  const MAX_SIMULATED_CALL_LAMPORTS = 1_000_000_000; // 1000 USDC
  const clampedCallCost = Math.min(paymentAmount, MAX_SIMULATED_CALL_LAMPORTS);
  const refundAmount = Math.min(
    Math.round((clampedCallCost * refundPct) / 100),
    MAX_SIMULATED_CALL_LAMPORTS,
  );

  const row = await getOne<{ id: string }>(
    `INSERT INTO claims (
      call_record_id, provider_id, agent_id, trigger_type,
      call_cost, refund_pct, refund_amount, status
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'simulated')
    RETURNING id`,
    [callRecordId, providerId, agentId, triggerType, clampedCallCost, refundPct, refundAmount],
  );

  const claimRowId = row?.id ?? null;

  // Non-blocking on-chain settlement attempt. Gated on agentPubkey +
  // providerHostname being provided by the caller — until the Phase 3 SDK
  // pivot lands, records.ts does not populate these and this branch is a
  // no-op.
  if (
    claimRowId &&
    input.agentPubkey &&
    input.providerHostname &&
    triggerType !== "success"
  ) {
    try {
      const hasPolicy = await hasActiveOnChainPolicy(
        input.agentPubkey,
        input.providerHostname,
      );
      if (hasPolicy) {
        const callRecord: CallRecord = {
          id: callRecordId,
          agent_id: agentId ?? "",
          agent_pubkey: input.agentPubkey,
          api_provider: input.providerHostname,
          payment_amount: paymentAmount,
          latency_ms: input.latencyMs ?? 0,
          status_code: input.statusCode ?? 0,
          classification: classification as CallRecord["classification"],
          created_at: input.createdAt ?? new Date(),
        };
        const result = await submitClaimOnChain(callRecord, input.providerHostname);
        // Reconcile: overwrite refund_amount with the ACTUAL on-chain value.
        // The program caps refund at min(payment_amount, max_coverage_per_call,
        // total_available), so the pre-chain optimistic estimate is usually
        // too high. Storing the real value keeps the scorecard honest.
        await query(
          `UPDATE claims
           SET tx_hash = $1,
               settlement_slot = $2,
               status = 'settled',
               policy_id = $3,
               refund_amount = $5
           WHERE id = $4`,
          [
            result.signature,
            result.slot,
            result.claimPda,
            claimRowId,
            result.refundAmount,
          ],
        );
      }
    } catch (err) {
      // Log but don't fail — DB claim row stays at status='simulated' so
      // it can be retried via POST /api/v1/claims/submit.
      input.logger?.warn(
        { err, callRecordId },
        "On-chain claim submission failed; claim remains simulated",
      );
    }
  }

  return claimRowId;
}
