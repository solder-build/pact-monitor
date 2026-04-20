# Onboarding — A walkthrough for someone who knows nothing

You're new. You don't know Solana, don't know the codebase, don't know why anything is the way it is. This doc is for you.

For the file tree, see [`STRUCTURE.md`](./STRUCTURE.md). For the architecture handbook, see [`PHASE3.md`](./PHASE3.md). This file is the narrative — read it once, end-to-end, and you'll have the whole stack in your head.

---

## What the product is in one paragraph

AI agents pay for API calls (Helius, CoinGecko, Jupiter, etc.) using x402 micro-payments. Sometimes those APIs fail — timeout, 500, garbage response. Today the agent eats the loss. **Pact Network is parametric insurance against API failures**: an agent enables coverage for a provider, pays a tiny premium per call, and if the call fails, the protocol automatically refunds them from a USDC pool funded by underwriters. The whole insurance market is on Solana.

## The mental model

Imagine three groups of people, all settling in USDC on Solana:

```
┌──────────────────────┐    ┌──────────────────────┐    ┌──────────────────────┐
│   Agents (buyers)    │    │ Underwriters (LPs)   │    │  Pact (the oracle)   │
│                      │    │                      │    │                      │
│ "I want my Helius    │    │ "I'll bet $100 that  │    │ "I watch every call. │
│  call insured. Take  │    │  Helius stays up. If │    │  When Helius fails,  │
│  a small cut per     │    │  it does, I earn     │    │  I tell the chain to │
│  call as premium."   │    │  premiums. If it     │    │  refund the agent."  │
│                      │    │  fails, agents get   │    │                      │
│                      │    │  refunded from my $."│    │                      │
└──────────┬───────────┘    └──────────┬───────────┘    └──────────┬───────────┘
           │                           │                           │
           │ enable_insurance          │ deposit                   │ submit_claim
           │ (SPL approve              │                           │
           │  + Policy PDA)            │                           │ update_rates
           │                           │                           │ settle_premium
           ▼                           ▼                           ▼
    ┌─────────────────────────────────────────────────────────────────┐
    │              Anchor program on Solana (the rules)               │
    │                                                                  │
    │  ProtocolConfig --owns--> CoveragePool[Helius] --has--> Vault   │
    │                           CoveragePool[Jupiter]                  │
    │                           CoveragePool[CoinGecko]                │
    │                           CoveragePool[QuickNode]                │
    │                           CoveragePool[DexScreener]              │
    │                              │                                   │
    │                              ├── UnderwriterPosition (each LP)   │
    │                              ├── Policy (each agent)             │
    │                              └── Claim (each settled failure)    │
    └─────────────────────────────────────────────────────────────────┘
```

## The 5 packages and how they connect

```
┌────────────────────────────┐    POST /api/v1/records          ┌────────────────────────────┐
│ packages/monitor               │ ───────────────────────────────► │ packages/backend           │
│ @q3labs/pact-monitor      │                                  │ @pact-network/backend      │
│                            │ ◄─────────────────────────────── │                            │
│ Wraps fetch(), classifies  │   GET /api/v1/providers          │ Fastify + Postgres         │
│ failures, syncs to backend.│   GET /api/v1/pools              │                            │
│ NEW: emits failure/billed  │                                  │ NEW: routes/pools.ts       │
│ events, agent_pubkey field │                                  │      routes/claims-submit  │
└────────────────────────────┘                                  │      crank/* (15min loops) │
                                                                 │      services/claim-       │
┌────────────────────────────┐                                   │              settlement.ts │
│ packages/insurance         │                                   └─────────┬────────┬─────────┘
│ @q3labs/pact-insurance    │                                             │        │
│ NEW package                │                                             │        │ submit_claim
│                            │  enable_insurance                           │        │ settle_premium
│ Builds tx for SPL approve  │  (SPL approve +                             │        │ update_rates
│ + enable_insurance,        │   Policy PDA)                               │        │
│ topUp, getPolicy,          │ ─────────────────────────────────┐          │        │
│ submitClaim, etc.          │                                  │          │        │
└────────────────────────────┘                                  │          │        │
                                                                 ▼          ▼        ▼
┌────────────────────────────┐                                  ┌──────────────────────────┐
│ packages/scorecard         │   GET /api/v1/pools              │ packages/program         │
│ @pact-network/scorecard    │ ─────────────────────────────►   │ Anchor program           │
│                            │                                  │                          │
│ Vite+React+Tailwind        │   GET /api/v1/providers/:id      │ 9 instructions:          │
│                            │   (now includes hostname)        │  initialize_protocol     │
│ NEW: CoveragePoolsPanel    │                                  │  update_config           │
│      PoolDetail page       │                                  │  create_pool             │
│      Coverage section      │                                  │  deposit / withdraw      │
│      in ProviderDetail     │                                  │  enable_insurance        │
└────────────────────────────┘                                  │  settle_premium          │
                                                                 │  update_rates            │
                                                                 │  submit_claim            │
                                                                 │                          │
                                                                 │ Live on devnet:          │
                                                                 │ 4Z1Y3W49U2Cn6bz9...      │
                                                                 └──────────────────────────┘
```

