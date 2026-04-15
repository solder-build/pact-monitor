import type { FastifyInstance } from "fastify";
import { getMany, getOne } from "../db.js";
import { computeInsuranceRate, computeTier } from "../utils/insurance.js";

interface ProviderRow {
  id: string;
  name: string;
  category: string;
  base_url: string;
  wallet_address: string | null;
  total_calls: string;
  failure_count: string;
  avg_latency_ms: string;
  total_payment_amount: string | null;
  lost_payment_amount: string | null;
}

export async function providersRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/v1/providers — ranked list
  app.get("/api/v1/providers", async () => {
    const rows = await getMany<ProviderRow>(`
      SELECT
        p.id, p.name, p.category, p.base_url, p.wallet_address,
        COUNT(cr.id)::text AS total_calls,
        COUNT(cr.id) FILTER (WHERE cr.classification != 'success')::text AS failure_count,
        COALESCE(AVG(cr.latency_ms), 0)::text AS avg_latency_ms,
        SUM(cr.payment_amount)::text AS total_payment_amount,
        SUM(cr.payment_amount) FILTER (WHERE cr.classification != 'success')::text AS lost_payment_amount
      FROM providers p
      LEFT JOIN call_records cr ON cr.provider_id = p.id
      GROUP BY p.id
      HAVING COUNT(cr.id) > 0
      ORDER BY COUNT(cr.id) FILTER (WHERE cr.classification != 'success')::float / NULLIF(COUNT(cr.id), 0) ASC
    `);

    return rows.map((r) => {
      const totalCalls = parseInt(r.total_calls, 10);
      const failures = parseInt(r.failure_count, 10);
      const failureRate = totalCalls > 0 ? failures / totalCalls : 0;
      const insuranceRate = computeInsuranceRate(failureRate);

      return {
        id: r.id,
        name: r.name,
        category: r.category,
        hostname: r.base_url,
        base_url: r.base_url,
        total_calls: totalCalls,
        failure_rate: parseFloat(failureRate.toFixed(6)),
        avg_latency_ms: Math.round(parseFloat(r.avg_latency_ms)),
        uptime: parseFloat((1 - failureRate).toFixed(6)),
        insurance_rate: parseFloat(insuranceRate.toFixed(6)),
        tier: computeTier(insuranceRate),
        total_payment_amount: r.total_payment_amount ? parseInt(r.total_payment_amount, 10) : 0,
        lost_payment_amount: r.lost_payment_amount ? parseInt(r.lost_payment_amount, 10) : 0,
      };
    });
  });

  // GET /api/v1/providers/:id — detailed stats
  app.get<{ Params: { id: string } }>("/api/v1/providers/:id", async (request, reply) => {
    const { id } = request.params;

    const provider = await getOne<{ id: string; name: string; category: string; base_url: string; wallet_address: string | null }>(
      "SELECT id, name, category, base_url, wallet_address FROM providers WHERE id = $1",
      [id],
    );

    if (!provider) {
      return reply.code(404).send({ error: "Provider not found" });
    }

    const stats = await getOne<{
      total_calls: string;
      failure_count: string;
      avg_latency_ms: string;
      p50_latency_ms: string;
      p95_latency_ms: string;
      p99_latency_ms: string;
    }>(`
      SELECT
        COUNT(*)::text AS total_calls,
        COUNT(*) FILTER (WHERE classification != 'success')::text AS failure_count,
        COALESCE(AVG(latency_ms), 0)::text AS avg_latency_ms,
        COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY latency_ms), 0)::text AS p50_latency_ms,
        COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms), 0)::text AS p95_latency_ms,
        COALESCE(PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY latency_ms), 0)::text AS p99_latency_ms
      FROM call_records WHERE provider_id = $1
    `, [id]);

    const failureBreakdown = await getMany<{ classification: string; count: string }>(`
      SELECT classification, COUNT(*)::text AS count
      FROM call_records
      WHERE provider_id = $1 AND classification != 'success'
      GROUP BY classification
    `, [id]);

    const topEndpoints = await getMany<{ endpoint: string; calls: string; failure_rate: string }>(`
      SELECT
        endpoint,
        COUNT(*)::text AS calls,
        (COUNT(*) FILTER (WHERE classification != 'success')::float / NULLIF(COUNT(*), 0))::text AS failure_rate
      FROM call_records
      WHERE provider_id = $1
      GROUP BY endpoint
      ORDER BY COUNT(*) DESC
      LIMIT 10
    `, [id]);

    const paymentBreakdown = await getMany<{
      payment_protocol: string | null;
      calls: string;
      total_amount: string | null;
      lost_amount: string | null;
    }>(`
      SELECT
        COALESCE(payment_protocol, 'free') AS payment_protocol,
        COUNT(*)::text AS calls,
        SUM(payment_amount)::text AS total_amount,
        SUM(payment_amount) FILTER (WHERE classification != 'success')::text AS lost_amount
      FROM call_records
      WHERE provider_id = $1
      GROUP BY payment_protocol
    `, [id]);

    const totalCalls = parseInt(stats!.total_calls, 10);
    const failures = parseInt(stats!.failure_count, 10);
    const failureRate = totalCalls > 0 ? failures / totalCalls : 0;
    const insuranceRate = computeInsuranceRate(failureRate);

    return {
      id: provider.id,
      name: provider.name,
      category: provider.category,
      hostname: provider.base_url,
      base_url: provider.base_url,
      total_calls: totalCalls,
      failure_rate: parseFloat(failureRate.toFixed(6)),
      avg_latency_ms: Math.round(parseFloat(stats!.avg_latency_ms)),
      p50_latency_ms: Math.round(parseFloat(stats!.p50_latency_ms)),
      p95_latency_ms: Math.round(parseFloat(stats!.p95_latency_ms)),
      p99_latency_ms: Math.round(parseFloat(stats!.p99_latency_ms)),
      uptime: parseFloat((1 - failureRate).toFixed(6)),
      insurance_rate: parseFloat(insuranceRate.toFixed(6)),
      tier: computeTier(insuranceRate),
      failure_breakdown: Object.fromEntries(
        failureBreakdown.map((r) => [r.classification, parseInt(r.count, 10)]),
      ),
      top_endpoints: topEndpoints.map((r) => ({
        endpoint: r.endpoint,
        calls: parseInt(r.calls, 10),
        failure_rate: parseFloat(parseFloat(r.failure_rate).toFixed(6)),
      })),
      payment_breakdown: Object.fromEntries(
        paymentBreakdown.map((r) => [
          r.payment_protocol,
          {
            calls: parseInt(r.calls, 10),
            total_amount: r.total_amount ? parseInt(r.total_amount, 10) : 0,
            lost_amount: r.lost_amount ? parseInt(r.lost_amount, 10) : 0,
          },
        ]),
      ),
    };
  });

  // GET /api/v1/providers/:id/timeseries
  app.get<{
    Params: { id: string };
    Querystring: { granularity?: string; days?: string };
  }>("/api/v1/providers/:id/timeseries", async (request, reply) => {
    const { id } = request.params;
    const granularity = request.query.granularity === "daily" ? "day" : "hour";
    const days = parseInt(request.query.days || "7", 10);

    const provider = await getOne<{ id: string }>(
      "SELECT id FROM providers WHERE id = $1",
      [id],
    );
    if (!provider) {
      return reply.code(404).send({ error: "Provider not found" });
    }

    const rows = await getMany<{
      bucket: string;
      calls: string;
      failures: string;
    }>(`
      SELECT
        date_trunc($1, timestamp) AS bucket,
        COUNT(*)::text AS calls,
        COUNT(*) FILTER (WHERE classification != 'success')::text AS failures
      FROM call_records
      WHERE provider_id = $2 AND timestamp > NOW() - ($3 || ' days')::interval
      GROUP BY bucket
      ORDER BY bucket ASC
    `, [granularity, id, days.toString()]);

    return {
      provider_id: id,
      granularity: request.query.granularity === "daily" ? "daily" : "hourly",
      data: rows.map((r) => {
        const calls = parseInt(r.calls, 10);
        const failures = parseInt(r.failures, 10);
        return {
          bucket: r.bucket,
          calls,
          failures,
          failure_rate: calls > 0 ? parseFloat((failures / calls).toFixed(6)) : 0,
        };
      }),
    };
  });
}
