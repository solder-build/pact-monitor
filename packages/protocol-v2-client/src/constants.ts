/**
 * Constants for `@q3labs/pact-protocol-v2-client`.
 *
 * Mirrors `packages/program/programs-pinocchio/pact-network-v2-pinocchio/src/{constants,pda,discriminator,error}.rs`.
 * Values flagged // CANONICAL are part of the public on-wire contract — do not
 * change without coordinating an on-chain redeploy.
 *
 * V2 is parametric/oracle insurance. Most state-changing instructions are
 * oracle- or `ProtocolConfig.authority`-signed. `pool.authority` is stored but
 * never checked by any V2 handler. See README for the role table.
 */
import { PublicKey } from "@solana/web3.js";

/**
 * Pact Network V2 program ID — Pinocchio crate `declare_id!`. WP-19 promoted
 * V2 to a fresh program ID so it cannot accidentally collide with the V1
 * deploy. Verified against `lib.rs:24` and `pda.rs::program_id_matches_pinocchio_declaration`.
 *
 * NOT YET DEPLOYED at the time of this package's first publish — see README.
 */
export const PROGRAM_ID = new PublicKey(
  "7i9zJMwaTRw4Tdy7SAfXJdDkYQD39xyKmkBhWuUSgDJU"
);

/** Devnet USDC mint (same as V1). */
export const USDC_MINT_DEVNET = new PublicKey(
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
);

/** Mainnet USDC mint (same as V1). */
export const USDC_MINT_MAINNET = new PublicKey(
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
);

/** Standard SPL Token program. */
export const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);

// ---------------------------------------------------------------------------
// PDA seeds — must match src/pda.rs verbatim.
// ---------------------------------------------------------------------------
export const SEED_PROTOCOL = Buffer.from("protocol");
export const SEED_POOL = Buffer.from("pool");
export const SEED_VAULT = Buffer.from("vault");
export const SEED_POSITION = Buffer.from("position");
export const SEED_POLICY = Buffer.from("policy");
export const SEED_CLAIM = Buffer.from("claim");

// ---------------------------------------------------------------------------
// Discriminator bytes — must match src/discriminator.rs verbatim. Contiguous
// 0..=10 (V1's gap-numbering policy was not carried into V2).
// ---------------------------------------------------------------------------
export const DISC_INITIALIZE_PROTOCOL = 0;
export const DISC_UPDATE_CONFIG = 1;
export const DISC_UPDATE_ORACLE = 2;
export const DISC_CREATE_POOL = 3;
export const DISC_DEPOSIT = 4;
export const DISC_ENABLE_INSURANCE = 5;
export const DISC_DISABLE_POLICY = 6;
export const DISC_SETTLE_PREMIUM = 7;
export const DISC_WITHDRAW = 8;
export const DISC_UPDATE_RATES = 9;
export const DISC_SUBMIT_CLAIM = 10;

// ---------------------------------------------------------------------------
// Absolute caps / floors — must match src/constants.rs.
// These are the on-chain safety floors enforced in update_config; the client
// surfaces them so callers can pre-validate before submitting.
// ---------------------------------------------------------------------------
export const ABSOLUTE_MIN_WITHDRAWAL_COOLDOWN = 3600;
export const ABSOLUTE_MAX_AGGREGATE_CAP_BPS = 8000;
export const ABSOLUTE_MAX_PROTOCOL_FEE_BPS = 3000;
export const ABSOLUTE_MIN_CLAIM_WINDOW = 60;
export const ABSOLUTE_MIN_POOL_DEPOSIT = 1_000_000n;

/** Hostname buffer cap on-chain is 64 bytes (`CoveragePool.provider_hostname`),
 *  even though `MAX_HOSTNAME_LEN = 128` in the Rust constants module — the
 *  `create_pool` handler caps the in-memory buffer to 64. Use this cap. */
export const MAX_HOSTNAME_LEN = 64;
export const MAX_AGENT_ID_LEN = 64;
export const MAX_CALL_ID_LEN = 64;

/** Maximum referrer share in bps of premium (WP-12 / Phase 5 F1). */
export const MAX_REFERRER_SHARE_BPS = 3000;

/** Hard 100% bps ceiling for rate validation. */
export const ABSOLUTE_BPS_CAP = 10_000;

// ---------------------------------------------------------------------------
// On-chain default values exposed by `InitializeProtocol`. Useful as
// reference for tooling that wants to know "what would the program set if
// I do not override these in update_config?".
// ---------------------------------------------------------------------------
export const DEFAULT_PROTOCOL_FEE_BPS = 1500;
export const DEFAULT_MIN_POOL_DEPOSIT = 100_000_000n;
export const DEFAULT_INSURANCE_RATE_BPS = 25;
export const DEFAULT_MAX_COVERAGE_PER_CALL = 1_000_000n;
export const DEFAULT_MIN_PREMIUM_BPS = 5;
export const DEFAULT_WITHDRAWAL_COOLDOWN = 604_800;
export const DEFAULT_AGGREGATE_CAP_BPS = 3000;
export const DEFAULT_AGGREGATE_CAP_WINDOW = 86_400;
export const DEFAULT_CLAIM_WINDOW = 3600;
export const DEFAULT_MAX_CLAIMS_PER_BATCH = 10;

/** PACT_ERROR_BASE — every variant maps to `Custom(BASE + variant_index)`. */
export const PACT_ERROR_BASE = 6000;
