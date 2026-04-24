# `@pact-network/backend`

Fastify API server for Pact Network. Aggregates monitoring records, computes
actuarial insurance rates, settles claims on-chain, and exposes the public
scorecard + premium + sandbox endpoints.

## Env vars

| Var | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string. Default `postgresql://pact:pact@localhost:5433/pact`. |
| `SOLANA_RPC_URL` | yes | RPC endpoint. Genesis-hash detection at boot populates the devnet/mainnet gate. |
| `SOLANA_PROGRAM_ID` | yes | Deployed pact_insurance program. |
| `USDC_MINT` | yes | USDC mint (devnet test mint in dev, canonical USDC in prod). |
| `ORACLE_KEYPAIR_BASE58` / `ORACLE_KEYPAIR_PATH` | yes | Oracle signer (rate updates, claim submission). Prefer base58 for managed envs. |
| `FAUCET_KEYPAIR_BASE58` / `FAUCET_KEYPAIR_PATH` | devnet | Faucet USDC minter. |
| `SANDBOX_KEYPAIRS_BASE58` / `SANDBOX_KEYPAIRS_DIR` | devnet F3 | Comma-separated base58 secret keys, or a directory of JSON keypair files. Required for `POST /api/v1/devnet/sandbox/inject-failure`. |
| `PACT_PUBLIC_URL` | no | Value returned as `source` in `GET /api/v1/premium/:hostname`. Default `https://pact.solder.build`. |
| `CORS_ORIGINS` | no | Comma-separated allowed origins. Default `https://pactnetwork.io,http://localhost:5173`. |
| `PORT` | no | HTTP port. Default 3001. |
| `REQUIRE_RECORD_SIGNATURES` | no | `true` to enforce ed25519 sigs on `/api/v1/records`. |
| `ADMIN_TOKEN` | yes | Bearer token for admin endpoints. |

## Run

```sh
# Workspace root
pnpm --filter @pact-network/backend dev
```

## Endpoints (Phase 5)

### `GET /api/v1/premium/:hostname` — public

Schema-versioned, 60s cacheable. Returns canonical premium + reliability
stats for a hostname.

```sh
curl -s https://pactnetwork.io/api/v1/premium/api.example.com | jq
# {
#   "schema_version": 1,
#   "hostname": "api.example.com",
#   "premium": { "rateBps": 87, "tier": "elevated" },
#   "reliability": { "failureRate": 0.012, "sampleSize": 4821, "windowSeconds": 604800 },
#   "asOf": "2026-04-24T14:12:00Z",
#   "source": "https://pact.solder.build",
#   "settlement": "pact_network_v1"
# }
```

Hostname is canonicalized server-side (`api.example.com`, `API.EXAMPLE.COM`,
`https://api.example.com/v0/x` all resolve the same). 404
`{ schema_version, error: "not_tracked", hostname }` on unknown hosts — never
a default rate.

### `POST /api/v1/devnet/sandbox/inject-failure` — devnet only

Hard-gated by the genesis-hash check at boot. Returns 403 on any non-devnet
deployment. API-key auth. 10 injections per key per hour.

```sh
curl -s -X POST https://pactnetwork.io/api/v1/devnet/sandbox/inject-failure \
  -H "Authorization: Bearer $PACT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "schema_version": 1,
    "hostname": "api.test-provider.example",
    "classification": "provider_5xx",
    "simulated_latency_ms": 500
  }' | jq
```

Supported `classification` values: `provider_5xx`, `provider_timeout`,
`provider_rate_limit`. Unknown → 400.

Pool exhaustion (all 5 keypairs in flight) → 503 + `Retry-After: 30`. Refill
via `bash scripts/topup-sandbox-pool.sh` (see root scripts dir).

### `GET /api/v1/providers`, `GET /api/v1/providers/:id`, etc.

Pre-Phase-5 endpoints. See repo root README for the full list.

## Tests

```sh
DATABASE_URL=postgresql://pact:pact@localhost:5433/pact \
  pnpm --filter @pact-network/backend test
```

## Migrations

See [`migrations/README.md`](./migrations/README.md). One-off runtime
scripts, not a managed migration framework. Each script is idempotent and
self-describing.
