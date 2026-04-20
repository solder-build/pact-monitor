---
name: pact-network-guide
description: "Use when the user asks what Pact Network is, which SDK they need, or how the monitor + insurance SDKs relate. Examples: \"What does Pact Network do?\", \"Should I use monitor or insurance?\", \"How does the claim flow work?\""
---

# Pact Network — Overview & Decision Guide

Pact Network is parametric micro-insurance for AI agent API payments on Solana. It monitors API provider reliability in real time, computes actuarially-derived insurance rates from observed failure data, and publishes those rates on a public scorecard at pactnetwork.io.

**The insurance rate is the product.** Everything else exists to make that number real, accurate, and public.

## Two SDKs

| Package | Role |
|---|---|
| `@q3labs/pact-monitor` | Passive reliability tracker. Wraps `fetch()`, records latency/failures/payment headers, syncs signed batches to the backend. |
| `@q3labs/pact-insurance` | Active on-chain policy manager. Talks to Solana via Anchor: enable policies, delegate USDC budget, submit claims, read policy state. |

They're **complementary**, not alternatives. Monitor generates the evidence; insurance turns that evidence into a USDC refund when a paid call fails.

## Decide Which You Need

| Goal | SDKs |
|---|---|
| Observe reliability; push data to Pact backend | monitor only |
| Get on-chain USDC refunds when paid calls fail | both |
| Manage policies off the critical path (admin tool, dashboard) | insurance only |

Most agents want **both**.

## Provider Tiers (visible on the scorecard)

- RELIABLE: failure rate < 1%
- ELEVATED: failure rate 1%–5%
- HIGH RISK: failure rate > 5%

Rate formula (per pool): `max(0.001, failureRate * 1.5 + 0.001)`, scaled to bps.

## Claim Flow

1. Agent makes a paid call through `monitor.fetch()`.
2. Call fails (timeout, 5xx, or schema mismatch).
3. Monitor stores the record locally and syncs a **signed** batch to the backend.
4. Backend verifies the signature, attributes the record to the agent's pubkey.
5. Backend auto-submits an on-chain claim from the pool vault to the agent's ATA.

`insurance.submitClaim()` is only needed for manual retry paths — the backend handles the happy path.

## Golden Rule

If `monitor.fetch()` encounters an internal error (storage write, sync, schema check), the underlying `fetch` MUST still succeed. Never add code that breaks the agent's API call because a monitoring step failed.

## Troubleshooting

**`[pact-monitor] agentPubkey missing` warning**
Sync is on but `agentPubkey` is empty. Records still sync, but no on-chain claim can be attributed. Pass `agentPubkey: agent.publicKey.toBase58()`.

**`[pact-monitor] keypair not provided` warning**
Sync is on but batches aren't signed. Backend currently accepts unsigned batches but will reject them in a future version. Pass a `keypair`.

**`enableInsurance` throws "ConstraintHasOne" / similar**
No pool exists on-chain for that hostname. Seed with `packages/program/scripts/seed-devnet-pools.ts`.

**`submitClaim` throws "backendUrl required to submit claim"**
`PactInsurance` config omitted `backendUrl`. Claims go through the backend, not directly on-chain.

**Monitor records missing from scorecard**
Check `syncEnabled: true`, valid `apiKey`, reachable `backendUrl`. Local records persist at `~/.pact-monitor/records.jsonl` regardless — inspect that file to confirm the SDK is recording.

## Related Sub-Skills

- `pact-monitor` — monitor SDK workflow
- `pact-insurance` — insurance SDK workflow
- `pact-integration` — both wired together with framework patterns

## Links

- Scorecard: https://pactnetwork.io
- Monorepo: https://github.com/solder-build/pact-monitor
- Samples: https://github.com/solder-build/pact-monitor/tree/main/samples
