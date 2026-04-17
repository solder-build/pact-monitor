// Pact Monitor — Schema Validation Example
// Detects when an API returns 200 but the body structure is unexpected.
// Run: pnpm tsx samples/agent-integration/with-schema-validation.ts

import { pactMonitor } from "../../packages/monitor/src/index.js";

const monitor = pactMonitor({
  apiKey: process.env.PACT_API_KEY,
  backendUrl: process.env.PACT_BACKEND_URL || "http://localhost:3001",
  syncEnabled: true,
});

// Call with expected schema — should be "success" if body matches
const res1 = await monitor.fetch(
  "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
  {},
  {
    expectedSchema: {
      type: "object",
      required: ["solana"],
    },
  },
);
console.log("With valid schema:", res1.status);

// Call with a wrong schema — should be classified as "schema_mismatch"
// (API returns { solana: {...} } but we expect a "bitcoin" key)
const res2 = await monitor.fetch(
  "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
  {},
  {
    expectedSchema: {
      type: "object",
      required: ["bitcoin"],
    },
  },
);
console.log("With wrong schema:", res2.status);

const stats = monitor.getStats();
console.log("Total calls:", stats.totalCalls);
console.log("Failure rate:", (stats.failureRate * 100).toFixed(1) + "%");

monitor.shutdown();
