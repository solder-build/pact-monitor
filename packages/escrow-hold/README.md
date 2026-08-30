# @pact-network/escrow-hold (PoC)

An **additive** "hold-in-escrow" risk mode for Pact Network. Instead of refunding
the agent on a covered failure, **hold the premium fan-out in escrow** until a
verdict, then **release** it to the normal fan-out (good outcome) or **refund**
the agent (breach). Built for the **Krexa lending wedge** PoC.

This package layers on `@pact-network/wrap` and **does not modify** the classifier,
the settler, or the existing refund path — so every existing suite stays green by
construction. Endpoints in `refund` mode never touch this code.

> Proof-of-concept. Prior-art + design rationale: `pactnetwork/agent-tasks#4`
> (`experiments/4-research-escrow-risk-mode-prior-art-x402r-competitors/RESULT.md`).
> Task: `pactnetwork/agent-tasks#5`.

## What's real vs stubbed

| Real | Stubbed (clearly labeled) |
|---|---|
| `defaultClassifier.classify` decides outcome + premium | On-chain tx — escrow is an in-memory ledger; tx ids are `STUB-…` |
| `LOCKED → RELEASED / REFUNDED` state machine | The "non-malicious output" verdict — deterministic SLA only |
| Deadline gating + **permissionless crank** | The hold-window clock — a `FakeClock` advanced instantly |

## Design facts that shaped this (from the #4 validation)

- **Pact V1 holds no per-call funds.** The premium is delegate-pulled at settle and
  fans out to pool + treasury + affiliates; the refund is pool-funded; providers are
  never paid in V1. So the only thing to "hold" is the **premium fan-out** — not
  principal or refund.
- **No per-call escrow account.** A funded PDA per `callId` would cost ~0.002 SOL rent
  each — fatal for lamport-scale premiums. On-chain this maps to an earmarked
  `held_premiums` counter on the existing `CoveragePool` plus an off-chain ledger keyed
  by `callId`. The in-memory store here models exactly that.
- **No oracle / no `DISPUTED` state.** Dispute arbitration (and KAMIYO-style staked
  voting) is explicitly out of scope; the verdict hook is the only seam left for it.
- **"Good / non-malicious output" is unsolved.** HTTP 2xx + schema proves availability,
  not correctness. The verdict hook does **not** judge maliciousness — that's future work.

## Architecture

```
LockInput ──▶ EscrowManager.lock ──▶ EscrowStore (LOCKED)   + StubChainAdapter.lock
                                          │
          time passes (Clock) ───────────┤
                                          ▼
EscrowManager.crank ─▶ finalize ─▶ VerdictHook.decide ─▶ release | refund
                                          │                    │
                                          ▼                    ▼
                                  StateMachine.nextState   StubChainAdapter.release/refund
                                  (RELEASED | REFUNDED)    (fan-out ledger | agent ledger)
```

Interfaces (`EscrowStore`, `VerdictHook`, `EscrowChainAdapter`, `Clock`) are swappable:
the PoC ships in-memory + stub implementations; production swaps in DB-backed and
on-chain ones without touching the state machine.

## Run

```bash
pnpm --filter @pact-network/escrow-hold test     # unit tests (vitest)
pnpm --filter @pact-network/escrow-hold demo     # Krexa scenario end-to-end
```
