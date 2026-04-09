import type { FastifyInstance } from "fastify";
import { getMany } from "../db.js";

export async function claimsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Querystring: {
      provider_id?: string;
      agent_id?: string;
      trigger_type?: string;
      limit?: string;
      offset?: string;
    };
  }>("/api/v1/claims", async (request) => {
    const limit = Math.min(parseInt(request.query.limit || "50", 10), 200);
    const offset = parseInt(request.query.offset || "0", 10);

    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (request.query.provider_id) {
      conditions.push(`c.provider_id = $${paramIndex++}`);
      params.push(request.query.provider_id);
    }
    if (request.query.agent_id) {
      conditions.push(`c.agent_id = $${paramIndex++}`);
      params.push(request.query.agent_id);
    }
    if (request.query.trigger_type) {
      conditions.push(`c.trigger_type = $${paramIndex++}`);
      params.push(request.query.trigger_type);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    params.push(limit);
    const limitParam = `$${paramIndex++}`;
    params.push(offset);
    const offsetParam = `$${paramIndex++}`;

    const rows = await getMany<{
      id: string;
      call_record_id: string;
      provider_id: string;
      provider_name: string;
      agent_id: string | null;
      trigger_type: string;
      call_cost: string | null;
      refund_pct: string;
      refund_amount: string | null;
      status: string;
      created_at: string;
    }>(`
      SELECT
        c.id, c.call_record_id, c.provider_id, p.name AS provider_name,
        c.agent_id, c.trigger_type, c.call_cost::text, c.refund_pct::text,
        c.refund_amount::text, c.status, c.created_at
      FROM claims c
      JOIN providers p ON p.id = c.provider_id
      ${where}
      ORDER BY c.created_at DESC
      LIMIT ${limitParam} OFFSET ${offsetParam}
    `, params);

    return rows.map((r) => ({
      id: r.id,
      call_record_id: r.call_record_id,
      provider_id: r.provider_id,
      provider_name: r.provider_name,
      agent_id: r.agent_id,
      trigger_type: r.trigger_type,
      call_cost: r.call_cost ? parseInt(r.call_cost, 10) : null,
      refund_pct: parseInt(r.refund_pct, 10),
      refund_amount: r.refund_amount ? parseInt(r.refund_amount, 10) : null,
      status: r.status,
      created_at: r.created_at,
    }));
  });
}
