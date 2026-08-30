# @pact-network/indexer-v2

V2 indexer service. Exposes the V2 read API, accepts settler-v2 ledger
events, and ingests on-chain account changes from Helius webhooks.

## Authoritative-source split

- **`/events`** path (settler-v2 push) writes ledger rows only:
  `V2PremiumSettlement`, `V2Claim`. Never mutates counter columns on
  `V2Pool` / `V2Policy`.
- **`/webhook`** path (Helius account-change posts) owns all on-chain
  account state — `V2Pool`, `V2Policy`, `V2Position`, `V2ProtocolConfig`,
  `V2Claim`. Last-write-wins on `slot` (older slot → no-op).

This split is the reason the cranker doesn't race the indexer on
counter increments — see plan critique #4 / Locked decision in the C5
commit message.

## Routes

### Ingest (bearer-gated)

```
POST /events/settle-premium       # settler-v2 premium pipeline
POST /events/submit-claim         # settler-v2 claim pipeline
POST /webhook/helius/accounts     # Helius account-change webhook
```

### Read API (public)

```
GET /api/v2/stats                                    # network rollup (5s cache)
GET /api/v2/pools?hostnameLike=&sort=&limit=
GET /api/v2/pools/:hostname
GET /api/v2/agents/:pubkey
GET /api/v2/agents/:pubkey/policies
GET /api/v2/agents/:pubkey/policies/:hostname
GET /api/v2/claims/:callIdHash                       # sha256 hex (64 chars)
GET /api/v2/underwriters/:pubkey/positions
GET /api/v2/calls/:signature
```

### Ops (operator-allowlist + nacl signed-message auth)

```
POST /api/v2/ops/pause
POST /api/v2/ops/unpause
POST /api/v2/ops/update-config
POST /api/v2/ops/update-oracle
POST /api/v2/ops/create-pool
POST /api/v2/ops/update-rates
```

Each returns
`{ unsignedTx, recentBlockhash, lastValidBlockHeight }` — a real
base64-encoded unsigned Solana `Transaction` (NOT V1's JSON-envelope
B6 bug). Operator's wallet signs + submits.

Auth body shape:

```json
{
  "signerPubkey": "<base58 pubkey>",
  "signedMessage": "${OPERATOR_NACL_DOMAIN}|${action}|${nonce}|${JSON.stringify(params)}",
  "signatureB58": "<base58 ed25519 signature over signedMessage>",
  "nonce": "<random per-request>",
  "params": { ... }
}
```

## Env

| Var | Required | Notes |
|---|---|---|
| `PG_V2_URL` | yes | `@pact-network/db-v2` DSN |
| `INDEXER_V2_PUSH_SECRET` | yes | bearer for `/events/*` (matches settler-v2 push) |
| `HELIUS_WEBHOOK_SECRET` | yes (if using webhooks) | bearer for `/webhook/helius/*` |
| `OPERATOR_NACL_DOMAIN` | optional | default `pact-network-v2-ops` |
| `PROGRAM_ID` | optional | defaults to V2 `declare_id` |
| `STATS_CACHE_TTL_MS` | optional | default 5_000 |
| `SOLANA_RPC_URL` | optional | for ops blockhash fetch; defaults to devnet |

## Build + test

```bash
pnpm --filter @pact-network/indexer-v2 build
pnpm --filter @pact-network/indexer-v2 test    # 23/23
```

## Account watcher: webhook vs programSubscribe

The C5 default is **Helius Webhooks** (stateless HTTP push to Cloud
Run). Alternative if you want self-hosted: deploy a sidecar service
running `connection.onProgramAccountChange` from a Compute Engine VM
or Cloud Run with `min-instances=1, cpu-always-allocated=true`, and
have it POST decoded changes to the same `/webhook/helius/accounts`
endpoint shape (the route accepts any source — the bearer guard is the
authentication boundary, not webhook provenance).

## testcontainers e2e (deferred)

Vitest spec files mock Prisma. Future work: testcontainers-node +
Postgres 16, one container per Vitest worker (`VITEST_POOL_ID`), template-DB
clone per file, `BEGIN/ROLLBACK` per test. See
[vitest-environment-prisma-postgres](https://github.com/codepunkt/vitest-environment-prisma-postgres)
for the pattern.
