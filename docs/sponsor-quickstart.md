# Sponsor Quickstart — Earning Premiums on Pact Network

A **sponsor** deposits TEST-USDC into a provider pool's vault. The protocol pays out refunds from that vault when callers on the pool experience failures — and collects **premiums** from every successful call, accruing to sponsors proportionally to their share of the vault.

If you believe a given API provider is more reliable than the market thinks, sponsoring its pool is a directional bet: you earn premiums as long as the realized failure rate stays below the published insurance rate.

**Estimated time:** 5 minutes. **Cost:** zero (devnet).

---

## 1. Get TEST-USDC from the faucet

Same drill as the caller quickstart:

1. Visit **[pactnetwork.io/scorecard/faucet](https://pactnetwork.io/scorecard/faucet)**.
2. Connect Phantom on **Devnet**.
3. Claim the maximum (10,000 TEST-USDC) — the protocol's `min_pool_deposit` is 100 USDC so 10k gives you room to split across pools if you like.

You'll also need a little devnet SOL for rent — `solana airdrop 1` covers it.

---

## 2. Pick a pool

Open the scorecard and browse pools by failure rate / current premium:

- **[pactnetwork.io/scorecard/pool/api.coingecko.com](https://pactnetwork.io/scorecard/pool/api.coingecko.com)** — high volume, tight premium
- **[pactnetwork.io/scorecard/pool/api.dexscreener.com](https://pactnetwork.io/scorecard/pool/api.dexscreener.com)** — medium volume

The pool detail page shows:
- Current vault balance
- Last 24h premiums paid in and claims paid out
- Failure rate (rolling 7 days) and current insurance rate (bps)

Pools where premiums paid > claims paid are profitable for sponsors in expectation.

---

## 3. Deposit into the pool vault

The on-chain instruction is `deposit(pool, amount)`. There's no scorecard UI for this today (added in a later phase), so for devnet you run a small TypeScript script. The easiest starting point is the `seed-devnet-pools.ts` script at `packages/program/scripts/`:

```bash
cd packages/program
pnpm tsx scripts/deposit-to-pool.ts api.coingecko.com 5000
```

> Heads up: `deposit-to-pool.ts` isn't in the repo yet — the pattern is identical to `seed-devnet-pools.ts` but calls `program.methods.deposit(...)` once with your sponsor wallet as the authority. Copy that script and adapt if you want to deposit now. A first-class UI is tracked in the sponsor dashboard milestone.

The script:
1. Derives the pool PDA from the hostname seed.
2. Derives the vault PDA (authority = pool).
3. Signs a `deposit(amount)` transaction using your Phantom keypair, transferring TEST-USDC from your wallet's ATA into the vault.
4. Prints the new vault balance and your pro-rata share.

Minimum deposit is **100 TEST-USDC** (enforced by `config.min_pool_deposit`).

---

## 4. Watch premiums accrue

Every call from an insured agent on that pool triggers a `settle_premium` instruction. The premium flows from the caller's policy balance into the vault you just funded. Your pro-rata share grows as the vault grows.

Track it in two ways:

- **Scorecard pool detail**: the "Vault balance" and "Premiums (24h)" numbers update as calls come in.
- **On-chain**: fetch the pool account and divide your deposited amount by the vault's total balance.

```bash
curl https://pactnetwork.io/api/v1/pools/api.coingecko.com | jq .vault_balance
```

---

## 5. Withdraw (after cooldown)

The protocol enforces a **7-day withdrawal cooldown** (`config.withdrawal_cooldown_seconds`) to prevent flash-deposit-claim-withdraw griefs. Once the cooldown has elapsed since your deposit, you can withdraw all or part of your share:

```bash
pnpm tsx scripts/withdraw-from-pool.ts api.coingecko.com 5000
```

The instruction is `withdraw(pool, amount)`. It moves USDC from the vault back to your wallet ATA, subject to the pool's current vault balance and the aggregate claim cap (30% over any 24h window — see `config.aggregate_cap_bps`).

> If the vault has recently paid out a large claim, your withdrawable balance may be less than your deposit. That's the risk side of the sponsor bet.

---

## What you earn, what you risk

| | Mechanism |
|---|---|
| **Upside** | Premium from every successful call on the pool, pro-rata to your share |
| **Downside** | Vault pays out refunds on failures; your share is diluted by any claims |
| **Break-even** | Realized failure rate ≈ published insurance rate (in bps) |
| **Cap** | Aggregate claims capped at 30% of vault per 24h (protocol safety rail) |

Unlike traditional yield, this is **pure underwriting** — no token incentives, no staking subsidies. Your return is the spread between the premium rate and the realized claim rate.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `deposit` fails with `InsufficientFunds` | Wallet has < 100 TEST-USDC | Claim from the faucet (max 10k/request) |
| `withdraw` fails with `CooldownNotElapsed` | < 7 days since last deposit | Wait; check `last_deposit_at` on the pool account |
| `withdraw` succeeds but returns < deposited | Vault paid out claims while you were in | Expected; see "What you earn, what you risk" above |
| `withdraw` fails with `AggregateCapExceeded` | Pool hit the 24h claim cap recently | Wait for the rolling window to clear |

For the full protocol design see `docs/superpowers/specs/2026-04-10-phase3-insurance-design.md`. For operational state see the scorecard admin dashboard at `/scorecard/admin?token=<ADMIN_TOKEN>`.
