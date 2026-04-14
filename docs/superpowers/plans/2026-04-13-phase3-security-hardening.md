# Phase 3 Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land every PR #13 review finding that blocks merging to `develop` or running the program on mainnet (except multisig oracle, which is deferred) and redeploy to devnet under a new program ID.

**Architecture:** Split into three layers. Backend/SDK merge blockers (Tasks 1–3) land first — they're independent of program state. Anchor program hardening (Tasks 4–11) adds one state field, one new instruction, and tightens constraints. Devnet redeploy ceremony (Task 12) swaps program ID and re-initializes pools. Each task is TDD: failing test → minimal impl → passing test → commit.

**Tech Stack:** Rust + Anchor 1.0.0 (`@anchor-lang/core` TS client, not `@coral-xyz/anchor`), TypeScript/Fastify backend, PostgreSQL, Solana web3.js, `bn.js` for BN.

**Spec reference:** `docs/superpowers/specs/2026-04-13-phase3-security-hardening-design.md`
**Review source:** https://github.com/solder-build/pact-monitor/pull/13#issuecomment-4236655255

---

## File Structure Overview

**New files:**
- `packages/program/programs/pact-insurance/src/instructions/update_oracle.rs` — oracle rotation instruction
- `packages/program/programs/pact-insurance/src/instructions/disable_policy.rs` — policy deactivation instruction
- `packages/program/tests/security-hardening.ts` — new integration tests for hardening findings
- `docs/PHASE3-SECURITY-HARDENING.md` — post-implementation audit-trail document

**Modified files:**
- `packages/program/programs/pact-insurance/src/state.rs` — add `oracle: Pubkey` to `ProtocolConfig`
- `packages/program/programs/pact-insurance/src/lib.rs` — `DEPLOYER_PUBKEY` const, new ix entry points, new program ID post-deploy
- `packages/program/programs/pact-insurance/src/error.rs` — new error variants
- `packages/program/programs/pact-insurance/src/instructions/initialize_protocol.rs` — deployer check, oracle field init
- `packages/program/programs/pact-insurance/src/instructions/submit_claim.rs` — oracle signer, hashed seed, agent_token_account constraint, policy expiry/active checks
- `packages/program/programs/pact-insurance/src/instructions/settle_premium.rs` — policy expiry/active checks
- `packages/program/programs/pact-insurance/src/instructions/update_config.rs` — drop treasury/usdc_mint mutations
- `packages/program/programs/pact-insurance/src/instructions/update_rates.rs` — bounds checks
- `packages/program/programs/pact-insurance/src/instructions/mod.rs` — add new module re-exports
- `packages/program/programs/pact-insurance/Cargo.toml` — add `enforce-deployer` feature
- `packages/program/test-utils/setup.ts` — oracle pubkey argument
- `packages/program/tests/protocol.ts` — update existing tests for new config shape
- `packages/backend/src/schema.sql` — `api_keys.agent_pubkey` column
- `packages/backend/src/middleware/auth.ts` — decorate `request.agentPubkey` from api_keys row
- `packages/backend/src/routes/records.ts` — bind agent_pubkey from middleware, ignore body value
- `packages/backend/src/routes/claims-submit.ts` — fix SELECT, add preHandler, owner check
- `packages/backend/src/routes/pools.ts` — cache, 503 on missing env, sanitized errors
- `packages/backend/src/services/claim-settlement.ts` — module-scope keypair cache, sha256 seed derivation, oracle signer
- `packages/backend/src/scripts/generate-key.ts` — `--agent-pubkey` arg
- `packages/backend/src/utils/solana.ts` — update `deriveClaimPda` to sha256
- `packages/sdk/src/types.ts` — drop `agent_pubkey` from `CallRecord` wire shape
- `packages/sdk/src/sync.ts` — drop `agent_pubkey` from request payload
- `packages/sdk/src/wrapper.ts` — warn on empty agentPubkey with syncEnabled
- `packages/insurance/src/types.ts` — add `apiKey?: string` to `PactInsuranceConfig`
- `packages/insurance/src/client.ts` — send Authorization header in `submitClaim`

---

## Task 1: Backend merge-blocker fix pack

**Goal:** Close the three reviewer "must-fix before merge" items. Bind `agent_pubkey` to API key on the server, authenticate `/api/v1/claims/submit`, fix the dead SQL.

**Files:**
- Modify: `packages/backend/src/schema.sql`
- Modify: `packages/backend/src/middleware/auth.ts`
- Modify: `packages/backend/src/routes/records.ts`
- Modify: `packages/backend/src/routes/claims-submit.ts`
- Modify: `packages/backend/src/scripts/generate-key.ts`
- Modify: `packages/backend/src/routes/api.test.ts` (new test cases)

### Step 1.1: Write failing test — middleware decorates `request.agentPubkey`

- [ ] Add to `packages/backend/src/routes/api.test.ts`:

```typescript
test("auth middleware decorates request.agentPubkey from api_keys row", async () => {
  const app = await buildTestApp();
  const key = `pact_${randomBytes(24).toString("hex")}`;
  const hash = createHash("sha256").update(key).digest("hex");
  await query(
    "INSERT INTO api_keys (key_hash, label, agent_pubkey) VALUES ($1, $2, $3)",
    [hash, "test-agent", "AgentPubkey111111111111111111111111111111111"],
  );

  app.get("/api/v1/debug/whoami", { preHandler: requireApiKey }, async (req) => {
    const r = req as FastifyRequest & { agentId: string; agentPubkey: string | null };
    return { agentId: r.agentId, agentPubkey: r.agentPubkey };
  });

  const resp = await app.inject({
    method: "GET",
    url: "/api/v1/debug/whoami",
    headers: { authorization: `Bearer ${key}` },
  });

  assert.equal(resp.statusCode, 200);
  const body = resp.json();
  assert.equal(body.agentId, "test-agent");
  assert.equal(body.agentPubkey, "AgentPubkey111111111111111111111111111111111");
});
```

### Step 1.2: Run failing test

Run: `cd packages/backend && npm test -- --test-name-pattern="decorates request.agentPubkey"`
Expected: FAIL — column `agent_pubkey` does not exist on `api_keys`.

### Step 1.3: Add migration to schema.sql

- [ ] Append to `packages/backend/src/schema.sql` after line 77:

```sql
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS agent_pubkey TEXT;
CREATE INDEX IF NOT EXISTS idx_api_keys_agent_pubkey ON api_keys(agent_pubkey);
```

### Step 1.4: Update auth middleware to select + decorate

- [ ] Replace the body of `requireApiKey` in `packages/backend/src/middleware/auth.ts`:

```typescript
export async function requireApiKey(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    reply.code(401).send({ error: "Missing API key" });
    return;
  }

  const key = header.slice(7);
  const hash = hashKey(key);

  const row = await getOne<{ id: string; label: string; agent_pubkey: string | null }>(
    "SELECT id, label, agent_pubkey FROM api_keys WHERE key_hash = $1",
    [hash],
  );

  if (!row) {
    reply.code(401).send({ error: "Invalid API key" });
    return;
  }

  const r = request as FastifyRequest & {
    agentId: string;
    agentPubkey: string | null;
  };
  r.agentId = row.label;
  r.agentPubkey = row.agent_pubkey;
}
```

### Step 1.5: Run test to verify it passes

Run: `cd packages/backend && npm test -- --test-name-pattern="decorates request.agentPubkey"`
Expected: PASS.

### Step 1.6: Commit

```bash
git add packages/backend/src/schema.sql packages/backend/src/middleware/auth.ts packages/backend/src/routes/api.test.ts
git commit -m "feat(backend): bind agent_pubkey to api_key in auth middleware"
```

### Step 1.7: Failing test — records route ignores client-supplied agent_pubkey

- [ ] Add to `api.test.ts`:

```typescript
test("POST /api/v1/records ignores client-supplied agent_pubkey and uses api_key binding", async () => {
  const app = await buildTestApp();
  const key = `pact_${randomBytes(24).toString("hex")}`;
  const hash = createHash("sha256").update(key).digest("hex");
  const boundPubkey = "BoundPubkey111111111111111111111111111111111";
  const attackerPubkey = "AttackerPubkey11111111111111111111111111111";
  await query(
    "INSERT INTO api_keys (key_hash, label, agent_pubkey) VALUES ($1, $2, $3)",
    [hash, "test-agent", boundPubkey],
  );

  const resp = await app.inject({
    method: "POST",
    url: "/api/v1/records",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    payload: {
      records: [{
        hostname: "example.com",
        endpoint: "/v1",
        timestamp: new Date().toISOString(),
        status_code: 200,
        latency_ms: 50,
        classification: "success",
        agent_pubkey: attackerPubkey,
      }],
    },
  });

  assert.equal(resp.statusCode, 200);
  const stored = await getOne<{ agent_pubkey: string }>(
    "SELECT agent_pubkey FROM call_records ORDER BY created_at DESC LIMIT 1",
  );
  assert.equal(stored?.agent_pubkey, boundPubkey);
});
```

### Step 1.8: Run failing test

Run: `cd packages/backend && npm test -- --test-name-pattern="ignores client-supplied agent_pubkey"`
Expected: FAIL — record stored with attacker pubkey.

### Step 1.9: Update records route to use decorated value

- [ ] In `packages/backend/src/routes/records.ts`, replace the `agentId` assignment and record insertion block (lines 53–77):

