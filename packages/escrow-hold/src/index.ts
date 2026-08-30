// @pact-network/escrow-hold — public API.
//
// Additive hold-in-escrow risk mode for Pact Network. Import the manager and
// wire it with a store, verdict hook, chain adapter, and clock. Endpoints in
// `refund` mode never touch this package; the existing refund path is unchanged.

export type {
  SettlementMode,
  EscrowState,
  EscrowRecord,
  LockInput,
} from "./types";
export { isHoldMode } from "./types";

export type { Clock } from "./clock";
export { SystemClock, FakeClock } from "./clock";

export type { EscrowAction, Verdict, VerdictHook } from "./verdictHook";
export { deterministicVerdictHook, isBreachOutcome } from "./verdictHook";

export type { EscrowStore } from "./escrowStore";
export { InMemoryEscrowStore } from "./escrowStore";

export type { EscrowChainAdapter, AdapterOp } from "./chainAdapter";
export { StubEscrowChainAdapter } from "./chainAdapter";

export type {
  EscrowManagerOptions,
  FinalizeResult,
  CrankFailure,
  CrankResult,
} from "./stateMachine";
export { EscrowManager, nextState } from "./stateMachine";
