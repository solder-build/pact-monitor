import "dotenv/config";
import { pactMonitor } from "../../packages/monitor/src/index.js";

const PACT_API_KEY = process.env.PACT_API_KEY;
const PACT_BACKEND_URL = process.env.PACT_BACKEND_URL || "http://localhost:3001";
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const QUICKNODE_RPC_URL = process.env.QUICKNODE_RPC_URL;

if (!PACT_API_KEY) {
  console.error("PACT_API_KEY is required. Run: pnpm run generate-key demo");
  process.exit(1);
}

const monitor = pactMonitor({
  apiKey: PACT_API_KEY,
  backendUrl: PACT_BACKEND_URL,
  syncEnabled: true,
  syncIntervalMs: 5_000,
  latencyThresholdMs: 5_000,
});

interface Provider {
  name: string;
  url: string;
  skip?: boolean;
  reason?: string;
}

const providers: Provider[] = [
  {
    name: "CoinGecko",
    url: "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
  },
  {
    name: "DexScreener",
    url: "https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112",
  },
  {
    name: "Jupiter",
    url: "https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=1000000000",
  },
  {
    name: "Helius",
    url: HELIUS_API_KEY
      ? `https://api.helius.xyz/v0/addresses/vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg/transactions?api-key=${HELIUS_API_KEY}`
      : "",
    skip: !HELIUS_API_KEY,
    reason: "No HELIUS_API_KEY configured",
  },
  {
    name: "QuickNode",
    url: QUICKNODE_RPC_URL || "",
    skip: !QUICKNODE_RPC_URL,
    reason: "No QUICKNODE_RPC_URL configured",
  },
];

const ROUNDS = parseInt(process.argv[2] || "5", 10);

function pad(str: string, len: number): string {
  return str.padEnd(len);
}

function colorClass(cls: string): string {
  if (cls === "success") return "\x1b[32m" + cls + "\x1b[0m";
  if (cls === "timeout") return "\x1b[33m" + cls + "\x1b[0m";
  return "\x1b[31m" + cls + "\x1b[0m";
}

console.log("=== Pact Network — Live Monitor Demo ===");
console.log(`Backend: ${PACT_BACKEND_URL}`);
console.log(`Rounds: ${ROUNDS}`);
console.log("");

for (const p of providers) {
  if (p.skip) {
    console.log(`  Skipping ${p.name} — ${p.reason}`);
  }
}
console.log("");

const results: Array<{ provider: string; status: number; latency: number; classification: string }> = [];

for (let round = 1; round <= ROUNDS; round++) {
  console.log(`--- Round ${round}/${ROUNDS} ---`);

  for (const p of providers) {
    if (p.skip) continue;

    try {
      const start = Date.now();
      const res = await monitor.fetch(p.url);
      const latency = Date.now() - start;
      const status = res.status;
      const classification = status >= 200 && status < 300 ? "success" : "error";

      results.push({ provider: p.name, status, latency, classification });
      console.log(
        `  ${pad(p.name, 14)} ${pad(String(status), 5)} ${pad(latency + "ms", 8)} ${colorClass(classification)}`,
      );
    } catch (err) {
      results.push({ provider: p.name, status: 0, latency: 0, classification: "error" });
      console.log(
        `  ${pad(p.name, 14)} ${pad("ERR", 5)} ${pad("-", 8)} ${colorClass("error")}`,
      );
    }
  }

  if (round < ROUNDS) {
    console.log("  Waiting 2s before next round...");
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// Print summary
console.log("");
console.log("=== Summary ===");
const byProvider = new Map<string, { calls: number; failures: number; totalLatency: number }>();
for (const r of results) {
  const existing = byProvider.get(r.provider) || { calls: 0, failures: 0, totalLatency: 0 };
  existing.calls++;
  if (r.classification !== "success") existing.failures++;
  existing.totalLatency += r.latency;
  byProvider.set(r.provider, existing);
}

for (const [name, stats] of byProvider) {
  const failRate = ((stats.failures / stats.calls) * 100).toFixed(1);
  const avgLatency = Math.round(stats.totalLatency / stats.calls);
  console.log(
    `  ${pad(name, 14)} ${stats.calls} calls, ${failRate}% fail, avg ${avgLatency}ms`,
  );
}

console.log("");
console.log("Flushing to backend...");
monitor.shutdown();
console.log("Done. Check the scorecard at http://localhost:5173");