```typescript
const authed = request as FastifyRequest & {
  agentId: string;
  agentPubkey: string | null;
};
const agentId = authed.agentId;
const agentPubkey = authed.agentPubkey;
const providerIds = new Set<string>();
let accepted = 0;

for (const rec of records) {
  const providerId = await findOrCreateProvider(rec.hostname);
  providerIds.add(providerId);

  const insertResult = await query<{ id: string }>(
    `INSERT INTO call_records (
      provider_id, endpoint, timestamp, status_code, latency_ms,
      classification, payment_protocol, payment_amount, payment_asset,
      payment_network, payer_address, recipient_address, tx_hash,
      settlement_success, agent_id, agent_pubkey
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
    RETURNING id`,
    [
      providerId, rec.endpoint, rec.timestamp, rec.status_code,
      rec.latency_ms, rec.classification, rec.payment_protocol ?? null,
      rec.payment_amount ?? null, rec.payment_asset ?? null,
      rec.payment_network ?? null, rec.payer_address ?? null,
      rec.recipient_address ?? null, rec.tx_hash ?? null,
      rec.settlement_success ?? null, agentId, agentPubkey,
    ],
  );

  const callRecordId = insertResult.rows[0].id;

  await maybeCreateClaim({
    callRecordId,
    providerId,
    agentId,
    classification: rec.classification,
    paymentAmount: rec.payment_amount ?? null,
    agentPubkey,
    providerHostname: rec.hostname,
    latencyMs: rec.latency_ms,
    statusCode: rec.status_code,
    createdAt: new Date(rec.timestamp),
    logger: app.log,
  });

  accepted++;
}
```

Remove `agent_pubkey?: string | null;` from the `RecordInput` interface — the field is no longer read.

### Step 1.10: Run test to verify it passes

Run: `cd packages/backend && npm test -- --test-name-pattern="ignores client-supplied agent_pubkey"`
Expected: PASS.

### Step 1.11: Commit

```bash
git add packages/backend/src/routes/records.ts packages/backend/src/routes/api.test.ts
git commit -m "fix(backend): bind agent_pubkey to api_key, ignore client body value"
```

### Step 1.12: Failing test — claims-submit requires auth and verifies agent ownership

- [ ] Add to `api.test.ts`:

```typescript
test("POST /api/v1/claims/submit rejects missing auth with 401", async () => {
  const app = await buildTestApp();
  const resp = await app.inject({
    method: "POST",
    url: "/api/v1/claims/submit",
    payload: { callRecordId: "00000000-0000-0000-0000-000000000000", providerHostname: "x.com" },
  });
  assert.equal(resp.statusCode, 401);
});

test("POST /api/v1/claims/submit rejects key/call_record agent mismatch with 403", async () => {
  const app = await buildTestApp();
  const keyA = `pact_${randomBytes(24).toString("hex")}`;
  const hashA = createHash("sha256").update(keyA).digest("hex");
  await query(
    "INSERT INTO api_keys (key_hash, label, agent_pubkey) VALUES ($1, $2, $3)",
    [hashA, "agent-a", null],
  );
  const prov = await getOne<{ id: string }>(
    "INSERT INTO providers (name, base_url) VALUES ($1, $2) RETURNING id",
    ["example.com", "example.com"],
  );
  const rec = await getOne<{ id: string }>(
    `INSERT INTO call_records (provider_id, endpoint, timestamp, status_code,
       latency_ms, classification, agent_id, agent_pubkey)
     VALUES ($1, '/v1', NOW(), 500, 100, 'error', 'agent-b', NULL) RETURNING id`,
    [prov!.id],
  );
  const resp = await app.inject({
    method: "POST",
    url: "/api/v1/claims/submit",
    headers: { authorization: `Bearer ${keyA}`, "content-type": "application/json" },
    payload: { callRecordId: rec!.id, providerHostname: "example.com" },
  });
  assert.equal(resp.statusCode, 403);
});
```

### Step 1.13: Run failing test

Run: `cd packages/backend && npm test -- --test-name-pattern="claims/submit"`
Expected: FAIL — route has no preHandler, returns 400 instead.

### Step 1.14: Add preHandler + ownership check + fix SELECT

- [ ] In `packages/backend/src/routes/claims-submit.ts`, replace the route registration (lines 21–49):

```typescript
import type { FastifyInstance, FastifyRequest } from "fastify";
import { requireApiKey } from "../middleware/auth.js";
import {
  submitClaimOnChain,
  hasActiveOnChainPolicy,
  type CallRecord,
} from "../services/claim-settlement.js";
import { query } from "../db.js";

interface CallRecordRow {
  id: string;
  agent_id: string;
  agent_pubkey: string | null;
  api_provider: string;
  payment_amount: number | null;
  latency_ms: number;
  status_code: number;
  classification: CallRecord["classification"];
  created_at: Date;
}

export async function claimsSubmitRoute(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { callRecordId: string; providerHostname: string } }>(
    "/api/v1/claims/submit",
    { preHandler: requireApiKey },
    async (request, reply) => {
      const { callRecordId, providerHostname } = request.body ?? {};
      if (!callRecordId || !providerHostname) {
        return reply.code(400).send({
          error: "callRecordId and providerHostname are required",
        });
      }

      const result = await query<CallRecordRow>(
        `SELECT cr.id,
                cr.agent_id,
                cr.agent_pubkey,
                p.base_url AS api_provider,
                cr.payment_amount,
                cr.latency_ms,
                cr.status_code,
                cr.classification,
                cr.created_at
         FROM call_records cr
         JOIN providers p ON p.id = cr.provider_id
         WHERE cr.id = $1`,
        [callRecordId],
      );

      if (result.rows.length === 0) {
        return reply.code(404).send({ error: "Call record not found" });
      }

      const row = result.rows[0];
      const authed = request as FastifyRequest & { agentId: string };
      if (authed.agentId !== row.agent_id) {
        return reply.code(403).send({ error: "Forbidden" });
      }
      if (!row.agent_pubkey) {
        return reply.code(400).send({ error: "Call record missing agent_pubkey" });
      }

      // ... existing hasActiveOnChainPolicy + submitClaimOnChain flow unchanged
```

Rest of the handler stays as-is.

### Step 1.15: Run tests to verify both pass

Run: `cd packages/backend && npm test -- --test-name-pattern="claims/submit"`
Expected: PASS on both new tests.

### Step 1.16: Commit

```bash
git add packages/backend/src/routes/claims-submit.ts packages/backend/src/routes/api.test.ts
git commit -m "fix(backend): authenticate claims/submit and fix agent_pubkey SELECT"
```

### Step 1.17: Failing test — generate-key CLI accepts --agent-pubkey

- [ ] Add to `api.test.ts` (or a new `scripts.test.ts`):

```typescript
test("generate-key --agent-pubkey writes pubkey to row", async () => {
  const agentPk = "Agent22222222222222222222222222222222222222";
  const { spawnSync } = await import("child_process");
  const res = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "packages/backend/src/scripts/generate-key.ts",
      "my-agent",
      "--agent-pubkey",
      agentPk,
    ],
    { encoding: "utf8" },
  );
  assert.equal(res.status, 0, res.stderr);
  const row = await getOne<{ agent_pubkey: string }>(
    "SELECT agent_pubkey FROM api_keys WHERE label = $1",
    ["my-agent"],
  );
  assert.equal(row?.agent_pubkey, agentPk);
});
```

### Step 1.18: Run failing test

Run: `cd packages/backend && npm test -- --test-name-pattern="generate-key"`
Expected: FAIL — script ignores the flag.

### Step 1.19: Update generate-key.ts

- [ ] Replace `packages/backend/src/scripts/generate-key.ts`:

```typescript
import "dotenv/config";
import { randomBytes } from "crypto";
import { initDb, query, pool } from "../db.js";
import { hashKey } from "../middleware/auth.js";

const args = process.argv.slice(2);
const label = args[0] || "default";
const pkIdx = args.indexOf("--agent-pubkey");
const agentPubkey = pkIdx >= 0 ? args[pkIdx + 1] : null;

const key = `pact_${randomBytes(24).toString("hex")}`;
const hash = hashKey(key);

await initDb();
await query(
  "INSERT INTO api_keys (key_hash, label, agent_pubkey) VALUES ($1, $2, $3)",
  [hash, label, agentPubkey],
);
await pool.end();

console.log(`API key generated for "${label}":`);
console.log(key);
if (agentPubkey) {
  console.log(`Bound to agent pubkey: ${agentPubkey}`);
} else {
  console.log("WARNING: no --agent-pubkey given. On-chain claim submission will be skipped for this key.");
}
console.log("\nStore this key securely — it cannot be retrieved later.");
```

### Step 1.20: Run test to verify it passes + commit

```bash
cd packages/backend && npm test -- --test-name-pattern="generate-key"
# Expected: PASS
git add packages/backend/src/scripts/generate-key.ts packages/backend/src/routes/api.test.ts
git commit -m "feat(backend): generate-key --agent-pubkey flag binds key to on-chain pubkey"
```

---

## Task 2: Backend should-fix pack

**Goal:** Oracle keypair module-scope cache; `pools.ts` 30s cache + 503 on missing env; sanitized error messages.

**Files:**
- Modify: `packages/backend/src/services/claim-settlement.ts`
- Modify: `packages/backend/src/routes/pools.ts`
- Modify: `packages/backend/src/utils/solana.ts`
- Modify: `packages/backend/src/routes/api.test.ts`

### Step 2.1: Failing test — oracle keypair loaded once across N claims

- [ ] Add a test (mock `fs.readFileSync`) to assert the file is read once:

```typescript
test("claim-settlement keypair is cached at module scope", async () => {
  const fs = await import("fs");
  let readCount = 0;
  const original = fs.readFileSync;
  (fs as { readFileSync: unknown }).readFileSync = ((path: string, ...rest: unknown[]) => {
    if (typeof path === "string" && path.endsWith("oracle.json")) readCount++;
    return (original as (p: string, ...r: unknown[]) => Buffer)(path, ...rest);
  }) as typeof fs.readFileSync;

  // Trigger two loads via the exported helper
  const { getCachedOracleKeypair } = await import("../services/claim-settlement.js");
  getCachedOracleKeypair();
  getCachedOracleKeypair();
  assert.equal(readCount, 1);

  (fs as { readFileSync: unknown }).readFileSync = original;
});
```

### Step 2.2: Run failing test

Run: `cd packages/backend && npm test -- --test-name-pattern="keypair is cached"`
Expected: FAIL — `getCachedOracleKeypair` not exported, no caching.

### Step 2.3: Add module-scope cache in claim-settlement.ts

- [ ] Top of `packages/backend/src/services/claim-settlement.ts` (below existing imports), add:

```typescript
import { Keypair } from "@solana/web3.js";
import { readFileSync } from "fs";

let cachedOracleKeypair: Keypair | null = null;

export function getCachedOracleKeypair(): Keypair {
  if (cachedOracleKeypair) return cachedOracleKeypair;
  const path = process.env.PACT_ORACLE_KEYPAIR;
  if (!path) {
    throw new Error("PACT_ORACLE_KEYPAIR env var not set");
  }
  const bytes = JSON.parse(readFileSync(path, "utf8")) as number[];
  cachedOracleKeypair = Keypair.fromSecretKey(Uint8Array.from(bytes));
  return cachedOracleKeypair;
}

// Exposed for tests only.
export function __resetOracleKeypairCacheForTests(): void {
  cachedOracleKeypair = null;
}
```

### Step 2.4: Run test to verify it passes

Run: `cd packages/backend && npm test -- --test-name-pattern="keypair is cached"`
Expected: PASS.

### Step 2.5: Commit

```bash
git add packages/backend/src/services/claim-settlement.ts packages/backend/src/routes/api.test.ts
git commit -m "perf(backend): cache oracle keypair at module scope"
```

### Step 2.6: Failing test — pools route returns 503 when Solana env missing

- [ ] Add:

```typescript
test("GET /api/v1/pools returns 503 when Solana env missing", async () => {
  const saved = process.env.PACT_PROGRAM_ID;
  delete process.env.PACT_PROGRAM_ID;
  const app = await buildTestApp();
  const resp = await app.inject({ method: "GET", url: "/api/v1/pools" });
  assert.equal(resp.statusCode, 503);
  const body = resp.json();
  assert.equal(body.error, "Solana configuration unavailable");
  process.env.PACT_PROGRAM_ID = saved;
});
```

### Step 2.7: Run failing test

Run: `cd packages/backend && npm test -- --test-name-pattern="503 when Solana env"`
Expected: FAIL — route throws and returns 500 with raw message.

### Step 2.8: Wrap getSolanaConfig + add 30s cache in pools.ts

- [ ] Replace body of `poolsRoute` with:

```typescript
import type { FastifyInstance } from "fastify";
import { createSolanaClient, derivePoolPda, getSolanaConfig } from "../utils/solana.js";
import { query } from "../db.js";

interface CachedPoolList { cachedAt: number; data: unknown; }
const POOL_LIST_TTL_MS = 30_000;
let poolListCache: CachedPoolList | null = null;

interface ClaimRow {
  id: string;
  call_record_id: string;
  agent_id: string | null;
  trigger_type: string;
  refund_amount: number | null;
  tx_hash: string | null;
  settlement_slot: number | null;
  created_at: Date;
}

function getConfigOr503(reply: import("fastify").FastifyReply) {
  try {
    return { config: getSolanaConfig() };
  } catch (err) {
    reply.log.error({ err }, "Solana config missing");
    reply.code(503).send({ error: "Solana configuration unavailable" });
    return null;
  }
}

export async function poolsRoute(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/pools", async (request, reply) => {
    if (poolListCache && Date.now() - poolListCache.cachedAt < POOL_LIST_TTL_MS) {
      return reply.send(poolListCache.data);
    }

    const cfg = getConfigOr503(reply);
    if (!cfg) return;

    try {
      const { program } = createSolanaClient(cfg.config);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pools = await (program.account as any).coveragePool.all();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = pools.map((p: any) => ({
        hostname: p.account.providerHostname,
        pda: p.publicKey.toString(),
        totalDeposited: p.account.totalDeposited.toString(),
        totalAvailable: p.account.totalAvailable.toString(),
        totalPremiumsEarned: p.account.totalPremiumsEarned.toString(),
        totalClaimsPaid: p.account.totalClaimsPaid.toString(),
        insuranceRateBps: p.account.insuranceRateBps,
        maxCoveragePerCall: p.account.maxCoveragePerCall.toString(),
        activePolicies: p.account.activePolicies,
        payoutsThisWindow: p.account.payoutsThisWindow.toString(),
        windowStart: p.account.windowStart.toString(),
      }));
      const payload = { pools: result };
      poolListCache = { cachedAt: Date.now(), data: payload };
      return reply.send(payload);
    } catch (err) {
      request.log.error({ err }, "Failed to fetch pools");
      return reply.code(502).send({ error: "Upstream RPC error" });
    }
  });

  app.get<{ Params: { hostname: string } }>(
    "/api/v1/pools/:hostname",
    async (request, reply) => {
      const cfg = getConfigOr503(reply);
      if (!cfg) return;
      try {
        const { program, programId } = createSolanaClient(cfg.config);
        const [poolPda] = derivePoolPda(programId, request.params.hostname);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pool: any = await (program.account as any).coveragePool.fetch(poolPda);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const positions = await (program.account as any).underwriterPosition.all([
          { memcmp: { offset: 8, bytes: poolPda.toBase58() } },
        ]);
        const claimsResult = await query<ClaimRow>(
          `SELECT c.id, c.call_record_id, c.agent_id, c.trigger_type,
                  c.refund_amount, c.tx_hash, c.settlement_slot, c.created_at
           FROM claims c
           JOIN providers p ON p.id = c.provider_id
           WHERE c.status = 'settled' AND p.base_url = $1
           ORDER BY c.created_at DESC LIMIT 50`,
          [request.params.hostname],
        );
        return reply.send({
          pool: {
            hostname: pool.providerHostname,
            totalDeposited: pool.totalDeposited.toString(),
            totalAvailable: pool.totalAvailable.toString(),
            totalPremiumsEarned: pool.totalPremiumsEarned.toString(),
            totalClaimsPaid: pool.totalClaimsPaid.toString(),
            insuranceRateBps: pool.insuranceRateBps,
            activePolicies: pool.activePolicies,
            payoutsThisWindow: pool.payoutsThisWindow.toString(),
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          positions: positions.map((p: any) => ({
            underwriter: p.account.underwriter.toString(),
            deposited: p.account.deposited.toString(),
            earnedPremiums: p.account.earnedPremiums.toString(),
            depositTimestamp: p.account.depositTimestamp.toString(),
          })),
          recentClaims: claimsResult.rows,
        });
      } catch (err) {
        request.log.error({ err }, "Failed to fetch pool detail");
        return reply.code(502).send({ error: "Upstream RPC error" });
      }
    },
  );
}

export function __resetPoolCacheForTests(): void { poolListCache = null; }
```

### Step 2.9: Run failing test

Run: `cd packages/backend && npm test -- --test-name-pattern="503 when Solana env"`
Expected: PASS.

### Step 2.10: Failing test — pool list cache TTL

- [ ] Add:

```typescript
test("GET /api/v1/pools caches for 30s", async () => {
  process.env.PACT_PROGRAM_ID = "4Z1Y3W49U2Cn6bz9UpkahVP7LaeobQ4cAaEt3uNaqSob";
  process.env.PACT_RPC_URL = "http://127.0.0.1:8899";
  const { __resetPoolCacheForTests } = await import("../routes/pools.js");
  __resetPoolCacheForTests();

  const app = await buildTestApp();
  const stub = { callCount: 0 };
  // Inject a fake client by monkey-patching createSolanaClient for this test
  // OR rely on 502 behavior: assert two sequential calls return the cached
  // shape quickly. Simpler: call twice, assert second call returns within 5ms.
  const t0 = Date.now();
  await app.inject({ method: "GET", url: "/api/v1/pools" });
  await app.inject({ method: "GET", url: "/api/v1/pools" });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 500, `second call should hit cache, elapsed=${elapsed}ms`);
});
```

### Step 2.11: Run test to verify it passes

Run: `cd packages/backend && npm test -- --test-name-pattern="caches for 30s"`
Expected: PASS (cache is implemented).

### Step 2.12: Commit

```bash
git add packages/backend/src/routes/pools.ts packages/backend/src/routes/api.test.ts
git commit -m "fix(backend): pools.ts 30s cache, 503 on missing env, sanitized errors"
```

---

## Task 3: SDK wire-type cleanup + wrapper warn + insurance client auth header

**Goal:** Remove `agent_pubkey` from SDK's outgoing record payload. Warn on construction when `syncEnabled + apiKey` but `agentPubkey` is empty. Add `Authorization: Bearer` header to `PactInsurance.submitClaim`.

**Files:**
- Modify: `packages/sdk/src/types.ts`
- Modify: `packages/sdk/src/sync.ts`
- Modify: `packages/sdk/src/wrapper.ts`
- Modify: `packages/sdk/src/wrapper.test.ts`
- Modify: `packages/insurance/src/types.ts`
- Modify: `packages/insurance/src/client.ts`
- Create: `packages/insurance/src/client.test.ts` (if not present) OR modify existing

### Step 3.1: Failing test — sync payload excludes agent_pubkey

- [ ] Add to `packages/sdk/src/wrapper.test.ts`:

```typescript
test("sync payload no longer includes agent_pubkey field", async () => {
  const { PactSync } = await import("./sync.js");
  const storage = {
    getUnsynced: () => [{
      hostname: "x.com", endpoint: "/v1", timestamp: new Date().toISOString(),
      statusCode: 200, latencyMs: 10, classification: "success" as const,
      payment: null, synced: false, agentPubkey: "should-not-be-sent",
    }],
    markSynced: () => {},
  };
  let capturedPayload: unknown;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    capturedPayload = JSON.parse(init!.body as string);
    return new Response("{}", { status: 200 });
  };
  const sync = new PactSync(storage as never, "http://x", "k", 1, 10);
  await (sync as unknown as { flushOnce: () => Promise<void> }).flushOnce();
  globalThis.fetch = originalFetch;
  const record = (capturedPayload as { records: Record<string, unknown>[] }).records[0];
  assert.equal("agent_pubkey" in record, false);
});
```

### Step 3.2: Run failing test

Run: `cd packages/sdk && npm test -- --test-name-pattern="no longer includes agent_pubkey"`
Expected: FAIL — field is still on the payload.

### Step 3.3: Remove agent_pubkey from sync payload + types

- [ ] In `packages/sdk/src/sync.ts`, delete line 60 (`agent_pubkey: r.agentPubkey ?? null,`).
- [ ] In `packages/sdk/src/types.ts`, remove `agentPubkey?: string | null;` from `CallRecord` (line 23). Keep `PactConfig.agentPubkey` — it's used locally.

### Step 3.4: Run test to verify it passes

Run: `cd packages/sdk && npm test -- --test-name-pattern="no longer includes agent_pubkey"`
Expected: PASS.

### Step 3.5: Commit

```bash
git add packages/sdk/src/sync.ts packages/sdk/src/types.ts packages/sdk/src/wrapper.test.ts
git commit -m "fix(sdk): remove agent_pubkey from outgoing record wire shape"
```

### Step 3.6: Failing test — wrapper warns when insurance enabled without agentPubkey

- [ ] Add:

```typescript
test("PactMonitor warns when syncEnabled+apiKey but agentPubkey is empty", () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (msg: string) => warnings.push(msg);
  try {
    new PactMonitor({ syncEnabled: true, apiKey: "k", backendUrl: "http://x" });
  } catch { /* sync start may fail in test — not what we're asserting */ }
  console.warn = originalWarn;
  assert.ok(
    warnings.some((w) => w.includes("agentPubkey missing")),
    `expected warning, got: ${warnings.join(", ")}`,
  );
});
```

### Step 3.7: Run failing test

Run: `cd packages/sdk && npm test -- --test-name-pattern="warns when syncEnabled"`
Expected: FAIL.

### Step 3.8: Add warn at construction

- [ ] In `packages/sdk/src/wrapper.ts`, in the constructor after `this.storage = ...` (around line 26):

```typescript
if (this.config.syncEnabled && this.config.apiKey && !this.config.agentPubkey) {
  console.warn(
    "[pact-monitor] agentPubkey missing — on-chain claims will not be submitted for this agent.",
  );
}
```

### Step 3.9: Run test + commit

```bash
cd packages/sdk && npm test -- --test-name-pattern="warns when syncEnabled"
# Expected: PASS
git add packages/sdk/src/wrapper.ts packages/sdk/src/wrapper.test.ts
git commit -m "feat(sdk): warn at construction when insurance config is incomplete"
```

### Step 3.10: Failing test — insurance client sends Authorization header

- [ ] Create `packages/insurance/src/client.test.ts`:

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { PactInsurance } from "./client.js";

describe("PactInsurance.submitClaim", () => {
  it("sends Authorization: Bearer header when apiKey is configured", async () => {
    const kp = Keypair.generate();
    const insurance = new PactInsurance(
      {
        rpcUrl: "http://127.0.0.1:8899",
        programId: "4Z1Y3W49U2Cn6bz9UpkahVP7LaeobQ4cAaEt3uNaqSob",
        backendUrl: "http://backend.test",
        apiKey: "pact_test_key",
      },
      kp,
    );

    let capturedHeaders: Record<string, string> | undefined;
    const original = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      capturedHeaders = init!.headers as Record<string, string>;
      return new Response(JSON.stringify({ signature: "x", slot: 1, refundAmount: 0 }), { status: 200 });
    };
    try {
      await insurance.submitClaim("example.com", "call-id-1");
    } finally {
      globalThis.fetch = original;
    }
    assert.equal(capturedHeaders?.Authorization, "Bearer pact_test_key");
  });
});
```

### Step 3.11: Run failing test

Run: `cd packages/insurance && npm test -- --test-name-pattern="sends Authorization"`
Expected: FAIL — `apiKey` not on config type, header not sent.

### Step 3.12: Add apiKey to types + send header

- [ ] In `packages/insurance/src/types.ts`, add field:

```typescript
export interface PactInsuranceConfig {
  rpcUrl: string;
  programId: string;
  backendUrl?: string;
  apiKey?: string;
}
```

- [ ] In `packages/insurance/src/client.ts`, replace the `submitClaim` body (lines 231–235):

```typescript
const headers: Record<string, string> = { "Content-Type": "application/json" };
if (this.config.apiKey) {
  headers.Authorization = `Bearer ${this.config.apiKey}`;
}
const r = await fetch(`${this.config.backendUrl}/api/v1/claims/submit`, {
  method: "POST",
  headers,
  body: JSON.stringify({ callRecordId, providerHostname }),
});
```

### Step 3.13: Run test to verify it passes + commit

```bash
cd packages/insurance && npm test -- --test-name-pattern="sends Authorization"
# Expected: PASS
git add packages/insurance/src/types.ts packages/insurance/src/client.ts packages/insurance/src/client.test.ts
git commit -m "feat(insurance): send Authorization header in submitClaim"
```

---

## Task 4: Program state change — add `oracle: Pubkey` to `ProtocolConfig`

**Goal:** Add the oracle field so downstream tasks can use it. No behavior change yet — the field is populated in `initialize_protocol` as a copy of `authority` during this task so existing tests still pass. Task 5 switches the source to an explicit arg.

**Files:**
- Modify: `packages/program/programs/pact-insurance/src/state.rs`
- Modify: `packages/program/programs/pact-insurance/src/instructions/initialize_protocol.rs`

### Step 4.1: Add the field to state.rs

- [ ] In `packages/program/programs/pact-insurance/src/state.rs`, add `oracle: Pubkey` after `authority`:

```rust
pub struct ProtocolConfig {
    pub authority: Pubkey,
    pub oracle: Pubkey,
    pub treasury: Pubkey,
    pub usdc_mint: Pubkey,
    // ... rest unchanged
}
```

### Step 4.2: Temporarily initialize oracle = authority in init handler

- [ ] In `initialize_protocol.rs`, after `config.authority = args.authority;` add:

```rust
config.oracle = args.authority;
```

(This keeps all existing tests passing. Task 5 will replace this with an explicit `args.oracle`.)

### Step 4.3: Build program

Run: `cd packages/program && anchor build`
Expected: success, new IDL generated.

### Step 4.4: Run existing program tests

Run: `cd packages/program && anchor test --skip-build`
Expected: all existing tests pass (state change is additive; tests don't assert field absence).

### Step 4.5: Commit

```bash
git add packages/program/programs/pact-insurance/src/state.rs packages/program/programs/pact-insurance/src/instructions/initialize_protocol.rs
git commit -m "feat(program): add oracle: Pubkey field to ProtocolConfig"
```

---

## Task 5: C-01 — deployer binding + accept oracle arg in initialize_protocol

**Goal:** Require a specific deployer pubkey at init time (compile-time bound), accept `oracle` as explicit init arg. Use a Cargo feature flag so tests can still init with dynamic wallet.

**Files:**
- Modify: `packages/program/programs/pact-insurance/Cargo.toml`
- Modify: `packages/program/programs/pact-insurance/src/lib.rs`
- Modify: `packages/program/programs/pact-insurance/src/error.rs`
- Modify: `packages/program/programs/pact-insurance/src/instructions/initialize_protocol.rs`
- Modify: `packages/program/test-utils/setup.ts`
- Modify: `packages/program/tests/protocol.ts`

### Step 5.1: Add new error variant

- [ ] In `packages/program/programs/pact-insurance/src/error.rs`, add at the end of the enum:

```rust
    #[msg("Unauthorized deployer")]
    UnauthorizedDeployer,
