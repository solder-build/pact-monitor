/**
 * Off-chain read helpers for `@q3labs/pact-protocol-v2-client`.
 *
 * Connection-touching code lives here (the builders and PDA helpers stay
 * passive). Mirrors the shape of V1 client's `helpers.ts`.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "./constants.js";
import {
  getCoveragePoolPda,
  getPolicyPda,
  getUnderwriterPositionPda,
} from "./pda.js";
import {
  CoveragePool,
  Policy,
  UnderwriterPosition,
  decodeCoveragePool,
  decodePolicy,
  decodeUnderwriterPosition,
} from "./state.js";

// Re-export the sync sha256-based call-id hash (lives in pda.ts because the
// claim PDA derivation needs it; this re-export makes it discoverable from
// the helpers namespace consumers reach for first).
export { hashCallId } from "./pda.js";

/** Associated Token Account program — the standard on Solana. */
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
);

/**
 * Derive the canonical Associated Token Account address for a given (owner,
 * mint) pair. Pure PDA derivation — no `@solana/spl-token` runtime dep
 * (matches V1 client's idiom).
 */
export function deriveAssociatedTokenAccount(
  owner: PublicKey,
  mint: PublicKey
): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return ata;
}

// ---------------------------------------------------------------------------
// Pool reads
// ---------------------------------------------------------------------------

export interface PoolStateSnapshot {
  /** The derived pool PDA. */
  pda: PublicKey;
  /** True iff the pool account exists on-chain (initialized via create_pool). */
  exists: boolean;
  /** Decoded snapshot; only present when `exists === true`. */
  pool?: CoveragePool;
}

/**
 * Look up a pool by its hostname. Returns `exists: false` when the PDA has
 * not been initialized yet (the program returns the account as empty until
 * `create_pool` runs).
 */
export async function getPoolState(
  connection: Connection,
  programId: PublicKey,
  hostname: string | Uint8Array
): Promise<PoolStateSnapshot> {
  const [pda] = getCoveragePoolPda(programId, hostname);
  const info = await connection.getAccountInfo(pda, "confirmed");
  if (!info) return { pda, exists: false };
  return { pda, exists: true, pool: decodeCoveragePool(info.data) };
}

// ---------------------------------------------------------------------------
// Agent / policy reads
// ---------------------------------------------------------------------------

export interface AgentPolicyState {
  /** The derived policy PDA for (pool, agent). */
  pda: PublicKey;
  /** True iff the policy account exists on-chain (enable_insurance has run). */
  exists: boolean;
  policy?: Policy;
  /** `policy.active === 1` — false when the policy is absent or disabled. */
  active: boolean;
  /**
   * True when the policy is past its `expires_at` (in seconds since epoch).
   * Pass `now` in seconds, default `Math.floor(Date.now() / 1000)`.
   */
  expired: boolean;
  /** Composite: exists && active && !expired. */
  eligibleForClaim: boolean;
}

/**
 * Read a policy's on-chain state and surface the three flags downstream
 * code looks at first. Pass `nowSeconds` for deterministic tests; defaults
 * to `Math.floor(Date.now() / 1000)`.
 */
export async function getAgentPolicyState(
  connection: Connection,
  agent: PublicKey,
  poolPda: PublicKey,
  programId: PublicKey,
  nowSeconds?: number
): Promise<AgentPolicyState> {
  const [pda] = getPolicyPda(programId, poolPda, agent);
  const info = await connection.getAccountInfo(pda, "confirmed");
  if (!info) {
    return {
      pda,
      exists: false,
      active: false,
      expired: false,
      eligibleForClaim: false,
    };
  }
  const policy = decodePolicy(info.data);
  const now = BigInt(nowSeconds ?? Math.floor(Date.now() / 1000));
  const active = policy.active === 1;
  const expired = policy.expiresAt <= now;
  return {
    pda,
    exists: true,
    policy,
    active,
    expired,
    eligibleForClaim: active && !expired,
  };
}

// ---------------------------------------------------------------------------
// Underwriter position reads
// ---------------------------------------------------------------------------

export interface UnderwriterPositionState {
  pda: PublicKey;
  exists: boolean;
  position?: UnderwriterPosition;
  /** Convenience: position.deposited or 0n when the position is absent. */
  deposited: bigint;
  /** Convenience: position.deposit_timestamp or 0n when absent. */
  lastDepositAt: bigint;
}

/**
 * Read an underwriter's position for a given pool.
 *
 * The returned object exposes a helper `cooldownElapsed(at, cooldownSeconds)`
 * that mirrors the on-chain check `now - deposit_timestamp >= cooldown` —
 * matches what `withdraw` enforces.
 */
export interface UnderwriterPositionStateWithCooldown
  extends UnderwriterPositionState {
  cooldownElapsed(atSeconds: number, cooldownSeconds: number): boolean;
}

export async function getUnderwriterPositionState(
  connection: Connection,
  underwriter: PublicKey,
  poolPda: PublicKey,
  programId: PublicKey
): Promise<UnderwriterPositionStateWithCooldown> {
  const [pda] = getUnderwriterPositionPda(programId, poolPda, underwriter);
  const info = await connection.getAccountInfo(pda, "confirmed");
  if (!info) {
    return {
      pda,
      exists: false,
      deposited: 0n,
      lastDepositAt: 0n,
      cooldownElapsed: () => false,
    };
  }
  const position = decodeUnderwriterPosition(info.data);
  return {
    pda,
    exists: true,
    position,
    deposited: position.deposited,
    lastDepositAt: position.depositTimestamp,
    cooldownElapsed(atSeconds: number, cooldownSeconds: number): boolean {
      return BigInt(atSeconds) - position.depositTimestamp >= BigInt(cooldownSeconds);
    },
  };
}
