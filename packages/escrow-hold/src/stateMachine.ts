// @pact-network/escrow-hold — state machine + orchestration.
//
// Pure transition function + an EscrowManager that wires the store, verdict
// hook, chain adapter, and clock together. The manager is the only thing the
// settler/demo needs to call when an endpoint is in `hold` mode; in `refund`
// mode nothing here is invoked and the existing path is untouched.

import type { Clock } from "./clock";
import type { EscrowChainAdapter } from "./chainAdapter";
import type { EscrowStore } from "./escrowStore";
import type { EscrowAction, VerdictHook, Verdict } from "./verdictHook";
import type { EscrowRecord, EscrowState, LockInput } from "./types";

/**
 * Pure escrow transition. LOCKED is the only non-terminal state.
 *   - release → RELEASED
 *   - refund  → REFUNDED
 *   - hold    → LOCKED (no-op; reserved for a future dispute path)
 * Transitioning a terminal record throws — release/refund happen exactly once.
 */
export function nextState(current: EscrowState, action: EscrowAction): EscrowState {
  if (current !== "LOCKED") {
    throw new Error(`escrow is ${current} (terminal); cannot apply action "${action}"`);
  }
  switch (action) {
    case "release":
      return "RELEASED";
    case "refund":
      return "REFUNDED";
    case "hold":
      // Unreachable via EscrowManager (finalize() rejects a "hold" verdict
      // before calling nextState). Exists only as the future dispute-path seam
      // and for direct unit testing.
      return "LOCKED";
    default: {
      // Exhaustiveness guard.
      const never: never = action;
      throw new Error(`unknown escrow action: ${String(never)}`);
    }
  }
}

export interface EscrowManagerOptions {
  store: EscrowStore;
  verdictHook: VerdictHook;
  chain: EscrowChainAdapter;
  clock: Clock;
  /**
   * How long (seconds) a premium stays held before it may be finalized.
   * Operator-configurable; the #4 research suggested 24–48h. On-chain this
   * would live on the endpoint config.
   */
  holdWindowSeconds: number;
}

/** Result of finalizing one escrow record. */
export interface FinalizeResult {
  record: EscrowRecord;
  verdict: Verdict;
}

/** A record the crank tried but failed to finalize (it stays LOCKED). */
export interface CrankFailure {
  callId: string;
  error: string;
}

/**
 * Outcome of a crank pass. `failed` is non-empty only if a record errored
 * (e.g. a non-stub verdict hook threw) — those stay LOCKED for the next crank.
 */
export interface CrankResult {
  finalized: FinalizeResult[];
  failed: CrankFailure[];
}

export class EscrowManager {
  constructor(private readonly opts: EscrowManagerOptions) {
    if (opts.holdWindowSeconds < 0) {
      throw new Error("holdWindowSeconds must be >= 0");
    }
  }

  /**
   * Lock a premium into escrow (called instead of immediate fan-out when the
   * endpoint is in hold mode). Returns the created LOCKED record.
   */
  async lock(input: LockInput): Promise<EscrowRecord> {
    const nowUnix = this.opts.clock.nowUnix();
    const record: EscrowRecord = {
      callId: input.callId,
      agentPubkey: input.agentPubkey,
      endpointSlug: input.endpointSlug,
      heldPremiumLamports: input.premiumLamports,
      outcome: input.outcome,
      state: "LOCKED",
      lockedAtIso: this.opts.clock.nowIso(),
      releaseDeadlineUnix: String(nowUnix + this.opts.holdWindowSeconds),
    };
    await this.opts.chain.lock(record);
    this.opts.store.put(record);
    return record;
  }

  /**
   * Finalize a single LOCKED record: run the verdict hook, apply the on-chain
   * release/refund, and advance the state. Throws if the record is missing,
   * already terminal, or its deadline hasn't passed yet.
   *
   * `nowUnix` defaults to the clock but can be passed in so a caller (crank)
   * uses ONE captured timestamp for both the due-selection and the deadline
   * check — keeping the two boundary comparisons in lockstep. It is floored to
   * whole seconds to match `EscrowStore.dueForCrank`.
   */
  async finalize(callId: string, nowUnix: number = this.opts.clock.nowUnix()): Promise<FinalizeResult> {
    const now = Math.floor(nowUnix);
    const record = this.opts.store.get(callId);
    if (!record) {
      throw new Error(`no escrow record for callId ${callId}`);
    }
    if (record.state !== "LOCKED") {
      throw new Error(`escrow ${callId} is ${record.state} (already finalized)`);
    }
    if (BigInt(now) < BigInt(record.releaseDeadlineUnix)) {
      throw new Error(
        `escrow ${callId} not yet due: now=${now} < deadline=${record.releaseDeadlineUnix}`,
      );
    }

    const verdict = this.opts.verdictHook.decide(record);
    // The PoC hook only ever returns release/refund; guard the future "hold".
    if (verdict.action === "hold") {
      throw new Error(`verdict returned "hold" for ${callId}; no dispute path in this PoC`);
    }

    const { txId } =
      verdict.action === "release"
        ? await this.opts.chain.release(record)
        : await this.opts.chain.refund(record);

    const newState = nextState(record.state, verdict.action);
    this.opts.store.setState(callId, newState, txId);

    const updated = this.opts.store.get(callId);
    // `updated` is always defined here (we just set its state), but narrow it
    // so the return type stays non-optional without a non-null assertion.
    if (!updated) {
      throw new Error(`escrow ${callId} vanished during finalize`);
    }
    return { record: updated, verdict };
  }

  /**
   * Permissionless deadline crank: finalize ALL LOCKED records past their
   * deadline. This is the liveness guarantee — funds can't be stranded if a
   * single operator's executor dies, because anyone can crank.
   *
   * Fault-tolerant: a record that fails to finalize is collected in `failed`
   * and left LOCKED for the next crank; it does NOT abort the rest of the
   * batch (a crank that died on one bad record would defeat the liveness
   * guarantee). Uses a single captured timestamp for the whole pass.
   */
  async crank(): Promise<CrankResult> {
    const now = Math.floor(this.opts.clock.nowUnix());
    const due = this.opts.store.dueForCrank(now);
    const finalized: FinalizeResult[] = [];
    const failed: CrankFailure[] = [];
    for (const r of due) {
      try {
        finalized.push(await this.finalize(r.callId, now));
      } catch (err) {
        failed.push({ callId: r.callId, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { finalized, failed };
  }
}