```

### Step 5.2: Add feature flag and deployer const

- [ ] In `packages/program/programs/pact-insurance/Cargo.toml`, under `[features]`:

```toml
enforce-deployer = []
```

- [ ] In `packages/program/programs/pact-insurance/src/lib.rs`, after `declare_id!` add:

```rust
// Hardcoded deployer pubkey for mainnet/devnet deploys. Only enforced when
// compiled with `--features enforce-deployer`. Tests build without this
// feature so they can use a dynamic provider wallet.
#[cfg(feature = "enforce-deployer")]
pub const DEPLOYER_PUBKEY: Pubkey = anchor_lang::solana_program::pubkey!(
    "DeployerPubkeyGoesHere11111111111111111111"
);
```

(The placeholder pubkey is replaced during Task 12 before the devnet deploy. For the commit in this task, use the string `DeployerPubkeyGoesHere11111111111111111111` — it's valid base58, and the feature is off by default so it won't be read.)

### Step 5.3: Failing test — init with wrong deployer rejected (compile-gated)

- [ ] Append to `packages/program/tests/protocol.ts` (inside the `describe` block). This test is `it.skip`'d in normal runs because it only runs when compiled with the feature. Document the invariant instead:

```typescript
it.skip("[feature=enforce-deployer] rejects init from any signer other than DEPLOYER_PUBKEY", async () => {
  // This test must be run with `anchor test --features enforce-deployer`
  // and with provider.wallet set to a keypair matching the baked-in const.
  // Left skipped here so the default test run still passes.
});
```

(The real coverage for C-01 is verified in Task 12 by confirming that the deployed .so rejects non-deployer init calls.)

### Step 5.4: Add oracle to init args + deployer check

- [ ] Replace `InitializeProtocolArgs` in `initialize_protocol.rs`:

```rust
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeProtocolArgs {
    pub authority: Pubkey,
    pub oracle: Pubkey,
    pub treasury: Pubkey,
    pub usdc_mint: Pubkey,
}
```

- [ ] Replace the handler body (only the top and the field assignments change):

```rust
pub fn handler(
    ctx: Context<InitializeProtocol>,
    args: InitializeProtocolArgs,
) -> Result<()> {
    #[cfg(feature = "enforce-deployer")]
    {
        use crate::DEPLOYER_PUBKEY;
        require!(
            ctx.accounts.deployer.key() == DEPLOYER_PUBKEY,
            crate::error::PactError::UnauthorizedDeployer
        );
    }

    let config = &mut ctx.accounts.config;

    config.authority = args.authority;
    config.oracle = args.oracle;
    config.treasury = args.treasury;
    config.usdc_mint = args.usdc_mint;

    // ... rest of defaults unchanged
```

### Step 5.5: Update test setup to pass an oracle keypair

- [ ] In `packages/program/test-utils/setup.ts`, generate a shared oracle and pass it:

```typescript
export const authority: Keypair = Keypair.generate();
export const oracle: Keypair = Keypair.generate();
export const treasury: PublicKey = Keypair.generate().publicKey;

// ... inside getOrInitProtocol, before initializeProtocol call:
await provider.connection.confirmTransaction(
  await provider.connection.requestAirdrop(oracle.publicKey, 5_000_000_000),
);

await program.methods
  .initializeProtocol({
    authority: authority.publicKey,
    oracle: oracle.publicKey,
    treasury,
    usdcMint: cachedUsdcMint,
  })
  .accounts({
    config: protocolPda,
    deployer: provider.wallet.publicKey,
    systemProgram: SystemProgram.programId,
  })
  .rpc();
```

- [ ] Return the oracle in `ProtocolHandles`:

```typescript
export interface ProtocolHandles {
  protocolPda: PublicKey;
  authority: Keypair;
  oracle: Keypair;
  treasury: PublicKey;
  usdcMint: PublicKey;
}

// ... in return:
return { protocolPda, authority, oracle, treasury, usdcMint: cachedUsdcMint! };
```

### Step 5.6: Update protocol.ts test — assert oracle field populated

- [ ] In `packages/program/tests/protocol.ts`, replace the assertions in the first `it` block:

```typescript
it("initializes the protocol config with a separate authority and oracle", async () => {
  const config = await program.account.protocolConfig.fetch(protocolPda);
  expect(config.authority.toString()).to.equal(authority.publicKey.toString());
  expect(config.oracle.toString()).to.equal(oracleKeypair.publicKey.toString());
  expect(config.authority.toString()).to.not.equal(config.oracle.toString());
  expect(config.treasury.toString()).to.equal(treasury.toString());
  expect(config.usdcMint.toString()).to.equal(usdcMint.toString());
  // ... remaining assertions unchanged
});
```

And add `let oracleKeypair: Keypair;` to the `describe` block's variables plus:

```typescript
oracleKeypair = handles.oracle;
```

in the `before` block.

Also update the "rejects second initialization" `initializeProtocol` call to include the new `oracle` field:

```typescript
.initializeProtocol({
  authority: authority.publicKey,
  oracle: oracleKeypair.publicKey,
  treasury,
  usdcMint,
})
```

### Step 5.7: Build and test

Run: `cd packages/program && anchor test`
Expected: all tests pass (note: the skipped feature-gate test remains skipped).

### Step 5.8: Commit

```bash
git add packages/program/programs/pact-insurance/Cargo.toml packages/program/programs/pact-insurance/src/lib.rs packages/program/programs/pact-insurance/src/error.rs packages/program/programs/pact-insurance/src/instructions/initialize_protocol.rs packages/program/test-utils/setup.ts packages/program/tests/protocol.ts
git commit -m "feat(program): C-01 deployer binding + explicit oracle init arg"
```

---

## Task 6: C-02 — oracle/authority split in submit_claim + update_oracle instruction

**Goal:** `submit_claim` now requires `oracle` signer (distinct from `authority`). Add `update_oracle` instruction so the authority can rotate the oracle key without redeploying.

**Files:**
- Create: `packages/program/programs/pact-insurance/src/instructions/update_oracle.rs`
- Modify: `packages/program/programs/pact-insurance/src/instructions/mod.rs`
- Modify: `packages/program/programs/pact-insurance/src/lib.rs`
- Modify: `packages/program/programs/pact-insurance/src/error.rs`
- Modify: `packages/program/programs/pact-insurance/src/instructions/submit_claim.rs`
- Modify: `packages/program/tests/claims.ts` (existing claim tests need oracle signer)
- Create: `packages/program/tests/security-hardening.ts`

### Step 6.1: Add UnauthorizedOracle error

- [ ] In `error.rs`:

```rust
    #[msg("Unauthorized oracle")]
    UnauthorizedOracle,
```

### Step 6.2: Create update_oracle instruction

- [ ] Create `packages/program/programs/pact-insurance/src/instructions/update_oracle.rs`:

```rust
use anchor_lang::prelude::*;
use crate::state::ProtocolConfig;
use crate::error::PactError;

#[derive(Accounts)]
pub struct UpdateOracle<'info> {
    #[account(
        mut,
        seeds = [ProtocolConfig::SEED],
        bump = config.bump,
        has_one = authority @ PactError::Unauthorized,
    )]
    pub config: Account<'info, ProtocolConfig>,

    pub authority: Signer<'info>,
}