## A complete end-to-end story

### Day 0 — operator (you) sets up the protocol

1. **Deploy Anchor program** to devnet: `anchor program deploy --provider.wallet ~/.config/solana/phantom-devnet.json target/deploy/pact_insurance.so`. Program ID becomes `4Z1Y3W49U2Cn6bz9...`.

2. **Initialize protocol**: `pnpm dlx tsx scripts/init-devnet.ts`. This calls `initialize_protocol` once. The Phantom wallet pays for the PDA, but `config.authority` is set to the **oracle keypair** (a separate key the backend will sign with). Phantom is also stored as `config.treasury`.

3. **Seed pools**: `pnpm dlx tsx scripts/seed-devnet-pools.ts`. For each of the 5 canonical providers (helius, quiknode, jupiter, coingecko, dexscreener), it calls `create_pool` with the oracle authority, then mints 100 test USDC into a fresh underwriter ATA and calls `deposit`. Now there are 5 vaults, each holding 100 USDC of underwriter capital.

### Day 1 — an underwriter joins

4. Some yield-farmer hears about Pact and wants to LP. They call `deposit(50_000_000)` against the Helius pool. The instruction:
   - Transfers 50 USDC from their ATA into the vault
   - `init_if_needed` an `UnderwriterPosition` PDA for `(pool, underwriter)`
   - Bumps `pool.total_deposited` and `pool.total_available` by 50_000_000
   - Sets `position.deposit_timestamp = now` (cooldown clock starts)

### Day 1 — an agent enables insurance

5. An AI agent app uses the `@q3labs/pact-insurance` SDK:
   ```typescript
   const pact = new PactInsurance({
     rpcUrl: "https://api.devnet.solana.com",
     programId: "4Z1Y3W49U2Cn6bz9...",
     backendUrl: "https://api.pactnetwork.io",
   }, agentKeypair);

   await pact.enableInsurance({
     providerHostname: "api.helius.xyz",
     allowanceUsdc: 10_000_000n, // 10 USDC of premium budget
   });
   ```

6. Inside that one method, the SDK builds a single transaction containing **two instructions**:
   - `spl_token::approve(delegate=helius_pool_pda, amount=10_000_000)` — grants the pool PDA delegate authority over 10 USDC of the agent's wallet
   - `enable_insurance({ agent_id, expires_at: 0 })` — validates the delegation is in place, then creates the `Policy` PDA

7. **Critical**: the agent's USDC **never moves**. It stays in their wallet. The pool PDA just has permission to pull up to 10 USDC over time.

### Day 2 — the agent makes some API calls

8. Agent uses the existing `@q3labs/pact-monitor` SDK:
   ```typescript
   const monitor = new PactMonitor({
     apiKey: "pact_xyz",
     agentPubkey: agentKeypair.publicKey.toBase58(), // NEW: tells backend which wallet to settle
     syncEnabled: true,
   });

   const r = await monitor.fetch("https://api.helius.xyz/v0/transactions", { ... });
   ```

