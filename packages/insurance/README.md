# @pact-network/insurance

TypeScript SDK for [Pact Network](https://pactnetwork.io)'s on-chain parametric insurance program on Solana. Enable coverage for an agent against a specific API provider, top up USDC delegations, query pool state, and submit claims when the provider fails.

Pact Network monitors API provider reliability in real time, computes actuarially-derived insurance rates from observed failure data, and pays out claims automatically when covered calls fail. This SDK is the Anchor client that agents use to interact with the insurance program.

## Install

```bash
npm install @pact-network/insurance
```

## Quick start

```ts
import { PactInsurance } from "@pact-network/insurance";
import { Keypair } from "@solana/web3.js";

const insurance = new PactInsurance({
  rpcUrl: "https://api.mainnet-beta.solana.com",
  programId: "<pact-insurance-program-id>",
});

const agentKeypair = Keypair.generate();

// Enable insurance coverage for an API provider with a USDC allowance
await insurance.enableInsurance(agentKeypair, {
  providerHostname: "api.example.com",
  allowanceUsdc: 10_000_000n, // 10 USDC in base units
});
```

## Features

- **`enableInsurance`** — Create an agent insurance policy for a given provider and delegate a USDC allowance to the pool.
- **`topUpDelegation`** — Increase the delegated USDC allowance for an existing policy.
- **`getPolicy`** — Read policy state (premiums paid, claims received, remaining allowance, etc.).
- **`submitClaim`** — Submit a claim with backend-signed proof of a failed covered call.
- **`estimateCoverage`** — Given the current provider rate, estimate how many calls a USDC allowance will cover.

See [`src/types.ts`](./src/types.ts) for the full type definitions and [`src/client.ts`](./src/client.ts) for all methods.

## IDL

The program IDL is bundled at [`idl/pact_insurance.json`](./idl/pact_insurance.json) as **data only**. The `address` field inside that file reflects whichever deploy was current when the SDK was published (devnet today, mainnet later) and **is never used at runtime** — the SDK overrides it with the `programId` you pass to `PactInsurance`. This makes the SDK program-ID-agnostic: a consumer pinned to an older SDK version will still talk to whatever deploy you point them at via config.

You can import the IDL directly if you need to build custom Anchor instructions, but you must supply your own program ID:

```ts
import idl from "@pact-network/insurance/idl/pact_insurance.json" with { type: "json" };
```

## Configuration

```ts
new PactInsurance({
  rpcUrl: "https://api.mainnet-beta.solana.com",
  programId: "<program-id>",             // required — authoritative, overrides IDL
  backendUrl: "https://pactnetwork.io",  // optional, for claim signing
  apiKey: "...",                         // optional
});
```

## License

MIT — see [LICENSE](./LICENSE).