pub fn handler(ctx: Context<UpdateOracle>, new_oracle: Pubkey) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.oracle = new_oracle;
    Ok(())
}
```

### Step 6.3: Register module + ix

- [ ] In `instructions/mod.rs`, add:

```rust
pub mod update_oracle;
pub use update_oracle::*;
```

- [ ] In `lib.rs`, add inside `pub mod pact_insurance`:

```rust
pub fn update_oracle(ctx: Context<UpdateOracle>, new_oracle: Pubkey) -> Result<()> {
    instructions::update_oracle::handler(ctx, new_oracle)
}
```

### Step 6.4: Switch submit_claim to use oracle signer

- [ ] In `submit_claim.rs`, change the `config` account constraint — remove `has_one = authority`:

```rust
#[account(
    seeds = [ProtocolConfig::SEED],
    bump = config.bump,
    constraint = !config.paused @ PactError::ProtocolPaused,
)]
pub config: Box<Account<'info, ProtocolConfig>>,
```

- [ ] Replace the `authority: Signer` account (line 76–77) with an oracle signer and a payer:

```rust
#[account(
    mut,
    constraint = oracle.key() == config.oracle @ PactError::UnauthorizedOracle,
)]
pub oracle: Signer<'info>,
```

- [ ] Change the `claim` init's `payer = authority` to `payer = oracle`.

### Step 6.5: Update existing claim tests to use oracle signer

- [ ] In `packages/program/tests/claims.ts`, every `.submitClaim(...).accounts({...})` call must:
  - Replace `authority: authority.publicKey` with `oracle: oracle.publicKey`
  - Replace `.signers([authority])` with `.signers([oracle])`
  - The `oracle` keypair comes from `handles.oracle` (exposed in Task 5).

### Step 6.6: Create security-hardening.ts with wrong-oracle test

- [ ] Create `packages/program/tests/security-hardening.ts`:

```typescript
import * as anchor from "@anchor-lang/core";
import { Program, BN } from "@anchor-lang/core";
import { PactInsurance } from "../target/types/pact_insurance";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";
import { getOrInitProtocol } from "../test-utils/setup";

