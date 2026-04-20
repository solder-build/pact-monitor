# @q3labs/pact-monitor

TypeScript SDK that wraps `fetch()` to monitor AI agent API reliability and sync call records to the [Pact Network](https://pactnetwork.io) scorecard.

Pact Network is a parametric micro-insurance system for AI agent API payments on Solana. The monitor SDK is the data source: it observes real API calls your agent makes, classifies each one as `success` / `timeout` / `error` / `schema_mismatch`, captures x402/MPP payment metadata when present, and ships the records to the backend so the network can compute actuarially-derived insurance rates for every provider.

## Install

```bash
npm install @q3labs/pact-monitor
```

## Quick start

```ts
import { pactMonitor } from "@q3labs/pact-monitor";

const monitor = pactMonitor({
  apiKey: process.env.PACT_API_KEY,
  // backendUrl defaults to https://pactnetwork.io
});

const res = await monitor.fetch("https://api.example.com/v1/data", {
  method: "GET",
});

const json = await res.json();
```

The SDK is a drop-in replacement for `fetch()`. If syncing to the backend fails, the wrapped fetch still returns normally — your agent never breaks because of monitoring.

### With schema validation

```ts
const res = await monitor.fetch(
  "https://api.example.com/v1/data",
  { method: "GET" },
  {
    expectedSchema: { type: "object", required: ["id", "value"] },
  },
);
```

Responses that don't match are classified as `schema_mismatch`.

### With x402 / MPP payment extraction

If the response carries x402 or MPP headers (`X-Payment-*`), the SDK extracts the payment metadata (amount, asset, network, tx hash, settlement status) and includes it in the call record automatically.

## Configuration

```ts
pactMonitor({
  apiKey: "...",                    // required for sync
  backendUrl: "https://pactnetwork.io",
  syncEnabled: true,
  syncIntervalMs: 30_000,
  syncBatchSize: 50,
  latencyThresholdMs: 30_000,       // classify as timeout above this
  storagePath: ".pact/records.jsonl",
  keypair: { publicKey, secretKey },  // for signed records
});
```

See [`src/types.ts`](./src/types.ts) for the full option and record shapes.

## How records are signed

When a keypair is provided, each batch sent to the backend is Ed25519-signed via `tweetnacl` and base58-encoded with `bs58`. The backend verifies the signature against the registered agent public key. See `src/signing.ts` for the exact payload format.

## License

MIT — see [LICENSE](./LICENSE).
