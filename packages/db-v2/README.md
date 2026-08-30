# @pact-network/db-v2

Prisma schema + generated client for the V2 off-chain rails. Companion
to `@pact-network/db` (V1). V1 and V2 packages coexist with separate
`DATABASE_URL` env vars by default.

## Schema

Nine models split by authoritative source (see `prisma/schema.prisma`
header):

| Owned by | Models |
|---|---|
| Watcher (Helius webhook / programSubscribe) | `V2ProtocolConfig`, `V2Pool`, `V2Position`, `V2Policy` |
| `/events` ingest from settler-v2 | `V2PremiumSettlement`, `V2Claim` |
| Off-chain bookkeeping | `V2PremiumAttempt` (cranker idempotency ledger), `V2Agent` (denormalized rollup), `V2OperatorAllowlist` |

All on-chain account-backed models carry a `slot` column for
last-write-wins on the watcher path.

`callIdHash` is uniformly 64-char lowercase sha256 hex; both the
cranker (via `hashCallId` from `@q3labs/pact-protocol-v2-client`) and
the watcher (hex-encoding the 32-byte `Claim.callId` digest) write the
same value.

## Build

```bash
pnpm install
PG_V2_URL="postgresql://placeholder" pnpm --filter @pact-network/db-v2 build
```

## Run migrations

```bash
PG_V2_URL=postgres://user:pass@host:5432/pact_v2 \
  pnpm --filter @pact-network/db-v2 db:migrate
```

`prisma/migrations/20260520000000_init_v2/migration.sql` is the initial
schema. Use `db:migrate:dev` to author a new migration after schema
edits.

## Cohabitation with `@pact-network/db` (V1)

Default: separate `DATABASE_URL` (V1) + `PG_V2_URL` (V2), same Postgres
instance, two databases. This keeps prisma migrations independent and
sidesteps Prisma 5.22's `multiSchema` preview + Cloud SQL connection-
string quirks.

Opt-in single-DB-multi-schema (advanced):
`PG_V2_URL=postgres://...?options=--search_path%3Dv2` works but
requires Postgres 15+ and you must ensure the `v2` schema exists.