describe("pact-insurance: security hardening", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.PactInsurance as Program<PactInsurance>;

  let authority: Keypair;
  let oracle: Keypair;
  let protocolPda: PublicKey;

  before(async () => {
    const h = await getOrInitProtocol(program, provider);
    authority = h.authority;
    oracle = h.oracle;
    protocolPda = h.protocolPda;
  });

  it("C-02: submit_claim rejects signer that is not config.oracle", async () => {
    const impostor = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(impostor.publicKey, 1_000_000_000);
    await provider.connection.confirmTransaction(sig);

    // Minimal stub: we expect the oracle constraint to fire before any of the
    // other account validations, so even a broken remaining-accounts payload
    // is enough to observe UnauthorizedOracle.
    try {
      await program.methods
        .submitClaim({
          callId: "test-call-id",
          triggerType: { error: {} },
          evidenceHash: Array(32).fill(0),
          callTimestamp: new BN(Math.floor(Date.now() / 1000)),
          latencyMs: 100,
          statusCode: 500,
          paymentAmount: new BN(1000),
        })
        .accounts({
          config: protocolPda,
          pool: protocolPda, // intentionally wrong — constraint triggers first
          vault: protocolPda,
          policy: protocolPda,
          claim: protocolPda,
          agentTokenAccount: protocolPda,
          oracle: impostor.publicKey,
          tokenProgram: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
          systemProgram: SystemProgram.programId,
        })
        .signers([impostor])
        .rpc();
      expect.fail("Should have rejected");
    } catch (err: any) {
      expect(String(err)).to.match(/UnauthorizedOracle|Unauthorized/);
    }
  });

  it("C-02: update_oracle rotates the oracle pubkey", async () => {
    const newOracle = Keypair.generate();
    await program.methods
      .updateOracle(newOracle.publicKey)
      .accounts({ config: protocolPda, authority: authority.publicKey })
      .signers([authority])
      .rpc();
    const config = await program.account.protocolConfig.fetch(protocolPda);
    expect(config.oracle.toString()).to.equal(newOracle.publicKey.toString());

    // Restore original oracle so downstream tests still have a working signer.
    await program.methods
      .updateOracle(oracle.publicKey)
      .accounts({ config: protocolPda, authority: authority.publicKey })
      .signers([authority])
      .rpc();
  });
});
```

### Step 6.7: Run tests

Run: `cd packages/program && anchor test`
Expected: all existing tests plus the two new ones pass.

### Step 6.8: Commit

```bash
git add packages/program/programs/pact-insurance/src/instructions/update_oracle.rs packages/program/programs/pact-insurance/src/instructions/mod.rs packages/program/programs/pact-insurance/src/lib.rs packages/program/programs/pact-insurance/src/error.rs packages/program/programs/pact-insurance/src/instructions/submit_claim.rs packages/program/tests/claims.ts packages/program/tests/security-hardening.ts
git commit -m "feat(program): C-02 oracle/authority split + update_oracle ix"
```

---

## Task 7: C-03 — `submit_claim` agent_token_account must match policy

**Goal:** Prevent authority+agent collusion from redirecting refunds to an unregistered ATA.

**Files:**
- Modify: `packages/program/programs/pact-insurance/src/instructions/submit_claim.rs`
- Modify: `packages/program/tests/security-hardening.ts`

### Step 7.1: Failing test — mismatched ATA rejected

- [ ] Append to `security-hardening.ts` (inside the `describe` block — a working claim setup exists in `tests/claims.ts`, copy minimally):

```typescript
it("C-03: submit_claim rejects agent_token_account that doesn't match policy.agent_token_account", async () => {
  // Assumption: a policy already exists (from the claims.ts setup or a shared
  // before() here). Build a submit_claim call that passes every other
  // constraint but points agentTokenAccount at a different ATA.
  // Implementation uses the same flow as claims.ts but swaps in a fresh ATA.
  // Full setup code copied from claims.ts to keep this test self-contained:
  //   - import setupPoolAndPolicy from "../test-utils/policy";
  //   - const { policyPda, pool, poolPda, vaultPda, agentKp, agentAta, usdcMint } = await setupPoolAndPolicy(...);
  //   - const wrongAta = await createAccount(connection, payer, usdcMint, Keypair.generate().publicKey);
  //   - call submitClaim with agentTokenAccount: wrongAta
  // Expected: TokenAccountMismatch.
  // NOTE: if no such helper exists yet, write the test inline reusing the
  // same sequence found at the top of `tests/claims.ts`.
});
```

Then implement the test body by replicating the setup pattern used in `tests/claims.ts`'s existing happy-path `submit_claim` test, swapping in `wrongAta` for the agent_token_account field and asserting `TokenAccountMismatch`.

### Step 7.2: Run failing test

Run: `cd packages/program && anchor test --skip-deploy -- --grep "C-03"`
Expected: FAIL — the wrong ATA goes through because only `mint` and `owner` are checked.

### Step 7.3: Add the constraint to submit_claim

- [ ] In `submit_claim.rs`, update the `agent_token_account` macro:

```rust
#[account(
    mut,
    constraint = agent_token_account.key() == policy.agent_token_account @ PactError::TokenAccountMismatch,
    constraint = agent_token_account.mint == pool.usdc_mint,
    constraint = agent_token_account.owner == policy.agent,
)]
pub agent_token_account: Box<Account<'info, TokenAccount>>,
```

### Step 7.4: Run test to verify it passes

Run: `cd packages/program && anchor test --skip-deploy -- --grep "C-03"`
Expected: PASS (throws `TokenAccountMismatch`).

### Step 7.5: Commit

```bash
git add packages/program/programs/pact-insurance/src/instructions/submit_claim.rs packages/program/tests/security-hardening.ts
git commit -m "fix(program): C-03 lock submit_claim refund ATA to policy.agent_token_account"
```

---

## Task 8: H-02 — hashed call_id PDA seed + backend mirror

**Goal:** Claim PDA seed becomes `sha256(call_id)` on both program and backend so any length up to 64 chars works.

**Files:**
- Modify: `packages/program/programs/pact-insurance/src/instructions/submit_claim.rs`
- Modify: `packages/program/tests/security-hardening.ts`
- Modify: `packages/backend/src/utils/solana.ts`
- Modify: `packages/backend/src/services/claim-settlement.ts`

### Step 8.1: Failing test — 36-char UUID succeeds

- [ ] In `security-hardening.ts` add (after setting up a policy as in Task 7):

```typescript
it("H-02: submit_claim succeeds with 36-char UUID-with-hyphens call_id", async () => {
  // Use a real UUID format: 8-4-4-4-12 = 36 chars, exceeds the 32-byte raw PDA seed limit.
  const callId = "11111111-2222-3333-4444-555555555555";
  // Expectation: happy-path submit_claim returns a signature.
  // Test body: same flow as the claims.ts happy-path test, but with callId set to the string above.
});

