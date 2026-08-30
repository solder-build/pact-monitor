/**
 * `@q3labs/pact-protocol-v2-client` — TypeScript client for the V2 Pinocchio
 * program at `packages/program/programs-pinocchio/pact-network-v2-pinocchio/`.
 *
 * V2 is parametric/oracle insurance. Most state-changing instructions are
 * signed by `ProtocolConfig.oracle` or `ProtocolConfig.authority`; the
 * per-pool `pool.authority` field is stored but never checked by any V2
 * handler. See README for the role-to-instruction mapping.
 *
 * This package mirrors the layout of `@q3labs/pact-protocol-v1-client` and
 * does not import from it.
 */

export {
  PROGRAM_ID,
  USDC_MINT_DEVNET,
  USDC_MINT_MAINNET,
  TOKEN_PROGRAM_ID,
  SEED_PROTOCOL,
  SEED_POOL,
  SEED_VAULT,
  SEED_POSITION,
  SEED_POLICY,
  SEED_CLAIM,
  DISC_INITIALIZE_PROTOCOL,
  DISC_UPDATE_CONFIG,
  DISC_UPDATE_ORACLE,
  DISC_CREATE_POOL,
  DISC_DEPOSIT,
  DISC_ENABLE_INSURANCE,
  DISC_DISABLE_POLICY,
  DISC_SETTLE_PREMIUM,
  DISC_WITHDRAW,
  DISC_UPDATE_RATES,
  DISC_SUBMIT_CLAIM,
  ABSOLUTE_MIN_WITHDRAWAL_COOLDOWN,
  ABSOLUTE_MAX_AGGREGATE_CAP_BPS,
  ABSOLUTE_MAX_PROTOCOL_FEE_BPS,
  ABSOLUTE_MIN_CLAIM_WINDOW,
  ABSOLUTE_MIN_POOL_DEPOSIT,
  ABSOLUTE_BPS_CAP,
  MAX_HOSTNAME_LEN,
  MAX_AGENT_ID_LEN,
  MAX_CALL_ID_LEN,
  MAX_REFERRER_SHARE_BPS,
  DEFAULT_PROTOCOL_FEE_BPS,
  DEFAULT_MIN_POOL_DEPOSIT,
  DEFAULT_INSURANCE_RATE_BPS,
  DEFAULT_MAX_COVERAGE_PER_CALL,
  DEFAULT_MIN_PREMIUM_BPS,
  DEFAULT_WITHDRAWAL_COOLDOWN,
  DEFAULT_AGGREGATE_CAP_BPS,
  DEFAULT_AGGREGATE_CAP_WINDOW,
  DEFAULT_CLAIM_WINDOW,
  DEFAULT_MAX_CLAIMS_PER_BATCH,
  PACT_ERROR_BASE,
} from "./constants.js";

export {
  getProtocolConfigPda,
  getCoveragePoolPda,
  getVaultPda,
  getUnderwriterPositionPda,
  getPolicyPda,
  getClaimPda,
  hashCallId,
  assertAgentIdLength,
} from "./pda.js";

export {
  PROTOCOL_V2_ERRORS,
  decodeProtocolError,
  formatProtocolError,
  tryExtractProtocolError,
} from "./errors.js";

export type {
  Pubkey,
  ProtocolConfig,
  CoveragePool,
  UnderwriterPosition,
  Policy,
  Claim,
} from "./state.js";

export type {
  InitializeProtocolParams,
  UpdateConfigParams,
  UpdateOracleParams,
  CreatePoolParams,
  DepositParams,
  EnableInsuranceParams,
  DisablePolicyParams,
  SettlePremiumParams,
  WithdrawParams,
  UpdateRatesParams,
  SubmitClaimParams,
} from "./instructions.js";
export {
  buildInitializeProtocolIx,
  buildUpdateConfigIx,
  buildUpdateOracleIx,
  buildCreatePoolIx,
  buildDepositIx,
  buildEnableInsuranceIx,
  buildDisablePolicyIx,
  buildSettlePremiumIx,
  buildWithdrawIx,
  buildUpdateRatesIx,
  buildSubmitClaimIx,
} from "./instructions.js";

export type {
  PoolStateSnapshot,
  AgentPolicyState,
  UnderwriterPositionState,
  UnderwriterPositionStateWithCooldown,
} from "./helpers.js";
export {
  deriveAssociatedTokenAccount,
  getPoolState,
  getAgentPolicyState,
  getUnderwriterPositionState,
} from "./helpers.js";
export {
  PROTOCOL_CONFIG_LEN,
  COVERAGE_POOL_LEN,
  UNDERWRITER_POSITION_LEN,
  POLICY_LEN,
  CLAIM_LEN,
  ACCOUNT_DISC_PROTOCOL_CONFIG,
  ACCOUNT_DISC_COVERAGE_POOL,
  ACCOUNT_DISC_UNDERWRITER_POSITION,
  ACCOUNT_DISC_POLICY,
  ACCOUNT_DISC_CLAIM,
  TriggerType,
  ClaimStatus,
  decodeProtocolConfig,
  decodeCoveragePool,
  decodeUnderwriterPosition,
  decodePolicy,
  decodeClaim,
} from "./state.js";
