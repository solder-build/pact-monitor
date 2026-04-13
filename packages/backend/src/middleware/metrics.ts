import type { FastifyRequest, FastifyReply } from "fastify";
import { query } from "../db.js";

export async function metricsHook(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const route = request.routeOptions?.url || request.url;
  const method = request.method;
  const statusCode = reply.statusCode;
  const latencyMs = Math.round(reply.elapsedTime);

  query(
    "INSERT INTO backend_metrics (route, method, status_code, latency_ms) VALUES ($1, $2, $3, $4)",
    [route, method, statusCode, latencyMs],
  ).catch(() => {});
}