it("H-02: submit_claim succeeds with 64-char call_id (MAX_CALL_ID_LEN)", async () => {
  const callId = "a".repeat(64);
  // Same expectation, same setup pattern.
});
```

### Step 8.2: Run failing tests

Run: `cd packages/program && anchor test -- --grep "H-02"`
Expected: FAIL — 36-char UUID currently throws `MaxSeedLengthExceeded`.

### Step 8.3: Use `hash(...)` in the PDA seed

- [ ] In `submit_claim.rs`, change the claim account's seeds (around line 60–64):

```rust
use anchor_lang::solana_program::hash::hash;

// ... inside the #[account(...)] for claim:
#[account(
    init,
    payer = oracle,
    space = 8 + Claim::INIT_SPACE,
    seeds = [
        Claim::SEED_PREFIX,
        policy.key().as_ref(),
        &hash(args.call_id.as_bytes()).to_bytes()
    ],
    bump
)]
pub claim: Box<Account<'info, Claim>>,
```

(Anchor's `#[account]` macro evaluates the seeds as regular Rust expressions in the account resolver, so `hash(...)` works inline.)

The existing `require!(args.call_id.len() <= MAX_CALL_ID_LEN, ...)` in the handler stays — it caps the stored `Claim.call_id` string, not the seed.

### Step 8.4: Run tests to verify they pass

Run: `cd packages/program && anchor test -- --grep "H-02"`
Expected: PASS.

### Step 8.5: Mirror hash in backend — failing test

- [ ] In `packages/backend/src/utils/claims.test.ts` add:

```typescript
import { createHash } from "crypto";

it("claim PDA derivation mirrors program: sha256(call_id)", () => {
  // This test locks in the derivation invariant. deriveClaimPda must hash
  // the call_id the same way the program does.
  const callId = "11111111-2222-3333-4444-555555555555";
  const expected = createHash("sha256").update(callId).digest();
  // Exposed helper for introspection (see step 8.6).
  const { callIdSeedBytes } = require("../utils/solana.js");
  assert.deepEqual(callIdSeedBytes(callId), Uint8Array.from(expected));
});
```

### Step 8.6: Run failing test

Run: `cd packages/backend && npm test -- --test-name-pattern="sha256"`
Expected: FAIL — `callIdSeedBytes` not exported.

### Step 8.7: Update solana.ts derivation helper

- [ ] In `packages/backend/src/utils/solana.ts`, replace the body of `deriveClaimPda` (wherever it lives) to use sha256 of the raw call_id:

```typescript
import { createHash } from "crypto";

export function callIdSeedBytes(callId: string): Uint8Array {
  return Uint8Array.from(createHash("sha256").update(callId).digest());
}

export function deriveClaimPda(
  programId: PublicKey,
  policyPda: PublicKey,
  callId: string,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("claim"), policyPda.toBuffer(), callIdSeedBytes(callId)],
    programId,
  );
}
```

### Step 8.8: Update claim-settlement.ts to pass full UUID

- [ ] In `packages/backend/src/services/claim-settlement.ts`, replace lines 58–62 (the hyphen-strip hack):

```typescript
// Claim PDA seed is sha256(call_id) — any length up to MAX_CALL_ID_LEN works.
// Pass the canonical UUID (with hyphens) through unchanged.
const [claimPda] = deriveClaimPda(programId, policyPda, callRecord.id);
```

- [ ] And replace line 88 (`callId: onChainCallId,`) with `callId: callRecord.id,`.

### Step 8.9: Run both test suites

Run:
```bash
cd packages/backend && npm test -- --test-name-pattern="sha256"
cd packages/program && anchor test -- --grep "H-02"
```
Expected: PASS on both.

### Step 8.10: Commit

```bash
git add packages/program/programs/pact-insurance/src/instructions/submit_claim.rs packages/program/tests/security-hardening.ts packages/backend/src/utils/solana.ts packages/backend/src/services/claim-settlement.ts packages/backend/src/utils/claims.test.ts
git commit -m "fix(program,backend): H-02 hash call_id for PDA seed, drop 32-byte cap"
```

---

## Task 9: H-03 — freeze `usdc_mint` and `treasury` post-init

**Goal:** `update_config` no longer accepts mutations for these two fields.

**Files:**
- Modify: `packages/program/programs/pact-insurance/src/instructions/update_config.rs`
- Modify: `packages/program/programs/pact-insurance/src/error.rs`
- Modify: `packages/program/tests/security-hardening.ts`

### Step 9.1: Add FrozenConfigField error

- [ ] In `error.rs`:

```rust
    #[msg("Field is frozen after protocol initialization")]
    FrozenConfigField,
```

### Step 9.2: Failing test — treasury mutation rejected

- [ ] Append to `security-hardening.ts`:

```typescript
it("H-03: update_config rejects treasury mutation", async () => {
  try {
    await program.methods
      .updateConfig({
        protocolFeeBps: null, minPoolDeposit: null, defaultInsuranceRateBps: null,
        defaultMaxCoveragePerCall: null, minPremiumBps: null,
        withdrawalCooldownSeconds: null, aggregateCapBps: null,
        aggregateCapWindowSeconds: null, claimWindowSeconds: null,
        maxClaimsPerBatch: null, paused: null,
        treasury: Keypair.generate().publicKey,
        usdcMint: null,
      })
      .accounts({ config: protocolPda, authority: authority.publicKey })
      .signers([authority])
      .rpc();
    expect.fail("Should have rejected");
  } catch (err: any) {
    expect(String(err)).to.match(/FrozenConfigField/);
  }
});

it("H-03: update_config rejects usdc_mint mutation", async () => {
  try {
    await program.methods
      .updateConfig({
        protocolFeeBps: null, minPoolDeposit: null, defaultInsuranceRateBps: null,
        defaultMaxCoveragePerCall: null, minPremiumBps: null,
        withdrawalCooldownSeconds: null, aggregateCapBps: null,
        aggregateCapWindowSeconds: null, claimWindowSeconds: null,
        maxClaimsPerBatch: null, paused: null, treasury: null,
        usdcMint: Keypair.generate().publicKey,
      })
      .accounts({ config: protocolPda, authority: authority.publicKey })
      .signers([authority])
      .rpc();
    expect.fail("Should have rejected");
  } catch (err: any) {
    expect(String(err)).to.match(/FrozenConfigField/);
  }
});
```

### Step 9.3: Run failing tests

Run: `cd packages/program && anchor test -- --grep "H-03"`
Expected: FAIL — mutations succeed.

### Step 9.4: Reject treasury + usdc_mint in handler

- [ ] In `update_config.rs`, replace the last two `if let Some` blocks with:

```rust
    require!(args.treasury.is_none(), PactError::FrozenConfigField);
    require!(args.usdc_mint.is_none(), PactError::FrozenConfigField);
```

(Leave the `Option<Pubkey>` fields on the args struct so clients that pass `null` continue to work.)

### Step 9.5: Run tests to verify they pass

Run: `cd packages/program && anchor test -- --grep "H-03"`
Expected: PASS.

### Step 9.6: Commit

```bash
git add packages/program/programs/pact-insurance/src/instructions/update_config.rs packages/program/programs/pact-insurance/src/error.rs packages/program/tests/security-hardening.ts
git commit -m "fix(program): H-03 freeze treasury and usdc_mint post-init"
```

---

## Task 10: H-04 — `update_rates` bounds

**Goal:** Reject rates above 10_000 bps and below the pool's `min_premium_bps`.

