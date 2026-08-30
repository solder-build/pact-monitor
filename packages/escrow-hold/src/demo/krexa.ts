// @pact-network/escrow-hold — Krexa scenario demo.
//
// Demonstrates the hold-in-escrow risk mode end-to-end for the Krexa lending
// wedge. Run with:  pnpm --filter @pact-network/escrow-hold demo
//
// WHAT IS REAL HERE:
//   - The classifier (`defaultClassifier.classify`) decides each call's outcome
//     and premium from a synthetic HTTP Response + latency — the same code the
//     production hot path uses.
//   - The full LOCKED → RELEASED/REFUNDED state machine, deadline gating, and
//     the permissionless crank.
//
// WHAT IS STUBBED (and clearly labeled):
//   - There is NO on-chain transaction. Escrow is an in-memory ledger; every
//     tx id printed is prefixed `STUB-`.
//   - The verdict's maliciousness judgment is stubbed (deterministic SLA only).
//   - The hold-window clock is a FakeClock advanced instantly (no real wait).
//
// This is honest: it shows the mechanism, not a real settlement.

import { defaultClassifier } from "@pact-network/wrap";
import type { ClassifierInput } from "@pact-network/wrap";

import {
  EscrowManager,
  FakeClock,
  InMemoryEscrowStore,
  StubEscrowChainAdapter,
  deterministicVerdictHook,
} from "../index";

// Krexa lending endpoint config (hold mode). Premium + imputed-cost are the
// wrap-relevant slice the classifier needs.
const KREXA_ENDPOINT = {
  slug: "krexa-lending",
  sla_latency_ms: 800,
  flat_premium_lamports: 2000n,
  imputed_cost_lamports: 50000n,
};

const HOLD_WINDOW_SECONDS = 48 * 60 * 60; // 48h, operator-configurable
const START_UNIX = 1_750_000_000; // fixed start so output is deterministic

interface SyntheticCall {
  callId: string;
  agentPubkey: string;
  label: string;
  response: Response;
  latencyMs: number;
}

function buildCalls(): SyntheticCall[] {
  return [
    {
      callId: "krexa-call-good-0001",
      agentPubkey: "AgentGood1111111111111111111111111111111111",
      label: "good loan-quote (200, fast)",
      response: new Response(JSON.stringify({ apr: 0.072, max: "1000" }), { status: 200 }),
      latencyMs: 120,
    },
    {
      callId: "krexa-call-breach-0002",
      agentPubkey: "AgentBad22222222222222222222222222222222222",
      label: "provider 503 (covered breach)",
      response: new Response("upstream unavailable", { status: 503 }),
      latencyMs: 95,
    },
  ];
}

async function main(): Promise<void> {
  const store = new InMemoryEscrowStore();
  const chain = new StubEscrowChainAdapter();
  const clock = new FakeClock(START_UNIX);
  const manager = new EscrowManager({
    store,
    chain,
    clock,
    verdictHook: deterministicVerdictHook,
    holdWindowSeconds: HOLD_WINDOW_SECONDS,
  });

  console.log("=== Pact escrow-hold PoC — Krexa scenario ===");
  console.log("(REAL: classifier + state machine | STUB: chain, verdict maliciousness, clock)\n");

  // 1. Each call is classified (REAL) then its premium is LOCKED in escrow
  //    instead of being fanned out immediately (because Krexa is hold mode).
  for (const call of buildCalls()) {
    const input: ClassifierInput = {
      response: call.response,
      latencyMs: call.latencyMs,
      endpointConfig: KREXA_ENDPOINT,
    };
    const result = defaultClassifier.classify(input);
    const record = await manager.lock({
      callId: call.callId,
      agentPubkey: call.agentPubkey,
      endpointSlug: KREXA_ENDPOINT.slug,
      premiumLamports: result.premium.toString(),
      outcome: result.outcome,
    });
    console.log(
      `LOCKED  ${call.callId}  (${call.label})\n` +
        `        outcome=${result.outcome}  heldPremium=${record.heldPremiumLamports}  ` +
        `deadlineUnix=${record.releaseDeadlineUnix}`,
    );
  }

  // 2. Time passes (STUB clock) past the hold window.
  console.log(`\n... advancing FakeClock past the ${HOLD_WINDOW_SECONDS}s hold window ...\n`);
  clock.advance(HOLD_WINDOW_SECONDS + 1);

  // 3. Permissionless crank finalizes every due escrow (REAL state machine).
  const { finalized, failed } = await manager.crank();
  for (const { record, verdict } of finalized) {
    console.log(
      `${record.state.padEnd(9)}${record.callId}  ` +
        `verdict=${verdict.action} (breach=${verdict.breach}, source=${verdict.source}, stubbed=${verdict.stubbed})  ` +
        `tx=${record.finalizeTxId}`,
    );
  }

  if (failed.length > 0) {
    console.log(`\n${failed.length} record(s) failed to finalize (stay LOCKED for next crank):`, failed);
  }

  // 4. Show where the money would have gone (STUB ledger).
  console.log("\n--- STUB ledger (no real on-chain transfer) ---");
  console.log("premium released to fan-out:", Object.fromEntries(chain.fanoutCredited));
  console.log("premium refunded to agent: ", Object.fromEntries(chain.agentRefunded));
  console.log("\nDone. Refund-mode endpoints are unaffected — this path only runs for hold-mode endpoints.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
