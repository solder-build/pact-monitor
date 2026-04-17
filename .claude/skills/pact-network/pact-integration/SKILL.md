---
name: pact-integration
description: "Use when wiring @pact-network/monitor and @pact-network/insurance together in the same agent, or integrating Pact into an AI framework (Anthropic/OpenAI SDK, Express, Fastify, Next.js). Examples: \"connect monitor and insurance\", \"use Pact with the Anthropic SDK\", \"add Pact to my Fastify server\""
---

# Pact Monitor + Insurance — Composed Integration

Most agents want both SDKs active: `monitor` records reliability evidence with signed batches, `insurance` owns the on-chain policy. The Pact backend auto-submits claims when it receives failed records — the agent's job is just to feed it good data.

## Minimum Wiring

```typescript
import { Keypair } from "@solana/web3.js";
import { pactMonitor } from "@pact-network/monitor";
import { PactInsurance } from "@pact-network/insurance";
import fs from "fs";

const agent = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(process.env.AGENT_KEYPAIR_PATH, "utf-8"))),
);

const insurance = new PactInsurance(
  {
    rpcUrl: process.env.SOLANA_RPC_URL!,
    programId: process.env.SOLANA_PROGRAM_ID!,
    backendUrl: "https://pactnetwork.io",
    apiKey: process.env.PACT_API_KEY,
  },
  agent,
);

const monitor = pactMonitor({
  apiKey: process.env.PACT_API_KEY,
  syncEnabled: true,
  agentPubkey: agent.publicKey.toBase58(),
  keypair: { publicKey: agent.publicKey.toBytes(), secretKey: agent.secretKey },
});

// Local alerting hook (optional).
monitor.on("failure", (record) => {
  console.warn(`[failure] ${record.hostname} ${record.classification}`);
});

// Enable once per provider.
await insurance.enableInsurance({
  providerHostname: "api.coingecko.com",
  allowanceUsdc: 10_000_000n,
  expiresAt: BigInt(Math.floor(Date.now() / 1000) + 30 * 86400),
});

// Make monitored calls.
const res = await monitor.fetch(
  "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
  {},
  { usdcAmount: 0.01 },
);
```

## Claim Flow (No Extra Code Needed)

1. `monitor.fetch()` records a failed call.
2. Monitor syncs a signed batch to the backend on the next interval.
3. Backend verifies the signature, attributes the record to the agent pubkey.
4. Backend auto-submits `submit_claim` on-chain from the pool vault.
5. USDC lands in the agent's ATA. The `policy.totalClaimsReceived` ticks up.

You can inspect via:

```typescript
const policy = await insurance.getPolicy("api.coingecko.com");
console.log(`total refunded: ${policy?.totalClaimsReceived}`);
```

## Manual Claim (Retry Path Only)

```typescript
// If backend failed to auto-submit — rare, but possible during incidents.
await insurance.submitClaim("api.coingecko.com", callRecordIdFromBackend);
```

## Framework Patterns

### Anthropic SDK / OpenAI SDK (any `fetch`-pluggable client)

```typescript
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  fetch: monitor.fetch, // drop-in custom fetch
});
```

Calls through the SDK are automatically tracked. Use `usdcAmount` per-request if the endpoint doesn't emit x402/MPP headers.

### Fastify

```typescript
import Fastify from "fastify";

const server = Fastify();
server.decorate("pact", { monitor, insurance });

server.addHook("onClose", async () => monitor.shutdown());

server.get("/price/:id", async (req, reply) => {
  const res = await monitor.fetch(
    `https://api.coingecko.com/api/v3/simple/price?ids=${req.params.id}&vs_currencies=usd`,
    {},
    { usdcAmount: 0.01 },
  );
  return res.json();
});
```

### Express

```typescript
import express from "express";

const app = express();

process.on("SIGTERM", () => {
  monitor.shutdown();
  process.exit(0);
});

app.get("/call", async (req, res) => {
  const result = await monitor.fetch(req.query.url as string);
  res.json(await result.json());
});
```

### Next.js (server-only)

Place monitor init in a server-only module (never in a React component):

```typescript
// lib/pact.ts  (server-only)
import "server-only";
import { pactMonitor } from "@pact-network/monitor";

export const monitor = pactMonitor({ /* ... */ });
```

Import from route handlers / server actions — never from client components.

## Graceful Shutdown

```typescript
async function shutdown() {
  monitor.shutdown();
  // insurance has no background timers to stop
}

process.on("SIGINT", () => { shutdown(); process.exit(0); });
process.on("SIGTERM", () => { shutdown(); process.exit(0); });
```

## Reference Samples

- `samples/demo/monitor-plus-insurance.ts` — minimal composed example
- `samples/demo/insured-agent.ts` — full Phase 3 flow with funded agent, forced failure, explorer links

## Related

- `pact-network-guide` — overview, decide which SDK
- `pact-monitor` — monitor SDK on its own
- `pact-insurance` — insurance SDK on its own
