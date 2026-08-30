/**
 * Maps PactError numeric codes (from V2 `src/error.rs`) to TypeScript-friendly
 * names + human-readable descriptions.
 *
 * V2's codespace is contiguous 6000..=6030 (no gaps — V1's reserved gaps are
 * not present in V2's enum). Names and codes diverge from V1: V2 has
 * `ProtocolPaused = 6000`, V1 had `InsufficientBalance = 6000`. Do NOT route
 * a V1-program error through this decoder; the message will be wrong.
 */

export const PROTOCOL_V2_ERRORS: Record<
  number,
  { name: string; message: string }
> = {
  6000: {
    name: "ProtocolPaused",
    message:
      "Protocol kill switch engaged — V2 refuses new deposits, policies, and claims while ProtocolConfig.paused is set.",
  },
  6001: {
    name: "PoolAlreadyExists",
    message: "CoveragePool PDA already exists for the given hostname.",
  },
  6002: {
    name: "PolicyAlreadyExists",
    message: "Policy PDA already exists for the given (pool, agent) pair.",
  },
  6003: {
    name: "DelegationMissing",
    message: "Agent token account has no SPL Approve set to the pool PDA.",
  },
  6004: {
    name: "DelegationInsufficient",
    message: "Agent token account's delegated amount is zero.",
  },
  6005: {
    name: "TokenAccountMismatch",
    message:
      "SPL Token account fails mint/owner/authority check against expected pool, agent, or vault.",
  },
  6006: {
    name: "PolicyInactive",
    message: "Policy has been disabled (active=0) via disable_policy.",
  },
  6007: {
    name: "InsufficientPoolBalance",
    message: "UnderwriterPosition.deposited is less than the requested withdrawal amount.",
  },
  6008: {
    name: "InsufficientPrepaidBalance",
    message: "Prepaid balance insufficient (reserved — not currently emitted).",
  },
  6009: {
    name: "WithdrawalUnderCooldown",
    message:
      "Withdrawal attempted before deposit_timestamp + config.withdrawal_cooldown_seconds elapsed.",
  },
  6010: {
    name: "WithdrawalWouldUnderfund",
    message:
      "Withdrawal would leave pool.total_available below outstanding claim exposure.",
  },
  6011: {
    name: "AggregateCapExceeded",
    message:
      "Claim payout would exceed pool.payouts_this_window cap within the current aggregate-cap window.",
  },
  6012: {
    name: "ClaimWindowExpired",
    message:
      "Submitted claim's call_timestamp is older than config.claim_window_seconds.",
  },
  6013: {
    name: "DuplicateClaim",
    message:
      "Claim PDA already exists for this (policy, call_id_hash) — call_id has been claimed before.",
  },
  6014: {
    name: "InvalidRate",
    message:
      "Referrer present/share_bps mutual-exclusion violated (one is zero while the other is not).",
  },
  6015: {
    name: "HostnameTooLong",
    message: "Hostname seed length exceeds the on-chain 64-byte buffer.",
  },
  6016: {
    name: "AgentIdTooLong",
    message: "agent_id string length exceeds MAX_AGENT_ID_LEN (64).",
  },
  6017: {
    name: "CallIdTooLong",
    message: "call_id string length exceeds MAX_CALL_ID_LEN (64).",
  },
  6018: {
    name: "Unauthorized",
    message: "Authority / signer / account-ownership invariant failed.",
  },
  6019: {
    name: "InvalidTriggerType",
    message:
      "submit_claim trigger_type byte is not one of {0=Timeout, 1=Error, 2=SchemaMismatch, 3=LatencySla}.",
  },
  6020: {
    name: "ZeroAmount",
    message: "Deposit / withdrawal / claim amount must be greater than zero.",
  },
  6021: {
    name: "BelowMinimumDeposit",
    message: "Deposit amount is below config.min_pool_deposit.",
  },
  6022: {
    name: "ConfigSafetyFloorViolation",
    message:
      "update_config field violates one of the absolute safety floors / ceilings (e.g., withdrawal_cooldown < 3600s, aggregate_cap_bps > 8000).",
  },
  6023: {
    name: "ArithmeticOverflow",
    message: "u64/u128 checked_add or checked_sub overflowed.",
  },
  6024: {
    name: "UnauthorizedDeployer",
    message:
      "initialize_protocol deployer signer is not the hardcoded DEPLOYER_PUBKEY (C-01 guard).",
  },
  6025: {
    name: "UnauthorizedOracle",
    message:
      "Oracle signer is not equal to ProtocolConfig.oracle (C-02 split-authority guard).",
  },
  6026: {
    name: "FrozenConfigField",
    message:
      "update_config attempted to mutate a frozen field (treasury or usdc_mint) — these are set at initialize and cannot be updated.",
  },
  6027: {
    name: "RateOutOfBounds",
    message:
      "Rate update or referrer share exceeds the absolute bps ceiling (10000 for rates, MAX_REFERRER_SHARE_BPS=3000 for referrer).",
  },
  6028: {
    name: "RateBelowFloor",
    message: "Rate update is below pool.min_premium_bps floor.",
  },
  6029: {
    name: "PolicyExpired",
    message:
      "Claim submitted after the policy's expires_at — the policy must be renewed to file new claims.",
  },
  6030: {
    name: "InvalidOracleKey",
    message:
      "update_oracle rejected: new oracle is the zero address or equal to ProtocolConfig.authority (which would defeat the C-02 split).",
  },
};

/**
 * Look up a V2 error by code. Returns `undefined` for unknown codes.
 */
export function decodeProtocolError(
  code: number
): { name: string; message: string } | undefined {
  return PROTOCOL_V2_ERRORS[code];
}

/**
 * Format a `ProgramError::Custom(code)` into a `Name (code): message` string.
 * Returns `Custom(<code>): unknown error` when the code is not one of V2's.
 */
export function formatProtocolError(code: number): string {
  const e = PROTOCOL_V2_ERRORS[code];
  if (!e) return `Custom(${code}): unknown error`;
  return `${e.name} (${code}): ${e.message}`;
}

/**
 * Try to extract a V2 Pact error from an arbitrary thrown value (e.g. a
 * `SendTransactionError` from web3.js). Walks the value's enumerable
 * properties looking for `{ Custom: <number> }`. Returns `undefined` if no
 * Custom code is found.
 */
export function tryExtractProtocolError(
  err: unknown
): { code: number; name: string; message: string } | undefined {
  if (!err || typeof err !== "object") return undefined;
  const seen = new Set<unknown>();
  function walk(node: unknown): number | undefined {
    if (!node || typeof node !== "object" || seen.has(node)) return undefined;
    seen.add(node);
    const o = node as Record<string, unknown>;
    if ("Custom" in o && typeof o.Custom === "number") {
      return o.Custom;
    }
    if (Array.isArray(node)) {
      for (const v of node) {
        const r = walk(v);
        if (r !== undefined) return r;
      }
      return undefined;
    }
    for (const k of Object.keys(o)) {
      const r = walk(o[k]);
      if (r !== undefined) return r;
    }
    return undefined;
  }
  const code = walk(err);
  if (code === undefined) return undefined;
  const e = PROTOCOL_V2_ERRORS[code];
  if (!e) return { code, name: "Unknown", message: `Custom(${code})` };
  return { code, ...e };
}