9. Most calls return 200. The wrapper records each one to local storage with `agentPubkey` attached. Every 30 seconds, sync flushes a batch to the backend's `POST /api/v1/records`.

### Day 2, 3pm — Helius has an outage

10. The agent's call returns 500. The wrapper classifies it as `error`, records it with `classification: "error"`, and pushes to the backend.

11. The backend's `records.ts` route inserts the call into Postgres, then calls `maybeCreateClaim`. `maybeCreateClaim` creates a DB row in the `claims` table (status `simulated`), then sees `agent_pubkey` is set + `providerHostname` exists, calls `hasActiveOnChainPolicy` to check if there's a Policy PDA, and if yes, calls `submitClaimOnChain`.

12. `submitClaimOnChain` builds a `submit_claim` instruction signed by the **oracle keypair** (the backend's authority). The instruction:
    - Validates the call is within the claim window (default 1h)
    - PDA-derives the `Claim` account using `["claim", policy_pda, call_id]` — **if this call_id already has a claim, the PDA is "already in use" and the instruction reverts** (free dedupe)
    - Rolls over the aggregate-cap window if it's been > 24h
    - Computes refund = `min(payment_amount, max_coverage_per_call, total_available)`
    - Checks `payouts_this_window + refund <= total_deposited * 30%`
    - Pool PDA signs an SPL transfer from the vault to the agent's ATA
    - Creates the `Claim` PDA recording everything (call_id, evidence_hash, refund_amount, status=Approved)
    - Updates pool counters and the policy

13. The agent's USDC balance increases by the refund amount. The DB claim row gets updated with `tx_hash`, `settlement_slot`, `status='settled'`. There's now a real Solana transaction the agent can verify on-chain.

### Day 2, 3:15pm — the crank settles premiums

14. Every 15 minutes the backend's premium-settler crank runs (when `CRANK_ENABLED=true`). For each active pool, for each active policy:
    - Sums `payment_amount` of all the agent's calls in the last 15 min from Postgres
    - Calls `settle_premium(callValue)` signed by oracle
    - Inside the instruction, the pool PDA acts as **SPL delegate** to pull `gross_premium = callValue * insurance_rate_bps / 10000` from the agent's ATA. `protocol_fee_bps` of that goes to the treasury ATA, the rest goes into the pool vault as underwriter yield.
    - The agent's wallet visibly ticks down. No prepaid balance, no top-up tx — just delegation.

15. Same crank also runs `update_rates`: computes new failure rate from observed data and pushes it on-chain if it moved more than 5 bps. The scorecard's "Insurance Rate" column starts reflecting reality.

### Day 9 — the underwriter withdraws

16. After 7 days (`withdrawal_cooldown_seconds`), the underwriter calls `withdraw(50_000_000)`. The instruction:
    - Checks `now - position.deposit_timestamp >= max(config_cooldown, 3600)`
    - Checks `position.deposited >= amount`
    - Checks `pool.total_available >= amount` (can't drain into outstanding obligations)
    - Pool PDA signs an SPL transfer from vault back to underwriter's ATA
    - Decrements `position.deposited`, `pool.total_deposited`, `pool.total_available`

17. The underwriter gets back 50 USDC + their pro-rata share of accumulated premiums minus any losses absorbed during the period.

## What every package is for

- **`packages/program/programs/pact-insurance/src/`** — the rules. Rust code that runs on Solana. Holds the money. Doesn't trust anyone.
- **`packages/backend/`** — the trusted oracle. Watches API calls, runs the crank, submits claims. Authority key is in a Cloud Run secret.
- **`packages/monitor/`** — `@q3labs/pact-monitor`. Drop-in `fetch()` wrapper for AI agent apps. Records call metadata to local JSON, syncs to backend on a timer.
- **`packages/insurance/`** — `@q3labs/pact-insurance`. Agent-side Solana client. Builds the `enable_insurance` tx with the SPL approve baked in. Subscribes to billing/low-balance events.
- **`packages/scorecard/`** — Vite+React dashboard at pactnetwork.io. Lists providers, shows pools, displays claim history. The "marketing surface" of the protocol.

## What you should ACTUALLY know to be productive on this codebase

1. **Anchor 1.0, not 0.31.** The TypeScript client is `@anchor-lang/core`, not `@coral-xyz/anchor`. If you copy-paste from a Solana tutorial it won't work — substitute the import.

2. **The pivot.** We started with a "prepaid balance" model where agents had to deposit USDC into the pool. Rick pushed back and we rebuilt around **SPL token delegation**: agents call `approve` once, the pool PDA pulls premiums on demand, the agent's USDC stays in their wallet. This is why all the code uses `enable_insurance` (not `create_policy`) and there's no `top_up` instruction — top-up is just calling `approve` again with a higher amount.

3. **The backend is the trusted oracle.** It's the only signer that can submit claims, update rates, or mutate config. Compromising the oracle keypair = total protocol loss. It lives in `packages/backend/.secrets/oracle-keypair.json` (gitignored) and on Cloud Run as a Secret Manager mount.

4. **Safety floors are hardcoded constants in `constants.rs`** that `update_config` validates against. Even the authority can't bypass them. This is intentional — it's the trust mechanism.

5. **PDAs are the dedupe mechanism.** Every account is keyed by something derived from the protocol (hostname, agent pubkey, call_id). Re-submitting the same call_id is impossible because the Claim PDA already exists. Free dedupe.

6. **Crank is OFF by default.** `CRANK_ENABLED=false` in `.env`. Only flip to `true` after you've deployed the backend and seeded the pools, and only on a real backend instance (not local dev). When it's on, every 15 min the backend pulls premiums from real agent wallets.

## What's NOT done yet

| Thing | Status | Owner |
|---|---|---|
| Backend deployed to Cloud Run | not yet | You (operationally) |
| Scorecard rebuilt with new VITE_API_URL | not yet | You |
| Crank enabled | flag is false | You, after deploy |
| `agent_pubkey` populated by real agent calls | wired but no live agents yet | Future SDK adopters |
| 24h devnet soak | not yet | You, after deploy |
| Mainnet deploy | gated on soak | You + Rick |

## Where to look for what

| Question | File |
|---|---|
| "How does premium math work?" | `packages/program/programs/pact-insurance/src/instructions/settle_premium.rs` |
| "How does dedupe work?" | `packages/program/programs/pact-insurance/src/instructions/submit_claim.rs` (look at the `Claim` `init` constraint) |
| "What are the safety floors?" | `packages/program/programs/pact-insurance/src/constants.rs` |
| "How does the backend talk to the program?" | `packages/backend/src/utils/solana.ts` |
| "How does the crank settle premiums?" | `packages/backend/src/crank/premium-settler.ts` |
| "How does an agent enable insurance?" | `packages/insurance/src/client.ts`, look at `enableInsurance` |
| "How does the scorecard show pools?" | `packages/scorecard/src/components/CoveragePoolsPanel.tsx` and `PoolDetail.tsx` |
| "What's the test for X instruction?" | `packages/program/tests/{protocol,pool,underwriter,policy,settlement,claims}.ts` |
| "Where's the operator runbook?" | `docs/PHASE3.md` |
| "What was the design rationale?" | `docs/superpowers/specs/2026-04-10-phase3-insurance-design.md` |

## TL;DR for tomorrow

You need to do **4 operational things** to ship to devnet:
1. Deploy backend to Cloud Run with the env vars in `docs/PHASE3.md`
2. Build + deploy scorecard with `VITE_API_URL` set
3. Smoke-test by hitting `/api/v1/pools` and loading the scorecard
4. Flip `CRANK_ENABLED=true` and watch a real settlement happen

Everything else is code, and the code is shipped.
