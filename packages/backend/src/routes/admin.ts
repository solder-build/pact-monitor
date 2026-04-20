import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { randomBytes } from "crypto";
import { getOne, getMany, query, pool } from "../db.js";
import { hashKey } from "../middleware/auth.js";

async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const adminToken = process.env.ADMIN_TOKEN || "";
  if (!adminToken) {
    reply.code(503).send({ error: "Admin not configured" });
    return;
  }
  const header = request.headers.authorization;
  if (header !== `Bearer ${adminToken}`) {
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

  // Provision a new API key bound to an agent pubkey. Used by onboarding
  // flows (and the samples/demo/insured-agent.ts script) instead of direct
  // Postgres writes. An agent SDK consumer never touches the DB — they call
  // this endpoint once, store the returned key, and use it as the Bearer
  // token for subsequent POST /api/v1/records calls.
  app.post<{
    Body: { label: string; agent_pubkey: string };
  }>("/api/v1/admin/keys", async (request, reply) => {
    const body = request.body ?? { label: "", agent_pubkey: "" };
    if (!body.label || typeof body.label !== "string") {
      return reply.code(400).send({ error: "label is required" });
    }
    if (!body.agent_pubkey || typeof body.agent_pubkey !== "string") {
      return reply.code(400).send({ error: "agent_pubkey is required" });
    }
    // Basic base58 length sanity check (32-byte Solana pubkey = 43-44 chars).
    if (body.agent_pubkey.length < 32 || body.agent_pubkey.length > 48) {
      return reply.code(400).send({ error: "agent_pubkey is not a plausible Solana pubkey" });
    }

    const apiKey = `pact_${randomBytes(24).toString("hex")}`;
    const keyHash = hashKey(apiKey);
    await query(
      "INSERT INTO api_keys (key_hash, label, agent_pubkey) VALUES ($1, $2, $3)",
      [keyHash, body.label, body.agent_pubkey],
    );
    return reply.code(201).send({
      apiKey,
      label: body.label,
      agent_pubkey: body.agent_pubkey,
    });
  });

  // ── Flags ──────────────────────────────────────────────
  app.get("/api/v1/admin/flags", async (request, reply) => {
    const { status } = request.query as { status?: string };
    const where = status ? "WHERE status = $1" : "";
    const params = status ? [status] : [];
    const rows = await getMany<{
      id: string;
      agent_id: string;
      agent_pubkey: string | null;
      flag_reason: string;
      flag_data: Record<string, unknown>;
      status: string;
      created_at: string;
      resolved_at: string | null;
      resolved_by: string | null;
    }>(`SELECT * FROM agent_flags ${where} ORDER BY created_at DESC LIMIT 100`, params);

    const enriched = await Promise.all(
      rows.map(async (row) => {
        const stats = await getOne<{ records_24h: string; claims_24h: string }>(
          `SELECT
            (SELECT COUNT(*) FROM call_records WHERE agent_id = $1 AND created_at > NOW() - INTERVAL '1 day') AS records_24h,
            (SELECT COUNT(*) FROM claims WHERE agent_id = $1 AND created_at > NOW() - INTERVAL '1 day') AS claims_24h`,
          [row.agent_id],
        );
        return {
          ...row,
          records_24h: parseInt(stats?.records_24h ?? "0", 10),
          claims_24h: parseInt(stats?.claims_24h ?? "0", 10),
        };
      }),
    );

    return reply.send(enriched);
  });

  app.patch("/api/v1/admin/flags/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { status } = request.body as { status: "dismissed" | "suspended" };

    if (!["dismissed", "suspended"].includes(status)) {
      return reply.code(400).send({ error: "Status must be 'dismissed' or 'suspended'" });
    }

    const flag = await getOne<{ agent_id: string; status: string }>(
      "SELECT agent_id, status FROM agent_flags WHERE id = $1",
      [id],
    );
    if (!flag) {
      return reply.code(404).send({ error: "Flag not found" });
    }

    // Guard: only resolve pending flags (idempotent)
    const updated = await query(
      "UPDATE agent_flags SET status = $1, resolved_at = NOW(), resolved_by = 'admin' WHERE id = $2 AND status = 'pending'",
      [status, id],
    );
    if (updated.rowCount === 0) {
      return reply.code(409).send({ error: "Flag already resolved" });
    }

    if (status === "dismissed") {
      await query(
        "UPDATE premium_adjustments SET loading_factor = 1.0, reason = 'flag_dismissed' WHERE agent_id = $1",
        [flag.agent_id],
      );
    }

    if (status === "suspended") {
      await query(
        "UPDATE api_keys SET status = 'suspended' WHERE label = $1",
        [flag.agent_id],
      );
    }

    return reply.send({ ok: true, status });
  });

  // Narrow destructive delete for demo-data cleanup. Requires hostname_prefix
  // length >= 3 AND a trailing '-' so a short/empty value can't wipe the
  // whole providers table by accident. Used by the demo-runner's /reset.
  app.post<{ Querystring: { hostname_prefix?: string } }>(
    "/api/v1/admin/delete-by-prefix",
    async (request, reply) => {
      const prefix = request.query.hostname_prefix;
      if (!prefix || prefix.length < 3 || !prefix.endsWith("-")) {
        return reply.code(400).send({
          error: "hostname_prefix must be >= 3 chars and end with '-'",
        });
      }
      const likePattern = `${prefix}%`;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const provIds = await client.query<{ id: string }>(
          "SELECT id FROM providers WHERE base_url LIKE $1",
          [likePattern],
        );
        if (provIds.rows.length === 0) {
          await client.query("COMMIT");
          return { deleted_providers: 0, deleted_records: 0, deleted_claims: 0 };
        }
        const ids = provIds.rows.map((r) => r.id);
        const claimsResult = await client.query(
          "DELETE FROM claims WHERE provider_id = ANY($1::uuid[])",
          [ids],
        );
        const recordsResult = await client.query(
          "DELETE FROM call_records WHERE provider_id = ANY($1::uuid[])",
          [ids],
        );
        const providersResult = await client.query(
          "DELETE FROM providers WHERE id = ANY($1::uuid[])",
          [ids],
        );
        await client.query("COMMIT");
        return {
          deleted_providers: providersResult.rowCount ?? 0,
          deleted_records: recordsResult.rowCount ?? 0,
          deleted_claims: claimsResult.rowCount ?? 0,
        };
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },
  );
}
