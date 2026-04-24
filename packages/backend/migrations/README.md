# Backend migrations

One-off runtime scripts executed manually against a specific environment.
Not a managed migration framework — each script is idempotent and self-describing.

## 20260422-canonicalize-hostnames.ts

**When to run:** once per environment before the Phase 5 ingest/route changes go live.

**What it does:** collapses `providers` rows that canonicalize to the same hostname
(`api.helius.xyz`, `API.Helius.XYZ`, `https://api.helius.xyz/v0/...`) into a single
canonical row. Re-parents every `call_records`, `claims`, `premium_adjustments`,
and `outage_events` row that referenced a loser row, backfills `wallet_address`
from the first non-null loser, rewrites the winner's `base_url` to the canonical
form, and deletes the loser rows. Everything runs in a single transaction.

**Run (dry-run first):**
```sh
DATABASE_URL=postgres://... pnpm --filter @pact-network/backend \
  exec tsx migrations/20260422-canonicalize-hostnames.ts --dry-run
```

**Apply:**
```sh
DATABASE_URL=postgres://... pnpm --filter @pact-network/backend \
  run migrate:canonicalize-hostnames
```

**Idempotent.** Re-running after a successful apply is a no-op — all providers
are already canonical and unique.

**Scope:** DB only. On-chain `CoveragePool` PDAs minted under non-canonical
hostnames (if any exist on devnet) are not touched. Phase 5 ingest canonicalizes
before PDA derivation so no new duplicates are created; the Pinocchio redeploy
resets on-chain state separately.
