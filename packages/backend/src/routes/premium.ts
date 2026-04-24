import type { FastifyInstance } from "fastify";
import { getOne } from "../db.js";
import { canonicalHostname } from "../utils/hostname.js";
import { computeInsuranceRate, computeTier } from "../utils/insurance.js";

// Public, cacheable premium endpoint. Integrators (directories, dashboards)
// cache the 200 response for 60s and render a badge. Schema-versioned so we
// can grow the premium object (surcharges, multi-tier) without breaking
// existing consumers (PRD F2).
const RELIABILITY_WINDOW_SECONDS = 7 * 24 * 60 * 60; // 7 days
const CACHE_MAX_AGE_SECONDS = 60;
const DEFAULT_SOURCE = "https://pact.solder.build";
const SETTLEMENT = "pact_network_v1";

function tierLower(t: ReturnType<typeof computeTier>): string {
  // Expose tier in lowercase snake_case so consumers can add new values
  // (e.g. "verified", "probation") without casing churn.
  return t.toLowerCase();
}

export async function premiumRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { hostname: string } }>(
    "/api/v1/premium/:hostname",
    async (request, reply) => {
      // 1. Normalize. 400 on junk; 404 on unknown is a separate signal so
      //    integrators can distinguish "not covered" from "malformed input".
      let hostname: string;
      try {
        hostname = canonicalHostname(request.params.hostname);
      } catch {
        return reply.code(400).send({
          schema_version: 1,
          error: "invalid_hostname",
          hostname: request.params.hostname,
        });
      }

      // 2. Look up provider + 7-day reliability window in a single round trip.
      const row = await getOne<{
        base_url: string;
        sample_size: string;
        failure_count: string;
      }>(
        `SELECT
           p.base_url,
           COUNT(cr.id) FILTER (
             WHERE cr.created_at > NOW() - ($2 || ' seconds')::interval
           )::text AS sample_size,
           COUNT(cr.id) FILTER (
             WHERE cr.created_at > NOW() - ($2 || ' seconds')::interval
               AND cr.classification != 'success'
           )::text AS failure_count
         FROM providers p
         LEFT JOIN call_records cr ON cr.provider_id = p.id
         WHERE p.base_url = $1
         GROUP BY p.id, p.base_url`,
        [hostname, RELIABILITY_WINDOW_SECONDS.toString()],
      );

      if (!row) {
        // PRD F2: never default a rate on unknown hostname — integrators must
        // distinguish "not covered" from "zero risk".
        return reply.code(404).send({
          schema_version: 1,
          error: "not_tracked",
          hostname,
        });
      }

      const sampleSize = parseInt(row.sample_size, 10);
      const failureCount = parseInt(row.failure_count, 10);
      const failureRate = sampleSize > 0 ? failureCount / sampleSize : 0;
      const insuranceRate = computeInsuranceRate(failureRate);
      const rateBps = Math.round(insuranceRate * 10_000);
      const tier = tierLower(computeTier(insuranceRate));

      reply.header(
        "Cache-Control",
        `public, max-age=${CACHE_MAX_AGE_SECONDS}`,
      );

      return reply.send({
        schema_version: 1,
        hostname,
        premium: {
          rateBps,
          tier,
        },
        reliability: {
          failureRate: parseFloat(failureRate.toFixed(6)),
          sampleSize,
          windowSeconds: RELIABILITY_WINDOW_SECONDS,
        },
        asOf: new Date().toISOString(),
        source: process.env.PACT_PUBLIC_URL ?? DEFAULT_SOURCE,
        settlement: SETTLEMENT,
      });
    },
  );
}
