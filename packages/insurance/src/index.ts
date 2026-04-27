export { PactInsurance } from "./client.js";
export type {
  PactInsuranceConfig,
  PolicyInfo,
  ClaimSubmissionResult,
  EnableInsuranceArgs,
  TopUpDelegationArgs,
  CoverageEstimate,
  BilledEvent,
  LowBalanceEvent,
} from "./types.js";

// Codama-TS client surface (Pinocchio primary transport as of WP-17).
export * as generated from "./generated/index.js";

// Legacy Anchor transport — retained as rollback fallback (WP-17 scope change,
// Alan 2026-04-24). Not the default. Accessible for emergency use or testing.
export * as legacyAnchorClient from "./legacy-anchor-client.js";
