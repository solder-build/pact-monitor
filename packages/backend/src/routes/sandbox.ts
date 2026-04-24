// POST /api/v1/devnet/sandbox/inject-failure (F3).
//
// Integrator quickstart: one authenticated curl that fires a full failure-to-
// refund round-trip on devnet. Synchronous — the response blocks until the
// on-chain claim settles (p95 ≤30s per PRD). Not available outside devnet;
// the genesis-hash-backed getCachedNetwork gate returns 403 on anything but
// an RPC that reports the devnet genesis hash.

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { requireApiKey } from "../middleware/auth.js";
import { getCachedNetwork } from "../utils/network.js";
import { RateLimiter } from "../utils/rate-limiter.js";
import { canonicalHostname } from "../utils/hostname.js";
import {
  SANDBOX_CLASSIFICATIONS,
  triggerClaimDemo,
  PolicyNotProvisionedError,
  type SandboxClassification,
} from "../services/sandbox.js";
import {
  getSandboxPool,
  type SandboxKeypairPool,
} from "../services/sandbox-pool.js";

interface InjectFailureBody {
  schema_version?: number;
  hostname?: unknown;
  classification?: unknown;
  simulated_latency_ms?: unknown;
}

// 10 injections per API key per hour (PRD F3).
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

// When the pool is exhausted, give callers a hint. 30s matches the PRD's
// claim-latency budget — by then an in-flight request should have finished.
const POOL_EXHAUSTED_RETRY_AFTER_SECONDS = 30;

const rateLimiter = new RateLimiter({
  maxPerWindow: RATE_LIMIT_MAX,
  windowMs: RATE_LIMIT_WINDOW_MS,
});

function isDevnet(): boolean {
  return getCachedNetwork() === "devnet";
}

function isValidClassification(v: unknown): v is SandboxClassification {
  return (
    typeof v === "string" &&
    (SANDBOX_CLASSIFICATIONS as readonly string[]).includes(v)
  );
}

interface RouteOptions {
  // Allow tests to inject a pool + devnet-check + rate limiter; defaults are
  // the process-wide singletons so prod wiring is zero-configuration.
  pool?: SandboxKeypairPool;
  isDevnetCheck?: () => boolean;
  rateLimiterOverride?: RateLimiter;
}

export function createSandboxRoutes(options: RouteOptions = {}) {
  return async function sandboxRoutes(app: FastifyInstance): Promise<void> {
    const devnetCheck = options.isDevnetCheck ?? isDevnet;
    const limiter = options.rateLimiterOverride ?? rateLimiter;
    const getPool = () => options.pool ?? getSandboxPool();

    app.post<{ Body: InjectFailureBody }>(
      "/api/v1/devnet/sandbox/inject-failure",
      { preHandler: requireApiKey },
      async (request: FastifyRequest, reply: FastifyReply) => {
        // 1. Hard devnet guard. Fails closed — if genesis detection has not
        //    completed or the RPC reported mainnet/unknown, we 403.
        if (!devnetCheck()) {
          return reply.code(403).send({
            schema_version: 1,
            error: "sandbox_not_available",
            message:
              "Sandbox is only enabled when backend is pointed at Solana devnet",
          });
        }

        // 2. Body + classification validation.
        const body = (request.body ?? {}) as InjectFailureBody;
        const hostnameRaw = body.hostname;
        const classificationRaw = body.classification;
        const latencyRaw = body.simulated_latency_ms;

        if (typeof hostnameRaw !== "string" || hostnameRaw.length === 0) {
          return reply.code(400).send({
            schema_version: 1,
            error: "invalid_request",
            message: "hostname is required",
          });
        }

        let hostname: string;
        try {
          hostname = canonicalHostname(hostnameRaw);
        } catch {
          return reply.code(400).send({
            schema_version: 1,
            error: "invalid_hostname",
            hostname: hostnameRaw,
          });
        }

        if (!isValidClassification(classificationRaw)) {
          return reply.code(400).send({
            schema_version: 1,
            error: "invalid_classification",
            supported: SANDBOX_CLASSIFICATIONS,
          });
        }

        const simulatedLatencyMs =
          typeof latencyRaw === "number" && Number.isFinite(latencyRaw)
            ? Math.max(0, Math.floor(latencyRaw))
            : 0;

        // 3. Rate limit — 10 per API key per hour.
        const authed = request as FastifyRequest & { agentId: string };
        const limit = limiter.check(`sandbox:${authed.agentId}`);
        if (!limit.allowed) {
          const retryAfterSec = Math.max(
            1,
            Math.ceil((limit.resetAt - Date.now()) / 1000),
          );
          reply.header("Retry-After", retryAfterSec.toString());
          return reply.code(429).send({
            schema_version: 1,
            error: "rate_limit_exceeded",
            message: `Sandbox rate limit is ${RATE_LIMIT_MAX} requests per hour per API key`,
            retry_after_seconds: retryAfterSec,
          });
        }

        // 4. Checkout a pooled keypair. 503 when everyone's in flight.
        let pool: SandboxKeypairPool;
        try {
          pool = getPool();
        } catch (err) {
          request.log.error({ err }, "Sandbox keypair pool unavailable");
          return reply.code(503).send({
            schema_version: 1,
            error: "sandbox_pool_unavailable",
            message: "Sandbox keypair pool is not configured on this deployment",
          });
        }

        const lease = pool.checkout();
        if (!lease) {
          reply.header(
            "Retry-After",
            POOL_EXHAUSTED_RETRY_AFTER_SECONDS.toString(),
          );
          return reply.code(503).send({
            schema_version: 1,
            error: "sandbox_pool_exhausted",
            message: "All sandbox keypairs are in flight. Retry in a moment.",
            retry_after_seconds: POOL_EXHAUSTED_RETRY_AFTER_SECONDS,
          });
        }

        // 5. Fire it.
        try {
          const result = await triggerClaimDemo({
            hostname,
            classification: classificationRaw,
            simulatedLatencyMs,
            agentKeypair: lease.keypair,
          });
          return reply.send({ schema_version: 1, ...result });
        } catch (err) {
          if (err instanceof PolicyNotProvisionedError) {
            reply.header(
              "Retry-After",
              POOL_EXHAUSTED_RETRY_AFTER_SECONDS.toString(),
            );
            return reply.code(503).send({
              schema_version: 1,
              error: "sandbox_policy_not_provisioned",
              message: err.message,
              sandbox_agent_pubkey:
                lease.keypair.publicKey.toBase58(),
              hostname,
            });
          }
          const message = err instanceof Error ? err.message : String(err);
          request.log.error({ err }, "Sandbox failure injection failed");
          return reply.code(500).send({
            schema_version: 1,
            error: "sandbox_failure",
            message,
          });
        } finally {
          lease.release();
        }
      },
    );
  };
}

// Default wiring for production: singletons everywhere.
export const sandboxRoutes = createSandboxRoutes();
