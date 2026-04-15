import type { FastifyInstance, FastifyRequest } from "fastify";
import { requireApiKey } from "../middleware/auth.js";
import { query, getOne } from "../db.js";
import { maybeCreateClaim } from "../utils/claims.js";

interface RecordInput {
  hostname: string;
  endpoint: string;
  timestamp: string;
  status_code: number;
  latency_ms: number;
  classification: "success" | "timeout" | "error" | "schema_mismatch";
  payment_protocol?: "x402" | "mpp" | null;
  payment_amount?: number | null;
  payment_asset?: string | null;
  payment_network?: string | null;
  payer_address?: string | null;
  recipient_address?: string | null;
  tx_hash?: string | null;
  settlement_success?: boolean | null;
}

interface RecordsBody {
  records: RecordInput[];
}

async function findOrCreateProvider(hostname: string): Promise<string> {
  const existing = await getOne<{ id: string }>(
    "SELECT id FROM providers WHERE base_url = $1",
    [hostname],
  );
  if (existing) return existing.id;

  const created = await getOne<{ id: string }>(
    "INSERT INTO providers (name, base_url) VALUES ($1, $2) ON CONFLICT (base_url) DO UPDATE SET base_url = EXCLUDED.base_url RETURNING id",
    [hostname, hostname],
  );
  return created!.id;
}

export async function recordsRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: RecordsBody }>(
    "/api/v1/records",
    { preHandler: requireApiKey },
    async (request, reply) => {
      const { records } = request.body;

      if (!records || !Array.isArray(records) || records.length === 0) {
        return reply.code(400).send({ error: "records array is required" });
      }

      const authed = request as FastifyRequest & {
        agentId: string;
        agentPubkey: string | null;
      };
      const agentId = authed.agentId;
      const agentPubkey = authed.agentPubkey;
      const providerIds = new Set<string>();
      let accepted = 0;

      for (const rec of records) {
        const providerId = await findOrCreateProvider(rec.hostname);
        providerIds.add(providerId);

        // ON CONFLICT DO NOTHING on the partial unique index
        // idx_call_records_agent_idempotency. If the SDK re-flushes the same
        // record (agent_pubkey, timestamp, endpoint) on a subsequent sync
        // cycle, the second INSERT is a no-op, RETURNING returns zero rows,
        // and we skip both `accepted` and `maybeCreateClaim` for this record.
        // Anonymous traffic (agent_pubkey IS NULL) is not covered by the
        // partial index, so it retains the old at-most-once-per-POST semantics.
        const insertResult = await query<{ id: string }>(
          `INSERT INTO call_records (
            provider_id, endpoint, timestamp, status_code, latency_ms,
            classification, payment_protocol, payment_amount, payment_asset,
            payment_network, payer_address, recipient_address, tx_hash,
            settlement_success, agent_id, agent_pubkey
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
          ON CONFLICT (agent_pubkey, timestamp, endpoint)
            WHERE agent_pubkey IS NOT NULL
            DO NOTHING
          RETURNING id`,
          [
            providerId, rec.endpoint, rec.timestamp, rec.status_code,
            rec.latency_ms, rec.classification, rec.payment_protocol ?? null,
            rec.payment_amount ?? null, rec.payment_asset ?? null,
            rec.payment_network ?? null, rec.payer_address ?? null,
            rec.recipient_address ?? null, rec.tx_hash ?? null,
            rec.settlement_success ?? null, agentId, agentPubkey,
          ],
        );

        if (insertResult.rows.length === 0) {
          app.log.debug(
            { agentPubkey, timestamp: rec.timestamp, endpoint: rec.endpoint },
            "duplicate call_record skipped (SDK re-flush)",
          );
          continue;
        }

        const callRecordId = insertResult.rows[0].id;

        await maybeCreateClaim({
          callRecordId,
          providerId,
          agentId,
          classification: rec.classification,
          paymentAmount: rec.payment_amount ?? null,
          agentPubkey,
          providerHostname: rec.hostname,
          latencyMs: rec.latency_ms,
          statusCode: rec.status_code,
          createdAt: new Date(rec.timestamp),
          logger: app.log,
        });

        accepted++;
      }

      // Update provider wallet_address from payment data if available
      for (const rec of records) {
        if (rec.recipient_address) {
          await query(
            "UPDATE providers SET wallet_address = $1 WHERE base_url = $2 AND wallet_address IS NULL",
            [rec.recipient_address, rec.hostname],
          );
        }
      }

      return { accepted, provider_ids: [...providerIds] };
    },
  );
}
