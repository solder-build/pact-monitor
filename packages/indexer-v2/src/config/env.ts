import { z } from "zod";

/**
 * indexer-v2 env contract.
 *
 *   PG_V2_URL          — Postgres DSN for @pact-network/db-v2
 *   INDEXER_V2_PUSH_SECRET — bearer for settler-v2's /events posts
 *   HELIUS_WEBHOOK_SECRET  — bearer Helius signs each webhook with
 *   PROGRAM_ID         — V2 program ID, defaults to declare_id from
 *                        @q3labs/pact-protocol-v2-client
 *   STATS_CACHE_TTL_MS — in-memory cache for /api/v2/stats (default 5_000)
 *   OPERATOR_NACL_DOMAIN — domain string prefixed to ops sign-message
 *                        nonces to prevent cross-domain replay
 */
const envSchema = z.object({
  PG_V2_URL: z.string().min(1),
  INDEXER_V2_PUSH_SECRET: z.string().min(1),
  HELIUS_WEBHOOK_SECRET: z.string().min(1).optional(),
  PROGRAM_ID: z
    .string()
    .default("7i9zJMwaTRw4Tdy7SAfXJdDkYQD39xyKmkBhWuUSgDJU"),
  LOG_LEVEL: z
    .enum(["error", "warn", "log", "debug", "verbose"])
    .default("log"),
  PORT: z.coerce.number().default(8083),
  STATS_CACHE_TTL_MS: z.coerce.number().default(5_000),
  OPERATOR_NACL_DOMAIN: z.string().default("pact-network-v2-ops"),
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(raw: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`indexer-v2: invalid env: ${result.error.message}`);
  }
  return result.data;
}
