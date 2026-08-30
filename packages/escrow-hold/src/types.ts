// @pact-network/escrow-hold — shared types.
//
// This package adds an ADDITIVE "hold-in-escrow" risk mode on top of the
// existing Pact Network refund flow. It imports the canonical wrap-library
// types and never modifies them, so the existing refund path and every
// downstream suite stay green by construction.
//
// IMPORTANT design facts (validated against the real on-chain program, see the
// #4 research RESULT.md "Specialist Validation & Corrections"):
//   - Pact V1 holds NO per-call funds in transit. The premium is delegate-
//     pulled from the agent ATA at settle time and fans out to pool + treasury
//     + affiliates; the refund (on a covered failure) is paid OUT OF the
//     per-endpoint coverage pool. V1 never pays providers directly.
//   - Therefore the only fund flow that can be "held" is the PREMIUM FAN-OUT:
//     hold mode delays distributing the premium until a verdict, then RELEASES
//     it (good outcome) or REFUNDS the agent (breach outcome).
//   - There is NO per-call escrow account. A funded program-owned account per
//     callId would cost rent-exemption (~0.002 SOL) per call, dwarfing
//     lamport-scale premiums. On-chain this maps to an earmarked-liability
//     counter on the existing CoveragePool (e.g. `held_premiums`) plus this
//     internal ledger keyed by callId — NOT one PDA per call.

import type { Outcome } from "@pact-network/wrap";

/**
 * Per-endpoint risk mode. `refund` is today's behavior (immediate fan-out,
 * pool-funded refund on breach). `hold` defers the premium fan-out into escrow
 * until a verdict. Defaults to `refund` everywhere so production is unchanged.
 */
export type SettlementMode = "refund" | "hold";

/**
 * Escrow lifecycle state. Deliberately small: LOCKED → RELEASED | REFUNDED.
 *
 * NOTE: there is no `DISPUTED` state in this PoC. Dispute/oracle arbitration
 * is explicitly out of scope (see #4 validation) — the verdict hook is the
 * seam where a future, separately-scoped dispute mechanism would plug in.
 *
 * `DISPUTED` is also NOT an `Outcome` — escrow state is orthogonal to the
 * classifier's SLA outcome and lives in its own enum on purpose.
 */
export type EscrowState = "LOCKED" | "RELEASED" | "REFUNDED";

/**
 * A single held-premium escrow record.
 *
 * Bigint-valued fields are decimal strings, matching the wrap library's
 * `SettlementEvent` convention ("serialized as decimal strings so this
 * round-trips through JSON without precision loss").
 */
export interface EscrowRecord {
  /** Unique call id (same id the wrap library assigns to the wrapped call). */
  callId: string;
  /** Agent (payer) pubkey, base58. */
  agentPubkey: string;
  /** Endpoint slug, e.g. "krexa-lending". */
  endpointSlug: string;
  /**
   * The premium fan-out amount being held, bigint as a decimal string.
   * This is the only money that exists to hold in the V1 flow.
   */
  heldPremiumLamports: string;
  /** Classifier outcome for the call. NOT an escrow state. */
  outcome: Outcome;
  /** Current escrow state. */
  state: EscrowState;
  /** ISO-8601 timestamp when the premium was locked. */
  lockedAtIso: string;
  /**
   * Unix-seconds deadline after which the escrow may be finalized. Decimal
   * string (not a JS number) to honor the precision convention for on-chain
   * time values.
   */
  releaseDeadlineUnix: string;
  /**
   * Stub tx id recorded when the escrow is finalized (release/refund). Every
   * value here is prefixed `STUB-` in the PoC — there is no real on-chain tx.
   */
  finalizeTxId?: string;
}

/** Input to lock a premium into escrow. */
export interface LockInput {
  callId: string;
  agentPubkey: string;
  endpointSlug: string;
  /** Premium fan-out amount to hold, bigint as decimal string. */
  premiumLamports: string;
  /** Classifier outcome for the call. */
  outcome: Outcome;
}

/**
 * Is this endpoint configured for hold mode? Refund mode is the unchanged
 * existing path — callers route through the escrow manager only when this is
 * true, so the refund flow is never touched.
 */
export function isHoldMode(mode: SettlementMode): boolean {
  return mode === "hold";
}
