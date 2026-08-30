# @pact-network/settler-v2

V2 oracle-cranker. Consumes `V2SettlementEvent` from Pub/Sub (or Redis
Streams on devnet), composes `settle_premium` and `submit_claim`
instructions via `@q3labs/pact-protocol-v2-client`, submits + confirms,
and pushes ledger rows to `indexer-v2`.

## Two pipelines, two subscriptions

- **Premium pipeline** (every call): `PUBSUB_TOPIC_PREMIUM_V2`.
  `Batcher` groups by hostname (so pool+vault accounts dedupe across
  ix in one tx), flushes at `MAX_IXS_PER_TX` (default 6) or
  `FLUSH_INTERVAL_MS` (default 5s).
- **Claim pipeline** (breach-only): `PUBSUB_TOPIC_CLAIM_V2`. Single-ix
  per tx — each Claim PDA is unique so batching has no efficiency win.

## Idempotency

Premium has no on-chain dedupe (`settle_premium` writes only counters):
the cranker keeps an off-chain `V2PremiumAttempt` ledger keyed by raw
`callId`. On Pub/Sub redelivery, `status=Confirmed` → ack-and-skip
(no double-spend).

Claim dedupes on the Claim PDA itself: on retry, derive `getClaimPda(...)`
and `getAccountInfo` — if present, ack-skip the message.

## Env

| Var | Required | Notes |
|---|---|---|
| `SOLANA_RPC_URL` | yes | RPC endpoint |
| `ORACLE_KEY` | yes | bs58 secret or `projects/.../secrets/.../versions/N` |
| `INDEXER_V2_URL` / `INDEXER_V2_PUSH_SECRET` | yes | bearer auth to indexer-v2 |
| `PG_V2_URL` | yes | `V2PremiumAttempt` ledger |
| `PROGRAM_ID` | optional | defaults to V2 `declare_id` from client |
| `USDC_MINT` | optional | defaults to devnet USDC |
| `QUEUE_BACKEND` | optional | `pubsub` (default) or `redis-streams` |
| `PUBSUB_PROJECT`, `PUBSUB_SUBSCRIPTION_PREMIUM`, `PUBSUB_SUBSCRIPTION_CLAIM` | conditional | when `QUEUE_BACKEND=pubsub` |
| `REDIS_URL`, `REDIS_STREAM_PREMIUM`, `REDIS_STREAM_CLAIM` | conditional | when `QUEUE_BACKEND=redis-streams` |
| `MAX_IXS_PER_TX` | optional | default 6 |
| `CONFIRM_TIMEOUT_MS` | optional | default 30_000 |

## Build + test

```bash
pnpm --filter @pact-network/settler-v2 build
pnpm --filter @pact-network/settler-v2 test    # 24/24
```

## Run locally

```bash
ORACLE_KEY=<bs58>  \
PG_V2_URL=postgres://pact:pact@localhost:5432/pact_v2  \
INDEXER_V2_URL=http://localhost:8083  INDEXER_V2_PUSH_SECRET=dev  \
SOLANA_RPC_URL=https://api.devnet.solana.com  \
QUEUE_BACKEND=pubsub PUBSUB_PROJECT=pact-dev  \
PUBSUB_SUBSCRIPTION_PREMIUM=pact-v2-premium-sub  \
PUBSUB_SUBSCRIPTION_CLAIM=pact-v2-claim-sub  \
  pnpm --filter @pact-network/settler-v2 dev
```

## Production safety

`unsafe-bypass-deployer` is a V2-program-level Cargo feature, not an
env var here — settler-v2 talks to whatever program is deployed at
`PROGRAM_ID`. Make sure the deployed `.so` was built WITHOUT
`--features unsafe-bypass-deployer` before pointing settler-v2 at it
on mainnet.

Oracle key custody is the same hot-key problem as V1's
`SETTLEMENT_AUTHORITY_KEY`. Pre-mainnet rotate to a threshold or
hardware-backed signer.
