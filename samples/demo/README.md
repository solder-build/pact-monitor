# Pact Network — Demo Scripts

Runnable demos that exercise both SDKs (`@q3labs/pact-monitor` and
`@q3labs/pact-insurance`) against real Solana APIs and a local backend.

## Setup

```bash
cd samples/demo
cp .env.example .env
```

Edit `.env` with your Pact API key (generate with `pnpm run generate-key demo` from project root).

Optionally add Helius/QuickNode keys for more providers.

## Monitor demos

### `monitor.ts` — live reliability monitoring
```bash
pnpm tsx monitor.ts          # default 5 rounds
pnpm tsx monitor.ts 10       # custom rounds
```

Open the scorecard at http://localhost:5173 to see results appear live.

## Insurance demos

All insurance demos require a funded Solana keypair (SOL for fees + USDC
in ATA), an existing pool on-chain for the target hostname, and
`$PACT_AGENT_KEYPAIR_PATH` set (defaults to `~/.config/solana/id.json`).

### `insurance-basic.ts` — standalone insurance SDK
```bash
pnpm tsx insurance-basic.ts api.coingecko.com
```
`PactInsurance` by itself: enable a policy, estimate per-call premium,
read policy state. No monitor wiring.

### `monitor-plus-insurance.ts` — both SDKs composed
```bash
pnpm tsx monitor-plus-insurance.ts api.coingecko.com
```
Wires both SDKs: `monitor.fetch()` records calls with a signed batch keypair,
`PactInsurance` owns the on-chain policy, `monitor.on("failure")` hooks
local alerting. Backend auto-submits claims; shows the manual
`insurance.submitClaim()` path too.

### `insured-agent.ts` — full end-to-end flow
```bash
pnpm tsx insured-agent.ts api.dexscreener.com 3
pnpm tsx insured-agent.ts api.coingecko.com 5
```
Flagship demo: generates a fresh agent, funds it with test USDC from a
phantom mint authority, enables insurance, runs N successful + 1 forced
failure call, and prints on-chain pool deltas + explorer links.

Pre-reqs: backend + postgres running, pools seeded (`seed-devnet-pools.ts`),
Phantom wallet funded on devnet.
