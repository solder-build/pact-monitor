// @pact-network/wrap-v2 — V2 off-chain fetch wrap.
//
// Companion to @pact-network/wrap (V1). The on-the-wire shape changes
// (V2SettlementEvent carries hostname + policyPda + per-call value + an
// optional breach tail consumed by submit_claim); the API contract is
// otherwise familiar.

export { wrapFetch } from "./wrapFetch";
export type { V2WrapFetchOptions, V2WrapFetchResult } from "./wrapFetch";

export { defaultClassifier, composeWithDefault } from "./classifier";
export type { Classifier, ClassifierInput, ClassifierResult } from "./classifier";

export { createDefaultBalanceCheck } from "./balanceCheck";
export type {
  BalanceCheck,
  BalanceCheckResult,
  BalanceCheckRejectionReason,
  DefaultBalanceCheckOptions,
} from "./balanceCheck";

export {
  MemoryEventSink,
  HttpEventSink,
  PubSubEventSink,
  RedisStreamsEventSink,
} from "./eventSink";
export type {
  EventSink,
  HttpEventSinkOptions,
  PubSubEventSinkOptions,
  PubSubTopicPublisher,
  RedisStreamsEventSinkOptions,
  RedisStreamPublisher,
} from "./eventSink";

export { HEADERS, attachPactHeaders } from "./headers";
export type { PactHeaderInputs } from "./headers";

export type {
  Outcome,
  PolicyConfig,
  TriggerType,
  V2SettlementEvent,
} from "./types";
export {
  TRIGGER_TIMEOUT,
  TRIGGER_ERROR,
  TRIGGER_SCHEMA_MISMATCH,
  TRIGGER_LATENCY_SLA,
} from "./types";
