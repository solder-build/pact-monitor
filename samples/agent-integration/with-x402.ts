// Pact Monitor — x402 Payment Monitoring Example
// Shows how to track USDC amounts alongside API calls.
// In production, the SDK auto-extracts payment data from x402/MPP headers.
// This example uses manual usdcAmount override for demonstration.
// Run: pnpm tsx samples/agent-integration/with-x402.ts

import { pactMonitor } from "../../packages/sdk/src/index.js";

const monitor = pactMonitor({
  apiKey: process.env.PACT_API_KEY,
  backendUrl: process.env.PACT_BACKEND_URL || "http://localhost:3001",
  syncEnabled: true,
});

// Simulate a paid API call — $0.005 USDC per call
// In production, the SDK reads this from x402 PAYMENT-RESPONSE headers automatically
const res = await monitor.fetch(
  "https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=1000000000",
  {},
  {
    usdcAmount: 0.005, // Manual override: $0.005 USDC
  },
);

const data = await res.json();
console.log("Jupiter quote received");
console.log("Input amount:", data.inAmount);
console.log("Output amount:", data.outAmount);

// Check local records — payment data should be attached
const records = monitor.getRecords({ limit: 1 });
if (records.length > 0) {
  const last = records[0];
  console.log("\nCall record:");
  console.log("  Provider:", last.hostname);
  console.log("  Classification:", last.classification);
  console.log("  Payment:", last.payment ? `${last.payment.amount / 1_000_000} USDC` : "none");
}

monitor.shutdown();
