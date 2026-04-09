import type { FastifyInstance } from "fastify";
import { getOne, getMany } from "../db.js";

export async function analyticsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/analytics/summary", async () => {
    const stats = await getOne<{
      total_sdk_requests: string;
      unique_agents: string;
      unique_providers: string;
    }>(`
      SELECT
        COUNT(*)::text AS total_sdk_requests,
        COUNT(DISTINCT agent_id)::text AS unique_agents,
        COUNT(DISTINCT provider_id)::text AS unique_providers
      FROM call_records
    `);

    const claimStats = await getOne<{
      total_claims: string;
      total_claim_amount: string;
      total_refund_amount: string;
    }>(`
      SELECT
        COUNT(*)::text AS total_claims,
        COALESCE(SUM(call_cost), 0)::text AS total_claim_amount,
        COALESCE(SUM(refund_amount), 0)::text AS total_refund_amount
      FROM claims
    `);

    const triggerRows = await getMany<{ trigger_type: string; count: string }>(`
      SELECT trigger_type, COUNT(*)::text AS count
      FROM claims
      GROUP BY trigger_type
    `);

    return {
      total_sdk_requests: parseInt(stats!.total_sdk_requests, 10),
      total_claims: parseInt(claimStats!.total_claims, 10),
      total_claim_amount: parseInt(claimStats!.total_claim_amount, 10),
      total_refund_amount: parseInt(claimStats!.total_refund_amount, 10),
      claims_by_trigger: Object.fromEntries(
        triggerRows.map((r) => [r.trigger_type, parseInt(r.count, 10)]),
      ),
      unique_agents: parseInt(stats!.unique_agents, 10),
      unique_providers: parseInt(stats!.unique_providers, 10),
    };
  });

  app.get<{
    Querystring: { granularity?: string; days?: string };
  }>("/api/v1/analytics/timeseries", async (request) => {
    const granularity = request.query.granularity === "daily" ? "day" : "hour";
    const days = parseInt(request.query.days || "7", 10);

    const rows = await getMany<{
      bucket: string;
      requests: string;
      claims: string;
      refund_amount: string;
    }>(`
      SELECT
        date_trunc($1, cr.timestamp) AS bucket,
        COUNT(cr.id)::text AS requests,
        COUNT(c.id)::text AS claims,
        COALESCE(SUM(c.refund_amount), 0)::text AS refund_amount
      FROM call_records cr
      LEFT JOIN claims c ON c.call_record_id = cr.id
      WHERE cr.timestamp > NOW() - ($2 || ' days')::interval
      GROUP BY bucket
      ORDER BY bucket ASC
    `, [granularity, days.toString()]);

    return {
      granularity: request.query.granularity === "daily" ? "daily" : "hourly",
      data: rows.map((r) => ({
        bucket: r.bucket,
        requests: parseInt(r.requests, 10),
        claims: parseInt(r.claims, 10),
        refund_amount: parseInt(r.refund_amount, 10),
      })),
    };
  });
}
