// Pact Monitor — Basic Integration
// Run: pnpm tsx samples/agent-integration/basic.ts

import { pactMonitor } from "../../packages/sdk/src/index.js";

const monitor = pactMonitor({
  apiKey: process.env.PACT_API_KEY,
  backendUrl: process.env.PACT_BACKEND_URL || "http://localhost:3001",
  syncEnabled: true,
});

// Replace fetch() with monitor.fetch() — same API, now monitored
const res = await monitor.fetch(
  "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
);
const data = await res.json();
console.log("Solana price:", data.solana.usd, "USD");
console.log("Local stats:", monitor.getStats());

monitor.shutdown();
