---
name: pact-insurance
description: "Use when integrating @q3labs/pact-insurance — enabling an on-chain policy, estimating per-call premium, reading policy state, topping up USDC delegation, or submitting claims. Examples: \"enable insurance for this hostname\", \"refund a failed call\", \"check my policy\""
---

# Pact Insurance — SDK Integration

`@q3labs/pact-insurance` manages on-chain parametric insurance policies on Solana. Agents enable a policy per provider, delegate a USDC budget, and receive on-chain refunds when paid calls fail.

## Install

```bash
npm install @q3labs/pact-insurance @solana/web3.js
# or pnpm add @q3labs/pact-insurance @solana/web3.js
```

## Agent Keypair

The SDK pays fees and signs policy transactions with an agent Solana keypair. The agent's ATA must hold USDC (for premium delegation) and the wallet needs SOL (for fees).

```typescript
import { Keypair } from "@solana/web3.js";
import fs from "fs";

const agent = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(process.env.AGENT_KEYPAIR_PATH, "utf-8"))),
);
```

## Initialize

```typescript
import { PactInsurance } from "@q3labs/pact-insurance";

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

## Enable a Policy

Creates a `policy` PDA and delegates a USDC allowance from the agent's ATA to the pool:

```typescript
const sig = await insurance.enableInsurance({
  providerHostname: "api.coingecko.com",
  allowanceUsdc: 10_000_000n,                                    // 10 USDC (6 decimals)
  expiresAt: BigInt(Math.floor(Date.now() / 1000) + 30 * 86400), // must be strictly future
  agentId: `agent-${Date.now().toString(36)}`,                   // optional; defaults to first 16 chars of pubkey
});
```

## Estimate Premium

```typescript
const estimate = await insurance.estimateCoverage("api.coingecko.com", 10_000n); // 0.01 USDC call
// { rateBps, perCallPremium, estimatedCalls }
```

## Read Policy State

```typescript
const policy = await insurance.getPolicy("api.coingecko.com");
// {
//   pool, agent, agentId,
//   totalPremiumsPaid, totalClaimsReceived, callsCovered,
//   active, expiresAt,
//   delegatedAmount, remainingAllowance, ...
// }

const all = await insurance.listPolicies(); // all policies for this agent
```

## Top Up Delegation

When the delegated allowance runs low:

```typescript
await insurance.topUpDelegation({
  providerHostname: "api.coingecko.com",
  newTotalAllowanceUsdc: 50_000_000n, // 50 USDC
});
```

## Submit Claim (Manual)

Normally the Pact backend auto-submits claims when it sees a failed record. Use `submitClaim` only for retry paths or agent-triggered claims:

```typescript
const result = await insurance.submitClaim("api.coingecko.com", callRecordIdFromBackend);
// { signature, slot, refundAmount }
```

Requires `backendUrl` (and usually `apiKey`) to be set in config.

## Events

```typescript
insurance.on("billed", ({ callCost }) => {
  // fires per monitor-attributed call — requires the monitor SDK to be bound
});
insurance.on("low-balance", ({ remainingAllowance, threshold }) => {
  // emitted when remaining allowance approaches exhaustion
});
```

## Reference Samples

- `samples/demo/insurance-basic.ts` — standalone enable + estimate + getPolicy
- `samples/demo/monitor-plus-insurance.ts` — both SDKs wired together
- `samples/demo/insured-agent.ts` — full Phase 3 flow with explorer links

## Related

- `pact-network-guide` — overview, decide which SDK
- `pact-monitor` — wrapping fetch() with reliability tracking
- `pact-integration` — monitor + insurance composed
