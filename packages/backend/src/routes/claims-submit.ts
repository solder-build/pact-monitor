import type { FastifyInstance } from "fastify";
import {
  submitClaimOnChain,
  hasActiveOnChainPolicy,
  type CallRecord,
} from "../services/claim-settlement.js";
import { query } from "../db.js";

interface CallRecordRow {
  id: string;
  agent_id: string;
  agent_pubkey: string | null;
  api_provider: string;
  payment_amount: number | null;
  latency_ms: number;
  status_code: number;
  classification: CallRecord["classification"];
  created_at: Date;
}

export async function claimsSubmitRoute(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { callRecordId: string; providerHostname: string } }>(
    "/api/v1/claims/submit",
    async (request, reply) => {
      const { callRecordId, providerHostname } = request.body ?? {};
      if (!callRecordId || !providerHostname) {
        return reply.code(400).send({
          error: "callRecordId and providerHostname are required",
        });
      }

      // Note: call_records does not currently have an `agent_pubkey` or
      // `api_provider` column — we select with COALESCE/JOIN fallbacks so
      // this route degrades gracefully until the Phase 3 migration lands.
      const result = await query<CallRecordRow>(
        `SELECT cr.id,
                cr.agent_id,
                NULL::text AS agent_pubkey,
                p.base_url AS api_provider,
                cr.payment_amount,
                cr.latency_ms,
                cr.status_code,
                cr.classification,
                cr.created_at
         FROM call_records cr
         JOIN providers p ON p.id = cr.provider_id
         WHERE cr.id = $1`,
        [callRecordId],
      );

      if (result.rows.length === 0) {
        return reply.code(404).send({ error: "Call record not found" });
      }

      const row = result.rows[0];
      if (!row.agent_pubkey) {
        return reply.code(400).send({ error: "Call record missing agent_pubkey" });
      }

      const hasPolicy = await hasActiveOnChainPolicy(row.agent_pubkey, providerHostname);
      if (!hasPolicy) {
        return reply.code(404).send({
          error: "No active on-chain policy for this agent/provider",
        });
      }

      const callRecord: CallRecord = {
        id: row.id,
        agent_id: row.agent_id,
        agent_pubkey: row.agent_pubkey,
        api_provider: row.api_provider,
        payment_amount: Number(row.payment_amount ?? 0),
        latency_ms: row.latency_ms,
        status_code: row.status_code,
        classification: row.classification,
        created_at: row.created_at,
      };

      try {
        const settlement = await submitClaimOnChain(callRecord, providerHostname);
        await query(
          `UPDATE claims
           SET tx_hash = $1,
               settlement_slot = $2,
               status = 'settled',
               policy_id = $3
           WHERE call_record_id = $4`,
          [settlement.signature, settlement.slot, settlement.claimPda, callRecordId],
        );
        return reply.send({
          signature: settlement.signature,
          slot: settlement.slot,
          refundAmount: settlement.refundAmount,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        request.log.error({ err }, "Claim settlement failed");
        return reply.code(500).send({
          error: "Claim settlement failed",
          details: message,
        });
      }
    },
  );
}