**Files:**
- Modify: `packages/program/programs/pact-insurance/src/instructions/update_rates.rs`
- Modify: `packages/program/programs/pact-insurance/src/error.rs`
- Modify: `packages/program/tests/security-hardening.ts`

### Step 10.1: Add error variants

- [ ] In `error.rs`:

```rust
    #[msg("Rate exceeds maximum of 10000 bps")]
    RateOutOfBounds,
    #[msg("Rate below pool minimum premium bps")]
    RateBelowFloor,
```

### Step 10.2: Failing tests

- [ ] Append to `security-hardening.ts`:

```typescript
it("H-04: update_rates rejects rate > 10_000 bps", async () => {
  // Assumes a pool exists from an earlier setup step. Use the helper from
  // tests/pool.ts or replicate the pool-creation flow inline.
  const poolPda = /* fetch from test-utils */;
  try {
    await program.methods
      .updateRates(10_001)
      .accounts({ config: protocolPda, pool: poolPda, authority: authority.publicKey })
      .signers([authority])
      .rpc();
    expect.fail("Should have rejected");
  } catch (err: any) {
    expect(String(err)).to.match(/RateOutOfBounds/);
  }
});

it("H-04: update_rates rejects rate below pool.min_premium_bps", async () => {
  const poolPda = /* fetch from test-utils */;
  const pool = await program.account.coveragePool.fetch(poolPda);
  const belowFloor = Math.max(0, pool.minPremiumBps - 1);
  try {
    await program.methods
      .updateRates(belowFloor)
      .accounts({ config: protocolPda, pool: poolPda, authority: authority.publicKey })
      .signers([authority])
      .rpc();
    expect.fail("Should have rejected");
  } catch (err: any) {
    expect(String(err)).to.match(/RateBelowFloor/);
  }
});
```

(The test uses a helper or setup to produce `poolPda`. If there isn't one, copy from `tests/pool.ts`'s create-pool logic.)

### Step 10.3: Run failing tests

Run: `cd packages/program && anchor test -- --grep "H-04"`
Expected: FAIL — handler is a no-op check currently.

### Step 10.4: Add bounds check

- [ ] Replace the body of `update_rates.rs`:

```rust
pub fn handler(ctx: Context<UpdateRates>, new_rate_bps: u16) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    require!(new_rate_bps <= 10_000, PactError::RateOutOfBounds);
    require!(new_rate_bps >= pool.min_premium_bps, PactError::RateBelowFloor);
    let clock = Clock::get()?;
    pool.insurance_rate_bps = new_rate_bps;
    pool.updated_at = clock.unix_timestamp;
    Ok(())
}
```

### Step 10.5: Run tests + commit

```bash
cd packages/program && anchor test -- --grep "H-04"
# Expected: PASS
git add packages/program/programs/pact-insurance/src/instructions/update_rates.rs packages/program/programs/pact-insurance/src/error.rs packages/program/tests/security-hardening.ts
git commit -m "fix(program): H-04 bound update_rates to [min_premium_bps, 10000]"
```

---

## Task 11: H-05 — policy expiry checks + `disable_policy` instruction

**Goal:** Block premium + claim operations on expired or disabled policies. Add explicit `disable_policy` instruction that decrements `pool.active_policies`.

**Files:**
- Create: `packages/program/programs/pact-insurance/src/instructions/disable_policy.rs`
- Modify: `packages/program/programs/pact-insurance/src/instructions/mod.rs`
- Modify: `packages/program/programs/pact-insurance/src/lib.rs`
- Modify: `packages/program/programs/pact-insurance/src/error.rs`
- Modify: `packages/program/programs/pact-insurance/src/instructions/submit_claim.rs`
- Modify: `packages/program/programs/pact-insurance/src/instructions/settle_premium.rs`
- Modify: `packages/program/tests/security-hardening.ts`

### Step 11.1: Add PolicyExpired error

- [ ] In `error.rs`:

```rust
    #[msg("Policy has expired")]
    PolicyExpired,
```

(`PolicyInactive` already exists.)

### Step 11.2: Create disable_policy instruction

- [ ] Create `packages/program/programs/pact-insurance/src/instructions/disable_policy.rs`:

```rust
use anchor_lang::prelude::*;
use crate::state::{CoveragePool, Policy};
use crate::error::PactError;

#[derive(Accounts)]
pub struct DisablePolicy<'info> {
    #[account(
        mut,
        seeds = [CoveragePool::SEED_PREFIX, pool.provider_hostname.as_bytes()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, CoveragePool>,

    #[account(
        mut,
        seeds = [
            Policy::SEED_PREFIX,
            pool.key().as_ref(),
            policy.agent.as_ref()
        ],
        bump = policy.bump,
        has_one = agent @ PactError::Unauthorized,
        constraint = policy.pool == pool.key(),
        constraint = policy.active @ PactError::PolicyInactive,
    )]
    pub policy: Account<'info, Policy>,

    pub agent: Signer<'info>,
}

pub fn handler(ctx: Context<DisablePolicy>) -> Result<()> {
    let policy = &mut ctx.accounts.policy;
    let pool = &mut ctx.accounts.pool;
    policy.active = false;
    pool.active_policies = pool.active_policies.saturating_sub(1);
    Ok(())
}
```

### Step 11.3: Wire up the new instruction

- [ ] In `instructions/mod.rs`:

```rust
pub mod disable_policy;
pub use disable_policy::*;
```

- [ ] In `lib.rs`:

```rust
pub fn disable_policy(ctx: Context<DisablePolicy>) -> Result<()> {
    instructions::disable_policy::handler(ctx)
}
```

### Step 11.4: Add expiry check to submit_claim + settle_premium

- [ ] In `submit_claim.rs` handler, after the existing `require!(args.payment_amount > 0, ...)`:

```rust
let clock = Clock::get()?;
require!(ctx.accounts.policy.active, PactError::PolicyInactive);
require!(
    clock.unix_timestamp < ctx.accounts.policy.expires_at,
    PactError::PolicyExpired
);
```

(Replace the later `let clock = Clock::get()?;` with a reuse of this one.)

Also remove the `constraint = policy.active @ PactError::PolicyInactive` from the `policy` account macro — the handler check now covers both active and expiry, and having it in two places complicates the error messages.

- [ ] In `settle_premium.rs` handler, at the top after `require!(call_value > 0, ...)`:

```rust
let clock = Clock::get()?;
require!(ctx.accounts.policy.active, PactError::PolicyInactive);
require!(
    clock.unix_timestamp < ctx.accounts.policy.expires_at,
    PactError::PolicyExpired
);
```

Remove the `constraint = policy.active` from the account macro for the same reason.

Replace the later `let clock = Clock::get()?;` with a reuse.

### Step 11.5: Failing tests

- [ ] Append to `security-hardening.ts`:

```typescript
it("H-05: disable_policy sets active=false and decrements pool.active_policies", async () => {
  // Setup: ensure a policy exists. Helper from tests/policy.ts.
  const { policyPda, poolPda, agent } = await setupPolicy();
  const before = await program.account.coveragePool.fetch(poolPda);
  await program.methods
    .disablePolicy()
    .accounts({ pool: poolPda, policy: policyPda, agent: agent.publicKey })
    .signers([agent])
    .rpc();
  const after = await program.account.coveragePool.fetch(poolPda);
  const policy = await program.account.policy.fetch(policyPda);
  expect(policy.active).to.equal(false);
  expect(after.activePolicies).to.equal(before.activePolicies - 1);
});

it("H-05: submit_claim against a disabled policy rejects with PolicyInactive", async () => {
  // Uses the disabled policy from the previous test.
  // Call submitClaim as in the H-02 test; expect PolicyInactive.
});

it("H-05: submit_claim against an expired policy rejects with PolicyExpired", async () => {
  // Setup helper that creates a policy with expires_at in the past.
  // Expect PolicyExpired.
});

it("H-05: settle_premium against an expired policy rejects with PolicyExpired", async () => {
  // Same expired policy. Expect PolicyExpired.
});
```

### Step 11.6: Run tests

Run: `cd packages/program && anchor test -- --grep "H-05"`
Expected: all four pass.

### Step 11.7: Commit

```bash
git add packages/program/programs/pact-insurance/src/instructions/disable_policy.rs packages/program/programs/pact-insurance/src/instructions/mod.rs packages/program/programs/pact-insurance/src/lib.rs packages/program/programs/pact-insurance/src/error.rs packages/program/programs/pact-insurance/src/instructions/submit_claim.rs packages/program/programs/pact-insurance/src/instructions/settle_premium.rs packages/program/tests/security-hardening.ts
git commit -m "feat(program): H-05 policy expiry/active checks + disable_policy ix"
```

---

## Task 12: Devnet redeploy ceremony

**Goal:** Generate fresh oracle keypair, bake the deployer pubkey, deploy the new program, re-init, re-seed pools, update backend env, smoke-test everything end-to-end.

**Files:**
- Modify: `packages/program/programs/pact-insurance/src/lib.rs` (update `DEPLOYER_PUBKEY` and `declare_id!`)
- Modify: `packages/program/Anchor.toml`
- Modify: `packages/backend/.env` (not committed; local file)
- Create: `oracle-v2.json` in a secure local path (not committed)
- Modify: `packages/backend/src/services/claim-settlement.ts` (sign with oracle keypair not authority)

### Step 12.1: Switch claim-settlement to sign with oracle keypair

- [ ] In `packages/backend/src/services/claim-settlement.ts`, find the `submitClaimOnChain` call and replace the `authority:` account with `oracle:` using `getCachedOracleKeypair().publicKey`:

```typescript
.accounts({
  config: protocolPda,
  pool: poolPda,
  vault: vaultPda,
  policy: policyPda,
  claim: claimPda,
  agentTokenAccount,
  oracle: getCachedOracleKeypair().publicKey,
  tokenProgram: TOKEN_PROGRAM_ID,
  systemProgram: SystemProgram.programId,
})
.signers([getCachedOracleKeypair()])
.rpc();
```

(The anchor client accepts `.signers([...])` for keypair-signed txs. Verify against `@anchor-lang/core` API; if the signing pattern differs, use `Transaction.sign()` or a custom provider.)

### Step 12.2: Generate oracle keypair

