// @pact-network/escrow-hold — verdict hook.
//
// The verdict hook decides what to do with a held premium: release it to the
// normal fan-out, refund the agent, or keep holding. It is intentionally a
// SEPARATE seam from the wrap library's classifier:
//
//   - `Classifier.classify` is sync and stateless by deliberate design and
//     must stay that way (it's on the hot path). Verdict/oracle concerns do
//     NOT belong as fields on `ClassifierResult`.
//   - This hook is where a future, separately-scoped dispute/quality check
//     would plug in. For the PoC it is a deterministic STUB.
//
// HARD TRUTH (see #4 research validation): judging whether provider output was
// "good / non-malicious" is an UNSOLVED problem. HTTP 2xx + schema validates
// availability, not correctness — a compromised provider returns 200 OK with
// schema-valid garbage (exactly the Krexa-lending threat). This hook therefore
// does NOT attempt a maliciousness judgment. It maps the deterministic SLA
// outcome to an action and nothing more. Anything smarter is future work.

import type { Outcome } from "@pact-network/wrap";
import type { EscrowRecord } from "./types";

/** What to do with a held premium at verdict time. */
export type EscrowAction = "release" | "refund" | "hold";

export interface Verdict {
  action: EscrowAction;
  /** Whether the call was a covered breach (mirrors the settler's rule). */
  breach: boolean;
  /**
   * Provenance of the verdict. Only `deterministic` exists in the PoC; a
   * future dispute mechanism would add `oracle`.
   */
  source: "deterministic";
  /**
   * Always true in the PoC: the maliciousness judgment is stubbed out. Kept
   * as an explicit, machine-readable marker so no caller mistakes this for a
   * real correctness verdict.
   */
  stubbed: true;
}

export interface VerdictHook {
  decide(record: EscrowRecord): Verdict;
}

/**
 * Mirrors the settler's breach rule: `breachFromOutcome(outcome) => outcome
 * !== "ok"`. Exported so callers reuse the single source of truth instead of
 * storing a redundant `isBreach` field that can drift from `outcome`.
 */
export function isBreachOutcome(outcome: Outcome): boolean {
  return outcome !== "ok";
}

/**
 * The PoC verdict hook: deterministic, stubbed maliciousness.
 *   - covered breach  → refund the agent
 *   - otherwise (ok)  → release the premium to the normal fan-out
 * It never returns "hold" (no dispute path in the PoC) — that branch exists in
 * the type only as the future seam.
 *
 * NOTE: zero-premium outcomes (4xx/429, where the classifier charges premium=0)
 * map to a refund of 0 — a harmless no-op here. In production, callers should
 * skip escrow entirely for a zero-premium outcome rather than create a LOCKED
 * record that finalizes to a 0-value refund.
 */
export const deterministicVerdictHook: VerdictHook = {
  decide(record: EscrowRecord): Verdict {
    const breach = isBreachOutcome(record.outcome);
    return {
      action: breach ? "refund" : "release",
      breach,
      source: "deterministic",
      stubbed: true,
    };
  },
};
