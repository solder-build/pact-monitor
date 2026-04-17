---
name: pact-network
description: Integrate the Pact Network SDKs for AI agents on Solana. The @pact-network/monitor SDK wraps fetch() to track API reliability; the @pact-network/insurance SDK manages on-chain parametric insurance policies and claims. Use when adding reliability monitoring, wrapping fetch() calls, enabling insurance against API failures, or wiring both together.
argument-hint: [monitor|insurance|both]
allowed-tools: Read Write Edit Bash(npm *) Bash(pnpm *) Bash(npx *) Bash(node *) Grep Glob
---

# Pact Network — SDK Integration Skill

You are integrating one or both of the Pact Network SDKs into a TypeScript/JavaScript project.

- **`@pact-network/monitor`** wraps `fetch()` to silently record reliability data (latency, failures, payment headers) and syncs it to the Pact Network backend.
- **`@pact-network/insurance`** manages on-chain parametric insurance policies on Solana: enable a policy, delegate a USDC budget, submit claims, read policy state.

They complement each other. `monitor` produces the evidence that `insurance` turns into a USDC refund when a paid API call fails.

## What Pact Network Does

Pact Network is parametric micro-insurance for AI agent API payments on Solana. It monitors API provider reliability in real-time, computes actuarially-derived insurance rates from observed failure data, and publishes those rates on a public scorecard at pactnetwork.io.

The insurance rate formula is: `max(0.001, failureRate * 1.5 + 0.001)`, scaled to bps per pool.

Provider tiers:
- RELIABLE: failure rate < 1%
- ELEVATED: failure rate 1%–5%
- HIGH RISK: failure rate > 5%

## Decide Which SDK You Need

| Your goal | Install |
|---|---|
| Just observe reliability; push data to Pact's backend | `@pact-network/monitor` |
| Also get on-chain USDC refunds when paid calls fail | both |
| Only manage policies off the critical path (e.g. admin tool) | `@pact-network/insurance` |

Most agents want **both**. Monitor generates signed evidence of failures; the backend uses that evidence to auto-submit claims; insurance lets the agent also enable its own policy, read policy state, and optionally retry a claim manually.

## Golden Rule — Monitor Never Breaks the Call

If `monitor.fetch()` encounters an internal error (storage write, sync, schema check), the underlying `fetch` MUST still succeed. The SDK enforces this — every recording path is wrapped in try/catch. Never add code that breaks the agent's API call because a monitoring step failed.

---

## Mode A — Monitor Only

### Step 1 — Install

```bash
npm install @pact-network/monitor
# or pnpm add @pact-network/monitor
```

### Step 2 — Initialize

```typescript
import { pactMonitor } from "@pact-network/monitor";

const monitor = pactMonitor({
  apiKey: process.env.PACT_API_KEY,      // required if syncEnabled
  backendUrl: "https://pactnetwork.io",  // default
  syncEnabled: true,                      // default false; enable for backend sync
  syncIntervalMs: 30_000,                 // default
  syncBatchSize: 100,                     // default
  latencyThresholdMs: 5_000,              // classify > this as "timeout"
  storagePath: "",                        // default ~/.pact-monitor/records.jsonl
  agentPubkey: "",                        // Solana base58 pubkey; required for on-chain claim attribution
  keypair: undefined,                     // Solana Keypair-like { publicKey, secretKey } — required to sign batches (anti-fraud)
});
```

Minimal (local recording only, no sync):

```typescript
const monitor = pactMonitor();
```

### Step 3 — Replace `fetch()`

`monitor.fetch()` is a drop-in replacement:

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
  usdcAmount: 0.01,                                          // whole USDC; use when no x402/MPP headers are present
});
```

### Step 4 — Anti-Fraud Signing (Required for sync in production)

When syncing to the backend, the SDK signs each batch with an Ed25519 keypair so the backend can verify it came from the agent. Pass a `keypair` in config:

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

The SDK currently logs a warning if `syncEnabled + apiKey` are set without a `keypair`; future versions will reject unsigned batches outright.

### Step 5 — Event Hooks (Optional)

```typescript
monitor.on("failure", (record) => {
  // record.classification: "timeout" | "error" | "schema_mismatch"
  // record.statusCode, record.hostname, record.latencyMs
  console.warn(`[${record.hostname}] failed: ${record.classification} ${record.statusCode}`);
});

monitor.on("billed", ({ callCost }) => {
  // callCost in whole USDC (0 if no payment data present)
});
```

Events fire in-process for agent-side alerting/metrics. They do NOT trigger claim submission — the backend handles that when it receives the synced record.

### Step 6 — Local Reads

```typescript
monitor.getStats();                            // { total, byClassification, byHostname, ... }
monitor.getRecords({ limit: 50, provider: "api.helius.xyz" });
```

### Step 7 — Shutdown

```typescript
process.on("SIGINT", () => {
  monitor.shutdown();  // flushes pending batch, stops sync loop
  process.exit(0);
});

// Fastify:
server.addHook("onClose", async () => monitor.shutdown());
```

---

## Mode B — Monitor + Insurance (Full On-Chain Flow)

### Step 1 — Install Both

```bash
npm install @pact-network/monitor @pact-network/insurance @solana/web3.js
```

### Step 2 — Agent Keypair

The insurance SDK pays on-chain fees and signs policy transactions with an agent Solana keypair. The monitor SDK uses the same keypair to sign record batches.

```typescript
import { Keypair } from "@solana/web3.js";
import fs from "fs";

