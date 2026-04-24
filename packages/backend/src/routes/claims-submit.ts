import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  submitClaimOnChain,
  hasActiveOnChainPolicy,
  type CallRecord,
} from "../services/claim-settlement.js";
import { query } from "../db.js";
import { requireApiKey } from "../middleware/auth.js";
import { canonicalHostname } from "../utils/hostname.js";

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
    { preHandler: requireApiKey },
    async (request, reply) => {
      const { callRecordId, providerHostname } = request.body ?? {};
      if (!callRecordId || !providerHostname) {
        return reply.code(400).send({
          error: "callRecordId and providerHostname are required",
        });
      }

      // The provider row's base_url is stored in canonical form (F2). SDK
      // clients may still send mixed-case or URL-with-path, so canonicalize
      // the incoming value before the equality check against api_provider.
      // TODO(F2 follow-up): trailing-dot variants (foo.com vs foo.com.) still
      // split into separate pools — see review flag #2.
      let canonicalProviderHostname: string;
      try {
        canonicalProviderHostname = canonicalHostname(providerHostname);
      } catch {
        return reply.code(400).send({ error: "Invalid providerHostname" });
      }

      const result = await query<CallRecordRow>(
        `SELECT cr.id,
                cr.agent_id,
                cr.agent_pubkey,
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
      const authed = request as FastifyRequest & { agentId: string };
      if (authed.agentId !== row.agent_id) {
        return reply.code(403).send({ error: "Forbidden" });
      }
      if (canonicalProviderHostname !== row.api_provider) {
        return reply.code(400).send({ error: "providerHostname does not match call record" });
      }
      if (!row.agent_pubkey) {
        return reply.code(400).send({ error: "Call record missing agent_pubkey" });
      }

      const hasPolicy = await hasActiveOnChainPolicy(row.agent_pubkey, canonicalProviderHostname);
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
        const settlement = await submitClaimOnChain(callRecord, canonicalProviderHostname);
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
