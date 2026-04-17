---
name: pact-monitor
description: "Use when integrating @pact-network/monitor — wrapping fetch() calls to track API reliability, configuring backend sync, signing batches with an Ed25519 keypair, or reading local records. Examples: \"add monitor to my agent\", \"track failures for this API\", \"sign pact batches\""
---

# Pact Monitor — SDK Integration

`@pact-network/monitor` wraps `fetch()` to silently record reliability data (latency, failures, payment headers) and syncs it to the Pact Network backend.

## Install

```bash
npm install @pact-network/monitor
# or pnpm add @pact-network/monitor
```

For signed batches (anti-fraud):

```bash
npm install @solana/web3.js
```

## Initialize

```typescript
import { pactMonitor } from "@pact-network/monitor";

const monitor = pactMonitor({
  apiKey: process.env.PACT_API_KEY,      // required if syncEnabled
  backendUrl: "https://pactnetwork.io",  // default
  syncEnabled: true,                      // default false
  syncIntervalMs: 30_000,                 // default
  syncBatchSize: 100,                     // default
  latencyThresholdMs: 5_000,              // classify > this as "timeout"
  storagePath: "",                        // default ~/.pact-monitor/records.jsonl
  agentPubkey: "",                        // Solana base58 pubkey; required for on-chain claim attribution
  keypair: undefined,                     // { publicKey, secretKey } — required to sign batches
});
```

Minimal (local recording only):

```typescript
const monitor = pactMonitor();
```

## Replace fetch()

`monitor.fetch()` is a drop-in replacement for `fetch()`:

```typescript
const res = await monitor.fetch("https://api.helius.xyz/v0/addresses/...", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", method: "getBalance", params: ["..."] }),
});
```

Optional third arg for Pact-specific options:

```typescript
await monitor.fetch(url, init, {
  expectedSchema: { type: "object", required: ["result"] }, // 200 + wrong body → "schema_mismatch"
  usdcAmount: 0.01,                                          // whole USDC; use when no x402/MPP headers present
});
```

## Sign Batches (Production)

In production, the backend verifies that each batch came from the claimed agent. Pass a Solana keypair:

```typescript
import { Keypair } from "@solana/web3.js";
import fs from "fs";

const agent = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(process.env.AGENT_KEYPAIR_PATH, "utf-8"))),
);

const monitor = pactMonitor({
  apiKey: process.env.PACT_API_KEY,
  syncEnabled: true,
  agentPubkey: agent.publicKey.toBase58(),
  keypair: { publicKey: agent.publicKey.toBytes(), secretKey: agent.secretKey },
});
```

SDK warns at startup if `syncEnabled + apiKey` are set without a keypair. Future versions will reject unsigned batches.

## Event Hooks

```typescript
monitor.on("failure", (record) => {
  // record.classification: "timeout" | "error" | "schema_mismatch"
  console.warn(`[${record.hostname}] failed: ${record.classification} ${record.statusCode}`);
});

monitor.on("billed", ({ callCost }) => {
  // callCost in whole USDC (0 if no payment data present)
});
```

Events fire in-process for agent-side alerting/metrics. They do NOT trigger claim submission — the backend handles that when it receives the synced record.

## Local Reads

```typescript
monitor.getStats();  // { total, byClassification, byHostname, ... }
monitor.getRecords({ limit: 50, provider: "api.helius.xyz" });
```

## Graceful Shutdown

```typescript
process.on("SIGINT", () => {
  monitor.shutdown();  // flushes pending batch, stops sync loop
  process.exit(0);
});

// Fastify:
server.addHook("onClose", async () => monitor.shutdown());
```

## Golden Rule

If any internal operation fails (storage write, sync, schema check), the underlying `fetch` still returns normally. Never add code that breaks the agent's API call because monitoring failed.

## Reference Samples

- `samples/agent-integration/basic.ts` — 10-line integration
- `samples/agent-integration/with-schema-validation.ts` — detect broken responses
- `samples/agent-integration/with-x402.ts` — manual USDC amount

## Related

- `pact-network-guide` — overview, decide which SDK
- `pact-insurance` — on-chain policies & claims
- `pact-integration` — both SDKs wired together
