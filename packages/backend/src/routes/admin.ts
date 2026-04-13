import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { getOne, getMany } from "../db.js";

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!ADMIN_TOKEN) {
    reply.code(503).send({ error: "Admin not configured" });
    return;
  }
  const header = request.headers.authorization;
  if (header !== `Bearer ${ADMIN_TOKEN}`) {
    reply.code(401).send({ error: "Invalid admin token" });
    return;
  }
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", requireAdmin);

  // Overview: high-level numbers
  app.get("/api/v1/admin/overview", async () => {
    const row = await getOne<{
      total_records: string;
      total_providers: string;
      unique_agents: string;
      total_payment_volume: string;
      total_lost_value: string;
      settlement_failures: string;
      total_settlements: string;
    }>(`
      SELECT
        COUNT(*)::text AS total_records,
        COUNT(DISTINCT provider_id)::text AS total_providers,
        COUNT(DISTINCT agent_id)::text AS unique_agents,
        COALESCE(SUM(payment_amount), 0)::text AS total_payment_volume,
        COALESCE(SUM(payment_amount) FILTER (WHERE classification != 'success'), 0)::text AS total_lost_value,
        COUNT(*) FILTER (WHERE settlement_success = false)::text AS settlement_failures,
        COUNT(*) FILTER (WHERE settlement_success IS NOT NULL)::text AS total_settlements
      FROM call_records
    `);

    if (!row) return { total_records: 0, total_providers: 0, unique_agents: 0, total_payment_volume: 0, total_lost_value: 0, settlement_rate: 1 };

    const totalSettlements = parseInt(row.total_settlements, 10);
    const settlementFailures = parseInt(row.settlement_failures, 10);

    return {
      total_records: parseInt(row.total_records, 10),
      total_providers: parseInt(row.total_providers, 10),
      unique_agents: parseInt(row.unique_agents, 10),
      total_payment_volume: parseInt(row.total_payment_volume, 10),
      total_lost_value: parseInt(row.total_lost_value, 10),
      settlement_rate: totalSettlements > 0 ? 1 - settlementFailures / totalSettlements : 1,
    };
  });

  // Backend health: route latency and error rate (last 24h)
  app.get("/api/v1/admin/backend-health", async () => {
    const routes = await getMany<{
      route: string;
      requests: string;
      errors: string;
      p50: string;
      p95: string;
      p99: string;
    }>(`
      SELECT
        route,
        COUNT(*)::text AS requests,
        COUNT(*) FILTER (WHERE status_code >= 500)::text AS errors,
        COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY latency_ms), 0)::text AS p50,
        COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms), 0)::text AS p95,
        COALESCE(PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY latency_ms), 0)::text AS p99
      FROM backend_metrics
      WHERE created_at > NOW() - INTERVAL '24 hours'
      GROUP BY route
      ORDER BY COUNT(*) DESC
    `);

    return routes.map((r) => ({
      route: r.route,
      requests: parseInt(r.requests, 10),
      errors: parseInt(r.errors, 10),
      error_rate: parseInt(r.requests, 10) > 0 ? parseInt(r.errors, 10) / parseInt(r.requests, 10) : 0,
      p50_ms: parseFloat(r.p50),
      p95_ms: parseFloat(r.p95),
      p99_ms: parseFloat(r.p99),
    }));
  });

  // Ingestion: records per hour (last 24h)
  app.get("/api/v1/admin/ingestion", async () => {
    const rows = await getMany<{ bucket: string; count: string }>(`
      SELECT
        date_trunc('hour', created_at) AS bucket,
        COUNT(*)::text AS count
      FROM call_records
      WHERE created_at > NOW() - INTERVAL '24 hours'
      GROUP BY bucket
      ORDER BY bucket ASC
    `);

    return rows.map((r) => ({
      bucket: r.bucket,
      records: parseInt(r.count, 10),
    }));
  });

  // Agent adoption: unique agents per day, new agents per day (last 7d)
  app.get("/api/v1/admin/agents", async () => {
    const daily = await getMany<{ day: string; active_agents: string; new_agents: string }>(`
      WITH daily_agents AS (
        SELECT
          date_trunc('day', created_at)::date AS day,
          COUNT(DISTINCT agent_id) AS active_agents
        FROM call_records
        WHERE created_at > NOW() - INTERVAL '7 days' AND agent_id IS NOT NULL
        GROUP BY day
      ),
      first_seen AS (
        SELECT
          date_trunc('day', MIN(created_at))::date AS day,
          COUNT(*) AS new_agents
        FROM call_records
        WHERE agent_id IS NOT NULL
        GROUP BY agent_id
      ),
      new_per_day AS (
        SELECT day, SUM(new_agents)::text AS new_agents
        FROM first_seen
        WHERE day > NOW() - INTERVAL '7 days'
        GROUP BY day
      )
      SELECT
        da.day::text,
        da.active_agents::text,
        COALESCE(npd.new_agents, '0') AS new_agents
      FROM daily_agents da
      LEFT JOIN new_per_day npd ON da.day = npd.day
      ORDER BY da.day ASC
    `);

    const retention = await getOne<{ retained: string; total: string }>(`
      SELECT
        COUNT(*) FILTER (WHERE day_count > 1)::text AS retained,
        COUNT(*)::text AS total
      FROM (
        SELECT agent_id, COUNT(DISTINCT date_trunc('day', created_at)::date) AS day_count
        FROM call_records
        WHERE agent_id IS NOT NULL AND created_at > NOW() - INTERVAL '7 days'
        GROUP BY agent_id
      ) sub
    `);

    const total = parseInt(retention?.total || "0", 10);
    const retained = parseInt(retention?.retained || "0", 10);

    return {
      daily: daily.map((d) => ({
        day: d.day,
        active_agents: parseInt(d.active_agents, 10),
        new_agents: parseInt(d.new_agents, 10),
      })),
      retention_rate: total > 0 ? retained / total : 0,
    };
  });

  // Scorecard usage: page views, sessions, click-through (last 24h)
  app.get("/api/v1/admin/scorecard-usage", async () => {
    const hourly = await getMany<{ bucket: string; views: string }>(`
      SELECT
        date_trunc('hour', created_at) AS bucket,
        COUNT(*)::text AS views
      FROM analytics_events
      WHERE event_type = 'page_view' AND created_at > NOW() - INTERVAL '24 hours'
      GROUP BY bucket
      ORDER BY bucket ASC
    `);

    const stats = await getOne<{
      total_views: string;
      unique_sessions: string;
      provider_clicks: string;
      sessions_with_clicks: string;
    }>(`
      SELECT
        COUNT(*) FILTER (WHERE event_type = 'page_view')::text AS total_views,
        COUNT(DISTINCT session_id) FILTER (WHERE event_type = 'page_view')::text AS unique_sessions,
        COUNT(*) FILTER (WHERE event_type = 'provider_click')::text AS provider_clicks,
        COUNT(DISTINCT session_id) FILTER (WHERE event_type = 'provider_click')::text AS sessions_with_clicks
      FROM analytics_events
      WHERE created_at > NOW() - INTERVAL '24 hours'
    `);

    const sessions = parseInt(stats?.unique_sessions || "0", 10);
    const sessionsWithClicks = parseInt(stats?.sessions_with_clicks || "0", 10);

    return {
      hourly: hourly.map((h) => ({ bucket: h.bucket, views: parseInt(h.views, 10) })),
      total_views: parseInt(stats?.total_views || "0", 10),
      unique_sessions: sessions,
      provider_clicks: parseInt(stats?.provider_clicks || "0", 10),
      click_through_rate: sessions > 0 ? sessionsWithClicks / sessions : 0,
    };
  });

  // Costs: payment analysis by provider
  app.get("/api/v1/admin/costs", async () => {
    const rows = await getMany<{
      provider_name: string;
      total_calls: string;
      paid_calls: string;
      avg_payment: string;
      total_paid: string;
      total_lost: string;
      settlement_failures: string;
    }>(`
      SELECT
        p.name AS provider_name,
        COUNT(cr.id)::text AS total_calls,
        COUNT(cr.id) FILTER (WHERE cr.payment_amount IS NOT NULL AND cr.payment_amount > 0)::text AS paid_calls,
        COALESCE(AVG(cr.payment_amount) FILTER (WHERE cr.payment_amount > 0), 0)::text AS avg_payment,
        COALESCE(SUM(cr.payment_amount), 0)::text AS total_paid,
        COALESCE(SUM(cr.payment_amount) FILTER (WHERE cr.classification != 'success'), 0)::text AS total_lost,
        COUNT(*) FILTER (WHERE cr.settlement_success = false)::text AS settlement_failures
      FROM call_records cr
      JOIN providers p ON p.id = cr.provider_id
      GROUP BY p.name
      ORDER BY SUM(cr.payment_amount) DESC NULLS LAST
    `);

    return rows.map((r) => ({
      provider: r.provider_name,
      total_calls: parseInt(r.total_calls, 10),
      paid_calls: parseInt(r.paid_calls, 10),
      avg_payment_micro_usdc: parseFloat(r.avg_payment),
      total_paid: parseInt(r.total_paid, 10),
      total_lost: parseInt(r.total_lost, 10),
      settlement_failures: parseInt(r.settlement_failures, 10),
    }));
  });
}
