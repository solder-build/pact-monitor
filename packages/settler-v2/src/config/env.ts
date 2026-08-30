import { z } from "zod";

/**
 * settler-v2 env contract. Differences from V1 settler:
 *
 *   - ORACLE_KEY replaces SETTLEMENT_AUTHORITY_KEY. Same loader contract
 *     (Secret Manager resource path OR raw base58 secret key).
 *   - PROGRAM_ID defaults to the V2 declare_id from
 *     `@q3labs/pact-protocol-v2-client` constants
 *     (7i9zJMwaTRw4Tdy7SAfXJdDkYQD39xyKmkBhWuUSgDJU).
 *   - PUBSUB_TOPIC_PREMIUM / PUBSUB_TOPIC_CLAIM are two separate topics
 *     (V2 settler has two pipelines; this module wires only the premium
 *     pipeline — claim pipeline lands in C4).
 *   - INDEXER_V2_URL / INDEXER_V2_PUSH_SECRET point at indexer-v2.
 *   - PG_V2_URL: Postgres URL for the V2PremiumAttempt idempotency
 *     ledger (Locked decision: no on-chain PDA for settle_premium → need
 *     an off-chain attempt ledger).
 *   - USDC_MINT optional; defaults to devnet USDC.
 */
const envSchema = z
  .object({
    SOLANA_RPC_URL: z.string().url(),
    ORACLE_KEY: z.string().min(1),
    PROGRAM_ID: z
      .string()
      .default("7i9zJMwaTRw4Tdy7SAfXJdDkYQD39xyKmkBhWuUSgDJU"),
    USDC_MINT: z.string().optional(),
    INDEXER_V2_URL: z.string().url(),
    INDEXER_V2_PUSH_SECRET: z.string().min(1),
    PG_V2_URL: z.string().min(1),
    LOG_LEVEL: z
      .enum(["error", "warn", "log", "debug", "verbose"])
      .default("log"),
    PORT: z.coerce.number().default(8082),

    QUEUE_BACKEND: z.enum(["pubsub", "redis-streams"]).default("pubsub"),

    // Pub/Sub (required when QUEUE_BACKEND="pubsub").
    PUBSUB_PROJECT: z.string().optional(),
    PUBSUB_SUBSCRIPTION_PREMIUM: z.string().optional(),
    PUBSUB_SUBSCRIPTION_CLAIM: z.string().optional(),

    // Redis Streams (required when QUEUE_BACKEND="redis-streams").
    REDIS_URL: z.string().optional(),
    REDIS_STREAM_PREMIUM: z.string().optional(),
    REDIS_STREAM_CLAIM: z.string().optional(),
    REDIS_CONSUMER_GROUP: z.string().default("settler-v2"),

    // Batching levers — measured empirically in C3; documented in plan §C3.
    MAX_IXS_PER_TX: z.coerce.number().default(6),
    FLUSH_INTERVAL_MS: z.coerce.number().default(5000),
    COMPUTE_UNIT_LIMIT: z.coerce.number().default(1_400_000),
    COMPUTE_UNIT_PRICE_MICROLAMPORTS: z.coerce.number().default(5000),

    // Confirmation polling.
    CONFIRM_TIMEOUT_MS: z.coerce.number().default(30_000),
    CONFIRM_POLL_INTERVAL_MS: z.coerce.number().default(500),
  })
  .superRefine((val, ctx) => {
    if (val.QUEUE_BACKEND === "pubsub") {
      if (!val.PUBSUB_PROJECT) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["PUBSUB_PROJECT"],
          message: "PUBSUB_PROJECT is required when QUEUE_BACKEND=pubsub",
        });
      }
      if (!val.PUBSUB_SUBSCRIPTION_PREMIUM) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["PUBSUB_SUBSCRIPTION_PREMIUM"],
          message:
            "PUBSUB_SUBSCRIPTION_PREMIUM is required when QUEUE_BACKEND=pubsub",
        });
      }
    } else if (val.QUEUE_BACKEND === "redis-streams") {
      if (!val.REDIS_URL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["REDIS_URL"],
          message: "REDIS_URL is required when QUEUE_BACKEND=redis-streams",
        });
      }
      if (!val.REDIS_STREAM_PREMIUM) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["REDIS_STREAM_PREMIUM"],
          message:
            "REDIS_STREAM_PREMIUM is required when QUEUE_BACKEND=redis-streams",
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

export function parseEnv(raw: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`settler-v2: invalid env: ${result.error.message}`);
  }
  return result.data;
}