const agent = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(process.env.AGENT_KEYPAIR_PATH, "utf-8"))),
);
```

Pre-reqs for the agent: SOL for fees + USDC in its associated token account for premium delegation.

### Step 3 — Initialize Insurance

```typescript
import { PactInsurance } from "@pact-network/insurance";

const insurance = new PactInsurance(
  {
    rpcUrl: process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
    programId: process.env.SOLANA_PROGRAM_ID!,   // Pact insurance program ID
    backendUrl: "https://pactnetwork.io",         // optional; required for submitClaim()
    apiKey: process.env.PACT_API_KEY,             // optional; sent as Bearer on submitClaim
  },
  agent,
);
```

### Step 4 — Enable a Policy

Creates a `policy` PDA and delegates a USDC allowance from the agent's ATA to the pool:

```typescript
const sig = await insurance.enableInsurance({
  providerHostname: "api.coingecko.com",
  allowanceUsdc: 10_000_000n,                                    // 10 USDC (6 decimals)
  expiresAt: BigInt(Math.floor(Date.now() / 1000) + 30 * 86400), // must be strictly future
  agentId: `agent-${Date.now().toString(36)}`,                   // optional; defaults to first 16 chars of pubkey
});
```

### Step 5 — Estimate Premium

```typescript
const estimate = await insurance.estimateCoverage("api.coingecko.com", 10_000n); // 0.01 USDC call
// { rateBps, perCallPremium, estimatedCalls }
```

### Step 6 — Read Policy State

```typescript
const policy = await insurance.getPolicy("api.coingecko.com");
// { pool, agent, agentId, totalPremiumsPaid, totalClaimsReceived,
//   callsCovered, active, expiresAt, delegatedAmount, remainingAllowance, ... }

const all = await insurance.listPolicies(); // all policies for this agent
```

### Step 7 — Top Up Delegation

When the delegated allowance runs low:

```typescript
await insurance.topUpDelegation({
  providerHostname: "api.coingecko.com",
  newTotalAllowanceUsdc: 50_000_000n, // 50 USDC
});
```

### Step 8 — Submit Claim (Manual)

Normally the Pact backend auto-submits claims when it sees a failed record. Use `submitClaim` only for retry paths or agent-triggered claims:

```typescript
const result = await insurance.submitClaim("api.coingecko.com", callRecordIdFromBackend);
// { signature, slot, refundAmount }
```

### Step 9 — Wire Monitor + Insurance

```typescript
const monitor = pactMonitor({
  apiKey: process.env.PACT_API_KEY,
  syncEnabled: true,
  agentPubkey: agent.publicKey.toBase58(),
  keypair: { publicKey: agent.publicKey.toBytes(), secretKey: agent.secretKey },
});

// Log failures locally. Backend handles the claim automatically.
monitor.on("failure", (record) => {
  console.warn(`[failure] ${record.hostname} ${record.classification}`);
});

// Make monitored calls.
await monitor.fetch("https://api.coingecko.com/api/v3/...", {}, { usdcAmount: 0.01 });
```

Shutdown:

```typescript
monitor.shutdown();
```

---

## Common Patterns

### AI agent framework (Anthropic SDK, OpenAI, etc.)

```typescript
import Anthropic from "@anthropic-ai/sdk";

const monitor = pactMonitor({ /* ... */ });
const client = new Anthropic({
  fetch: monitor.fetch,  // pass monitor.fetch as the custom fetch
});
```

### Express / Fastify

```typescript
// Fastify
server.addHook("onClose", async () => monitor.shutdown());

// Express
process.on("SIGTERM", () => { monitor.shutdown(); process.exit(0); });
```

### Next.js (server-only)

Initialize the monitor in a server module (never in a React component) and import from route handlers / server actions.

---

## Troubleshooting

**`[pact-monitor] agentPubkey missing` warning**
Sync is enabled but `agentPubkey` is empty. Records still sync, but no on-chain claim can be attributed. Set `agentPubkey: agent.publicKey.toBase58()`.

**`[pact-monitor] keypair not provided` warning**
Sync is enabled but batches aren't signed. The backend currently accepts unsigned batches but will reject them in a future version. Pass a `keypair`.

**`enableInsurance` throws "ConstraintHasOne" or similar**
The pool for that hostname doesn't exist on-chain. Seed it first with `packages/program/scripts/seed-devnet-pools.ts` or pick a hostname that has a live pool.

**`submitClaim` throws "backendUrl required to submit claim"**
The `PactInsurance` config omitted `backendUrl`. Add it — claims go through the backend, not directly on-chain.

**Monitor records not appearing in the scorecard**
Check that `syncEnabled: true`, `apiKey` is valid, and `backendUrl` points at a reachable backend. Local records are stored at `~/.pact-monitor/records.jsonl` regardless — inspect that file to confirm the SDK is recording.

---

## Reference Samples (in pact-monitor monorepo)

- `samples/agent-integration/basic.ts` — 10-line monitor integration
- `samples/agent-integration/with-schema-validation.ts` — detect broken API responses
- `samples/agent-integration/with-x402.ts` — manual USDC amount per call
- `samples/demo/insurance-basic.ts` — standalone `PactInsurance`
- `samples/demo/monitor-plus-insurance.ts` — both SDKs composed
- `samples/demo/insured-agent.ts` — full Phase 3 on-chain flow with explorer links

Source: https://github.com/solder-build/pact-monitor/tree/main/samples
