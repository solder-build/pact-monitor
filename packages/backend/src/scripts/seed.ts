import "dotenv/config";
import { initDb, query, pool } from "../db.js";
import { hashKey } from "../middleware/auth.js";
import { randomBytes } from "crypto";

const PROVIDERS = [
  { name: "Helius", category: "RPC", base_url: "api.helius.xyz", failureRate: 0.003, avgLatency: 95, latencyStddev: 30 },
  { name: "QuickNode", category: "RPC", base_url: "solana-mainnet.quiknode.pro", failureRate: 0.001, avgLatency: 120, latencyStddev: 40 },
  { name: "Jupiter", category: "DEX Aggregator", base_url: "quote-api.jup.ag", failureRate: 0.015, avgLatency: 320, latencyStddev: 150 },
  { name: "CoinGecko", category: "Price Feed", base_url: "api.coingecko.com", failureRate: 0.03, avgLatency: 250, latencyStddev: 100 },
  { name: "DexScreener", category: "Price Feed", base_url: "api.dexscreener.com", failureRate: 0.02, avgLatency: 380, latencyStddev: 200 },
];

const ENDPOINTS: Record<string, string[]> = {
  "api.helius.xyz": ["/v0/transactions", "/v0/addresses", "/v0/token-metadata"],
  "solana-mainnet.quiknode.pro": ["/", "/getAccountInfo", "/getBalance"],
  "quote-api.jup.ag": ["/v6/quote", "/v6/swap", "/v6/tokens"],
  "api.coingecko.com": ["/api/v3/simple/price", "/api/v3/coins/markets", "/api/v3/coins/solana"],
  "api.dexscreener.com": ["/latest/dex/tokens", "/latest/dex/pairs", "/latest/dex/search"],
};

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOLANA_NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

const REFUND_PCT: Record<string, number> = {
  timeout: 100,
  error: 100,
  schema_mismatch: 75,
};

function randomGaussian(mean: number, stddev: number): number {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.max(1, Math.round(mean + z * stddev));
}

function randomClassification(failureRate: number, latency: number): string {
  const roll = Math.random();
  if (roll < failureRate * 0.5) return "error";
  if (roll < failureRate * 0.8) return "timeout";
  if (roll < failureRate) return "schema_mismatch";
  if (latency > 5000) return "timeout";
  return "success";
}

function randomProtocol(): "x402" | "mpp" | null {
  const roll = Math.random();
  if (roll < 0.6) return "x402";
  if (roll < 0.85) return "mpp";
  return null;
}

async function seed() {
  await initDb();
  console.log("Seeding database...");

  // Clean previous seed data for re-runs
  await query("DELETE FROM claims WHERE agent_id = 'seeder'");

  // Create seed API key
  const seedKey = `pact_seed_${randomBytes(12).toString("hex")}`;
  await query(
    "INSERT INTO api_keys (key_hash, label) VALUES ($1, $2) ON CONFLICT (key_hash) DO NOTHING",
    [hashKey(seedKey), "seeder"],
  );
  console.log(`Seed API key: ${seedKey}`);

  // Create providers
  const providerIds: Record<string, string> = {};
  for (const p of PROVIDERS) {
    const result = await query<{ id: string }>(
      "INSERT INTO providers (name, category, base_url) VALUES ($1, $2, $3) ON CONFLICT (base_url) DO UPDATE SET name = EXCLUDED.name RETURNING id",
      [p.name, p.category, p.base_url],
    );
    providerIds[p.base_url] = result.rows[0].id;
  }

  // Generate 7 days of historical records
  const now = Date.now();
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
  let totalRecords = 0;

  for (const provider of PROVIDERS) {
    const endpoints = ENDPOINTS[provider.base_url];
    const recordsForProvider = 1500 + Math.floor(Math.random() * 1500); // 1500-3000 per provider

    for (let i = 0; i < recordsForProvider; i++) {
      const timestamp = new Date(sevenDaysAgo + Math.random() * (now - sevenDaysAgo));

      // Higher failure rates during peak hours (12-18 UTC)
      const hour = timestamp.getUTCHours();
      const peakMultiplier = (hour >= 12 && hour <= 18) ? 1.5 : 1.0;
      const effectiveFailureRate = provider.failureRate * peakMultiplier;

      const latency = randomGaussian(provider.avgLatency, provider.latencyStddev);
      const classification = randomClassification(effectiveFailureRate, latency);
      const statusCode = classification === "error" ? (Math.random() > 0.5 ? 500 : 503) :
                         classification === "success" || classification === "schema_mismatch" || classification === "timeout" ? 200 : 0;
      const endpoint = endpoints[Math.floor(Math.random() * endpoints.length)];
      const protocol = randomProtocol();
      const paymentAmount = protocol ? Math.round((0.001 + Math.random() * 0.01) * 1_000_000) : null;

      const insertResult = await query<{ id: string }>(
        `INSERT INTO call_records (
          provider_id, endpoint, timestamp, status_code, latency_ms,
          classification, payment_protocol, payment_amount, payment_asset,
          payment_network, payer_address, recipient_address, tx_hash,
          settlement_success, agent_id
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        RETURNING id`,
        [
          providerIds[provider.base_url],
          endpoint,
          timestamp.toISOString(),
          statusCode,
          latency,
          classification,
          protocol,
          paymentAmount,
          protocol ? USDC_MINT : null,
          protocol ? SOLANA_NETWORK : null,
          protocol ? `Agent${randomBytes(4).toString("hex")}` : null,
          protocol ? `Provider${randomBytes(4).toString("hex")}` : null,
          protocol ? randomBytes(32).toString("hex") : null,
          protocol ? (classification === "success") : null,
          "seeder",
        ],
      );

      // Create claim for qualifying failures
      if (classification !== "success" && paymentAmount && paymentAmount > 0) {
        const refundPct = REFUND_PCT[classification];
        if (refundPct !== undefined) {
          const refundAmount = Math.round((paymentAmount * refundPct) / 100);
          await query(
            `INSERT INTO claims (
              call_record_id, provider_id, agent_id, trigger_type,
              call_cost, refund_pct, refund_amount, status, created_at
            ) VALUES ($1, $2, 'seeder', $3, $4, $5, $6, 'simulated', $7)`,
            [
              insertResult.rows[0].id,
              providerIds[provider.base_url],
              classification,
              paymentAmount,
              refundPct,
              refundAmount,
              timestamp.toISOString(),
            ],
          );
        }
      }
      totalRecords++;
    }

    console.log(`  ${provider.name}: ${recordsForProvider} records`);
  }

  console.log(`\nSeeding complete. Total records: ${totalRecords}`);
  await pool.end();
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