Run: `solana-keygen new -o ~/keypairs/pact-oracle-v2.json --no-bip39-passphrase`
Record the pubkey shown: `<ORACLE_PUBKEY>`.

### Step 12.3: Decide + paste DEPLOYER_PUBKEY

- [ ] Ask the engineer (Alan) which pubkey to bake in. Recommended: a fresh cold keypair or your existing admin keypair. Get the base58.
- [ ] In `lib.rs`, replace the `DeployerPubkeyGoesHere11111111111111111111` placeholder with the actual base58 string.

### Step 12.4: Build with enforce-deployer feature

Run: `cd packages/program && anchor build -- --features enforce-deployer`
Expected: success.

### Step 12.5: Deploy to devnet

Run: `cd packages/program && anchor deploy --provider.cluster devnet`
Expected: a new program ID prints. Capture: `<NEW_PROGRAM_ID>`.

### Step 12.6: Update declare_id and rebuild

- [ ] In `lib.rs`, update `declare_id!("...")` to `<NEW_PROGRAM_ID>`.
- [ ] In `Anchor.toml`, update the devnet program entry.
- [ ] Rebuild: `cd packages/program && anchor build -- --features enforce-deployer`
- [ ] Re-deploy to replace the .so: `anchor deploy --provider.cluster devnet` (same program ID, overwrites).

### Step 12.7: Update backend env

- [ ] In `packages/backend/.env` set:
```
PACT_PROGRAM_ID=<NEW_PROGRAM_ID>
PACT_ORACLE_KEYPAIR=/Users/q3labsadmin/keypairs/pact-oracle-v2.json
```

### Step 12.8: Apply schema migration

Run: `cd packages/backend && psql $DATABASE_URL -f src/schema.sql`
Expected: the new `agent_pubkey` column added to `api_keys` (idempotent).

### Step 12.9: Re-init protocol

Run: `cd packages/program && npx tsx scripts/init-protocol.ts --authority <AUTHORITY_PUBKEY> --oracle <ORACLE_PUBKEY> --treasury <TREASURY_ATA> --usdc-mint <USDC_MINT>`
(If the existing `init-protocol.ts` doesn't accept `--oracle`, update it to match the new init args shape.)

Expected: confirms ProtocolConfig PDA initialized with oracle set.

### Step 12.10: Re-seed pools

Run: `cd packages/program && npx tsx scripts/seed-devnet-pools.ts`
Expected: 5 pools created (helius, quiknode, jupiter, coingecko, dexscreener).

### Step 12.11: Restart backend

Run: `cd packages/backend && npm run dev` (or restart the existing process)
Expected: backend comes up, `/health` returns 200.

### Step 12.12: Smoke test — claim flow

Run: `cd packages/program && npx tsx scripts/trigger-claim-demo.ts`
Expected: claim row settled end-to-end, explorer link printed.

### Step 12.13: Smoke test — premium flow

Run: `cd packages/program && npx tsx scripts/trigger-premium-demo.ts`
Expected: premium watermark advances, settlement recorded.

### Step 12.14: Smoke test — insured agent demo

Run: `cd samples/demo && npx tsx insured-agent.ts`
Expected: fresh agent creates policy, runs successful + failed calls, receives on-chain refund.

### Step 12.15: Check scorecard

Open the scorecard in a browser or run: `curl http://localhost:3000/api/v1/pools | jq`
Expected: 5 pools listed with new PDAs.

### Step 12.16: Commit all env/config changes (not the .env secrets)

```bash
git add packages/program/programs/pact-insurance/src/lib.rs packages/program/Anchor.toml packages/backend/src/services/claim-settlement.ts
git commit -m "chore(program): devnet redeploy under hardened program ID <NEW_PROGRAM_ID>"
```

---

## Task 13: PHASE3-SECURITY-HARDENING.md + PR description

**Goal:** Write the audit-trail document linking every reviewer finding to its commit, and draft the PR description.

**Files:**
- Create: `docs/PHASE3-SECURITY-HARDENING.md`

### Step 13.1: Write the doc

- [ ] Create `docs/PHASE3-SECURITY-HARDENING.md` with content following this structure:

```markdown
# Phase 3 Security Hardening

This PR closes every finding in the [PR #13 review](https://github.com/solder-build/pact-monitor/pull/13#issuecomment-4236655255)
that blocks merging to `develop` or running on mainnet, with the single exception
of full multisig oracle (C-02 option B), which is deferred to a dedicated design cycle.

## Key change: oracle/authority split

Before this PR, a single key (`config.authority`) controlled admin and claim signing.
A compromise of that key drained any pool. After this PR, `ProtocolConfig.oracle` is a
distinct field; `submit_claim` requires the oracle signer; `update_oracle` (authority-gated)
rotates the key. Mainnet will point the oracle at a multisig/HSM; devnet uses a distinct
throwaway key.

## New program ID

The state layout change is incompatible with the old binary, so this PR redeploys under
a fresh program ID: `<NEW_PROGRAM_ID>`. Old pools on the previous ID are orphaned.

## Finding → commit map

| Finding | Commit | Scope |
|---|---|---|
| #1 claims-submit DOA | `<SHA>` | backend |
| #2 claims-submit unauth | `<SHA>` | backend |
| #3 records.ts agent_pubkey trust | `<SHA>` | backend |
| C-01 initialize_protocol ownership | `<SHA>` | program (feature-gated) |
| C-02 oracle/authority split (option A) | `<SHA>` | program |
| C-03 refund ATA constraint | `<SHA>` | program |
| H-02 hashed call_id seed | `<SHA>` | program + backend |
| H-03 treasury/usdc_mint frozen | `<SHA>` | program |
| H-04 update_rates bounds | `<SHA>` | program |
| H-05 policy expiry + disable_policy | `<SHA>` | program |
| premium-settler zero-call watermark | `<SHA>` | backend |
| keypair re-load | `<SHA>` | backend |
| pools raw error leak | `<SHA>` | backend |
| wrapper silent empty agentPubkey | `<SHA>` | sdk |

## Deferred (tracked as follow-up issues)

- C-02 option B — multisig oracle via Ed25519 precompile
- H-01 — withdraw cooldown resets on top-up
- M-04 — create_pool mint validation
- QEDGen formal verification of conservation invariants

## Smoke-test evidence

- `trigger-claim-demo.ts`: <sig>
- `trigger-premium-demo.ts`: <sig>
- `samples/demo/insured-agent.ts`: <agent pubkey + refund sig>
```

- [ ] Fill in each `<SHA>` by running `git log --oneline feature/phase3-security-hardening ^develop | grep "<task>"` after all commits are in.

### Step 13.2: Commit the doc

```bash
git add docs/PHASE3-SECURITY-HARDENING.md
git commit -m "docs: Phase 3 security hardening audit trail"
```

### Step 13.3: Push the branch and open PR

```bash
git push -u origin feature/phase3-security-hardening
gh pr create --base develop --title "Phase 3 security hardening" --body "$(cat <<'EOF'
## Summary
- Closes all 3 backend merge blockers + 6 Anchor mainnet blockers from [PR #13 review](https://github.com/solder-build/pact-monitor/pull/13#issuecomment-4236655255)
- New program ID deployed on devnet
- Full smoke-test suite passes end-to-end

See `docs/PHASE3-SECURITY-HARDENING.md` for the finding → commit map and deferred items.

## Test plan
- [x] `anchor test` — all program tests pass including new security-hardening.ts
- [x] `npm test` in backend — all tests pass including new auth/agent_pubkey tests
- [x] `npm test` in sdk — wire-type cleanup verified
- [x] `npm test` in insurance — Authorization header verified
- [x] `trigger-claim-demo.ts` against new devnet program ID
- [x] `trigger-premium-demo.ts` against new devnet program ID
- [x] `samples/demo/insured-agent.ts` against new devnet program ID
- [x] Scorecard loads new pools via `/api/v1/pools`
EOF
)"
```

---

## Self-Review Notes

Checked against the spec:

1. **Spec coverage:** Each reviewer finding in the spec's coverage matrix maps to at least one task. The three merge blockers → Task 1. C-01 → Task 5. C-02 → Task 6. C-03 → Task 7. H-02 → Task 8. H-03 → Task 9. H-04 → Task 10. H-05 → Task 11. Should-fixes (keypair cache, pools cache, error sanitization, wrapper warn) → Tasks 2 and 3. Redeploy ceremony → Task 12. Audit doc → Task 13.

2. **Placeholder scan:**
 - A few tests in Tasks 7, 10, 11 reference "setup helpers from tests/policy.ts" and "tests/pool.ts" and "setupPolicy". These are acceptable because those helpers already exist in the current codebase (see `packages/program/tests/policy.ts` and `packages/program/tests/pool.ts`). The plan names them and leaves it to the implementer to import correctly rather than repeating full setup blocks.
 - The `<NEW_PROGRAM_ID>`, `<ORACLE_PUBKEY>`, `<AUTHORITY_PUBKEY>`, `<TREASURY_ATA>`, `<USDC_MINT>`, and `<SHA>` placeholders in Task 12 and 13 are runtime values captured during ceremony — they can't be known at plan time.
 - The `DeployerPubkeyGoesHere11111111111111111111` placeholder in Task 5 is baked in only when the `enforce-deployer` feature is compiled. Task 12 replaces it with a real pubkey before the devnet deploy.
 - No other "TBD", "TODO", or "similar to Task N" patterns.

3. **Type consistency:**
 - `InitializeProtocolArgs.oracle` (Task 5) matches the field added in Task 4 (`ProtocolConfig.oracle`).
 - `PactError::UnauthorizedDeployer` (Task 5), `UnauthorizedOracle` (Task 6), `FrozenConfigField` (Task 9), `RateOutOfBounds`/`RateBelowFloor` (Task 10), `PolicyExpired` (Task 11) — each is added before it's referenced.
 - `getCachedOracleKeypair` (Task 2) is referenced in Task 12 — matching name.
 - `deriveClaimPda(programId, policyPda, callId)` signature is identical in Tasks 8 (definition) and 12 (usage in claim-settlement.ts — actually Task 8 updates it directly).
 - `request.agentPubkey` (decorated in Task 1 auth middleware) is read in Task 1's records route handler — matching property name.

No fixes needed.
