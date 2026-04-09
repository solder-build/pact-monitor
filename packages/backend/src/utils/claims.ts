import { query, getOne } from "../db.js";

const REFUND_PCT: Record<string, number> = {
  timeout: 100,
  error: 100,
  schema_mismatch: 75,
  latency_sla: 50,
};

interface ClaimInput {
  callRecordId: string;
  providerId: string;
  agentId: string | null;
  classification: string;
  paymentAmount: number | null;
}

export async function maybeCreateClaim(input: ClaimInput): Promise<string | null> {
  const { callRecordId, providerId, agentId, classification, paymentAmount } = input;

  if (classification === "success") return null;
  if (!paymentAmount || paymentAmount <= 0) return null;

  const triggerType = classification;
  const refundPct = REFUND_PCT[triggerType];
  if (refundPct === undefined) return null;

  const refundAmount = Math.round((paymentAmount * refundPct) / 100);

  const row = await getOne<{ id: string }>(
    `INSERT INTO claims (
      call_record_id, provider_id, agent_id, trigger_type,
      call_cost, refund_pct, refund_amount, status
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'simulated')
    RETURNING id`,
    [callRecordId, providerId, agentId, triggerType, paymentAmount, refundPct, refundAmount],
  );

  return row?.id ?? null;
}
