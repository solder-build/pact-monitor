import type { FastifyInstance, FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";
import {
  dripUsdc,
  getFaucetStatus,
  FaucetDisabledError,
  InvalidRecipientError,
  AmountOutOfRangeError,
} from "../services/faucet.js";

interface DripBody {
  recipient?: unknown;
  amount?: unknown;
}

export async function faucetRoutes(app: FastifyInstance): Promise<void> {
  // Scoped rate-limit registration — register() inside a plugin scopes the
  // plugin to this route block, so global routes stay un-rate-limited.
  await app.register(async (scoped) => {
    await scoped.register(rateLimit, {
      global: false, // off by default, per-route via config
      // Default @fastify/rate-limit hook is onRequest, which fires BEFORE
      // body parsing — the keyGenerator below then sees `req.body === undefined`
      // and falls through to ip-only keying, so every drip from the same IP
      // shares a single slot regardless of recipient. Moving to preHandler
      // runs the limiter after the JSON body parser, so keyGenerator can
      // read recipient and bucket by wallet as intended.
      hook: "preHandler",
    });

    scoped.get("/api/v1/faucet/status", async () => getFaucetStatus());

    scoped.post<{ Body: DripBody }>(
      "/api/v1/faucet/drip",
      {
        config: {
          rateLimit: {
            // 1 request per 10 minutes, keyed by recipient pubkey when the
            // body is valid; falls back to IP otherwise so malformed spam
            // still gets slowed down.
            max: 1,
            timeWindow: "10 minutes",
            keyGenerator: (req: FastifyRequest) => {
              const body = (req.body ?? {}) as DripBody;
              if (typeof body.recipient === "string" && body.recipient.length > 0) {
                return `recipient:${body.recipient}`;
              }
              return `ip:${req.ip}`;
            },
            errorResponseBuilder: (_req, context) => ({
              statusCode: 429,
              error: "Too Many Requests",
              message: `Faucet rate limit: wait ${context.after} before the next drip`,
              retryAfterSec: Math.ceil(context.ttl / 1000),
            }),
          },
        },
      },
      async (request, reply) => {
        const status = getFaucetStatus();
        if (!status.enabled) {
          return reply.code(410).send({
            error: "Faucet disabled",
            reason: status.reason ?? "Faucet is not available on this network",
            network: status.network,
          });
        }

        const { recipient, amount } = (request.body ?? {}) as DripBody;

        try {
          const result = await dripUsdc({
            recipient: recipient as string,
            amount: amount as number,
            ip: request.ip,
          });
          return reply.send(result);
        } catch (err) {
          if (err instanceof InvalidRecipientError) {
            return reply.code(400).send({ error: "InvalidRecipient", message: err.message });
          }
          if (err instanceof AmountOutOfRangeError) {
            return reply.code(400).send({ error: "AmountOutOfRange", message: err.message });
          }
          if (err instanceof FaucetDisabledError) {
            return reply.code(410).send({ error: "FaucetDisabled", message: err.message });
          }
          request.log.error({ err }, "faucet drip failed");
          return reply.code(500).send({
            error: "FaucetInternalError",
            message: "Drip failed; check server logs",
          });
        }
      },
    );

    // Secondary spam-net: 20 drips per hour per IP across this scoped router.
    // Applied as a preHandler so it runs on top of the per-recipient limiter.
    // NOT registering as another scoped rateLimit because the plugin only
    // supports a single config per route; a second onRequest hook with its
    // own in-memory Map handles it without fighting @fastify/rate-limit.
    const ipHits = new Map<string, { count: number; resetAt: number }>();
    scoped.addHook("onRequest", async (req, reply) => {
      if (req.method !== "POST") return;
      if (!req.url.startsWith("/api/v1/faucet/drip")) return;
      const now = Date.now();
      const WINDOW_MS = 60 * 60 * 1000;
      const LIMIT = 20;
      const entry = ipHits.get(req.ip);
      if (!entry || entry.resetAt <= now) {
        ipHits.set(req.ip, { count: 1, resetAt: now + WINDOW_MS });
        return;
      }
      entry.count += 1;
      if (entry.count > LIMIT) {
        reply.header("Retry-After", Math.ceil((entry.resetAt - now) / 1000));
        return reply.code(429).send({
          statusCode: 429,
          error: "Too Many Requests",
          message: `IP-level faucet limit exceeded (${LIMIT}/hour)`,
          retryAfterSec: Math.ceil((entry.resetAt - now) / 1000),
        });
      }
    });
  });
}
