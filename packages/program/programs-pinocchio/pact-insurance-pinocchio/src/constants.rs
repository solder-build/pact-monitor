/// Absolute minimum withdrawal cooldown in seconds (1 hour).
/// `config.withdrawal_cooldown_seconds` cannot be set below this value.
pub const ABSOLUTE_MIN_WITHDRAWAL_COOLDOWN: i64 = 3600;

/// Absolute maximum aggregate payout cap in basis points (80%).
/// `config.aggregate_cap_bps` cannot be set above this value.
pub const ABSOLUTE_MAX_AGGREGATE_CAP_BPS: u16 = 8000;

/// Absolute maximum protocol fee in basis points (30%).
/// `config.protocol_fee_bps` cannot be set above this value.
pub const ABSOLUTE_MAX_PROTOCOL_FEE_BPS: u16 = 3000;

/// Absolute minimum claim staleness window in seconds (1 minute).
/// `config.claim_window_seconds` cannot be set below this value.
pub const ABSOLUTE_MIN_CLAIM_WINDOW: i64 = 60;

/// Absolute minimum pool deposit amount in USDC lamports (1 USDC).
/// `config.min_pool_deposit` cannot be set below this value.
pub const ABSOLUTE_MIN_POOL_DEPOSIT: u64 = 1_000_000;

pub const MAX_HOSTNAME_LEN: usize = 128;
pub const MAX_AGENT_ID_LEN: usize = 64;
pub const MAX_CALL_ID_LEN: usize = 64;

pub const DEFAULT_PROTOCOL_FEE_BPS: u16 = 1500;
pub const DEFAULT_MIN_POOL_DEPOSIT: u64 = 100_000_000;
pub const DEFAULT_INSURANCE_RATE_BPS: u16 = 25;
pub const DEFAULT_MAX_COVERAGE_PER_CALL: u64 = 1_000_000;
pub const DEFAULT_MIN_PREMIUM_BPS: u16 = 5;
pub const DEFAULT_WITHDRAWAL_COOLDOWN: i64 = 604_800;
pub const DEFAULT_AGGREGATE_CAP_BPS: u16 = 3000;
pub const DEFAULT_AGGREGATE_CAP_WINDOW: i64 = 86_400;
pub const DEFAULT_CLAIM_WINDOW: i64 = 3600;
pub const DEFAULT_MAX_CLAIMS_PER_BATCH: u8 = 10;

/// Maximum referrer share in basis points (Rick Q2 confirmed 2026-04-24).
/// Unit: bps of PREMIUM (not pool balance).
/// Formula: `referrer_cut = premium * share_bps / 10_000`.
/// Consumed by WP-12 (`enable_insurance`) validation and WP-14
/// (`settle_premium`) split math.
pub const MAX_REFERRER_SHARE_BPS: u16 = 3000;
