# Pact Network — Samples

## demo/
Live runnable demos. Call real Solana APIs through the SDK and sync to the local backend. Point the scorecard at the same backend to see things update in real time.

### `monitor.ts` — Phase 1/2 reliability monitoring
Hits 5 canonical providers in rounds, records to backend, prints a latency/failure summary.

```bash
cd samples/demo
pnpm tsx monitor.ts          # default 5 rounds
pnpm tsx monitor.ts 10       # custom rounds
```

### `insured-agent.ts` — Phase 3 full on-chain flow
Creates a fresh agent keypair, funds it with test USDC, enables on-chain insurance on a target pool via SPL delegation, runs N successful calls + 1 forced failure through the monitor SDK, then shows the pool state delta including a real on-chain refund.

```bash
cd samples/demo
pnpm tsx insured-agent.ts api.dexscreener.com 3
pnpm tsx insured-agent.ts api.coingecko.com 5
```

Pre-reqs: backend + postgres running, pools seeded (`seed-devnet-pools.ts`), Phantom wallet funded on devnet.

## playground/
Browser-based monitor playground. Paste any URL, click Monitor, see the result. Open `samples/playground/index.html` in your browser.

## agent-integration/
Copy-paste examples for integrating the SDK into your agent:
- `basic.ts` — Minimal 10-line integration
- `with-schema-validation.ts` — Detect broken API responses
- `with-x402.ts` — Track USDC payment amounts
