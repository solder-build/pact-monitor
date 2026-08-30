/**
 * PDA derivation helpers for `@q3labs/pact-protocol-v2-client`.
 *
 * Mirrors `src/pda.rs::derive_*` bit-for-bit. Seed literals MUST match the
 * Rust crate exactly — a single-byte drift here breaks every cross-client
 * derivation and is the most common silent integration bug.
 *
 * Sync everywhere. The Claim PDA overload that accepts a raw `call_id`
 * string computes its SHA-256 with `@noble/hashes/sha2` (sync, isomorphic,
 * audited) — using `crypto.subtle.digest` would force the PDA helper to
 * return a Promise, which is an ergonomic regression vs V1's sync helpers.
 */
import { PublicKey } from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha2";
import {
  MAX_AGENT_ID_LEN,
  MAX_CALL_ID_LEN,
  MAX_HOSTNAME_LEN,
  SEED_CLAIM,
  SEED_POLICY,
  SEED_POOL,
  SEED_POSITION,
  SEED_PROTOCOL,
  SEED_VAULT,
} from "./constants.js";

/**
 * UTF-8 encode a hostname for use as the variable-length pool seed.
 *
 * On-chain the hostname is stored in a fixed `[u8; 64]` buffer with a
 * companion `provider_hostname_len` byte; the PDA seed is the sliced prefix
 * of `len` bytes. Callers passing a `Uint8Array` MUST have already trimmed
 * to the on-chain length — passing the padded buffer will derive a
 * different (non-canonical) PDA.
 */
function hostnameSeedBytes(hostname: string | Uint8Array): Uint8Array {
  const bytes =
    typeof hostname === "string" ? new TextEncoder().encode(hostname) : hostname;
  if (bytes.length > MAX_HOSTNAME_LEN) {
    throw new Error(
      `hostname seed too long: ${bytes.length} bytes (max ${MAX_HOSTNAME_LEN})`
    );
  }
  return bytes;
}

/** Sync SHA-256 of UTF-8 bytes. Used internally for the call-id PDA seed. */
function sha256Bytes(input: string | Uint8Array): Uint8Array {
  const bytes =
    typeof input === "string" ? new TextEncoder().encode(input) : input;
  return sha256(bytes);
}

/**
 * Derive the singleton ProtocolConfig PDA. Seeds: `[b"protocol"]`.
 *
 * Returns `[address, bump]`. The bump is the canonical bump returned by
 * `findProgramAddressSync` — the on-chain program stores this and re-derives
 * with `Pubkey::create_program_address` using the stored bump on every
 * subsequent call, so the bump in the returned tuple is the only valid one.
 */
export function getProtocolConfigPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([SEED_PROTOCOL], programId);
}

/**
 * Derive the CoveragePool PDA for a given hostname.
 * Seeds: `[b"pool", hostname_bytes]`.
 *
 * `hostname` may be a JS string (UTF-8 encoded internally) or a pre-encoded
 * `Uint8Array`. Either way the byte length must be ≤ `MAX_HOSTNAME_LEN` (64).
 */
export function getCoveragePoolPda(
  programId: PublicKey,
  hostname: string | Uint8Array
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEED_POOL, hostnameSeedBytes(hostname)],
    programId
  );
}

/**
 * Derive the SPL-Token vault PDA for a given pool.
 * Seeds: `[b"vault", pool_bytes]`. The vault is owned by the SPL Token
 * Program, not by V2 — V2 signs vault transfers via the pool PDA's seeds.
 */
export function getVaultPda(
  programId: PublicKey,
  pool: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEED_VAULT, pool.toBuffer()],
    programId
  );
}

/**
 * Derive the UnderwriterPosition PDA.
 * Seeds: `[b"position", pool_bytes, underwriter_bytes]`.
 */
export function getUnderwriterPositionPda(
  programId: PublicKey,
  pool: PublicKey,
  underwriter: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEED_POSITION, pool.toBuffer(), underwriter.toBuffer()],
    programId
  );
}

/**
 * Derive the Policy PDA for a (pool, agent) pair.
 * Seeds: `[b"policy", pool_bytes, agent_bytes]`.
 *
 * `agent` is the agent's signer pubkey (wallet), **NOT** the agent's USDC
 * ATA. The agent_id string is metadata stored inside the Policy account but
 * is NOT a seed component (so the same wallet cannot hold two policies on
 * one pool under different agent_id strings).
 */
export function getPolicyPda(
  programId: PublicKey,
  pool: PublicKey,
  agent: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEED_POLICY, pool.toBuffer(), agent.toBuffer()],
    programId
  );
}

/**
 * Derive the Claim PDA.
 * Seeds: `[b"claim", policy_bytes, sha256(call_id_utf8)]`.
 *
 * Two-overload signature:
 *  - `(programId, policy, callId: string)` — UTF-8 encodes + SHA-256 hashes
 *    internally. The most common path.
 *  - `(programId, policy, callIdHash: Uint8Array)` — caller passes a
 *    pre-computed 32-byte digest. Used when the caller has already hashed
 *    the call_id (e.g., reconciling against a decoded on-chain `Claim`,
 *    whose `call_id` field is the 32-byte digest, not the raw string).
 *
 * Throws on `callId` byte length > `MAX_CALL_ID_LEN` (64) — the on-chain
 * decoder rejects longer ids — and on `callIdHash.length !== 32`.
 */
export function getClaimPda(
  programId: PublicKey,
  policy: PublicKey,
  callId: string | Uint8Array
): [PublicKey, number] {
  let hash: Uint8Array;
  if (typeof callId === "string") {
    const bytes = new TextEncoder().encode(callId);
    if (bytes.length > MAX_CALL_ID_LEN) {
      throw new Error(
        `call_id too long: ${bytes.length} bytes (max ${MAX_CALL_ID_LEN})`
      );
    }
    hash = sha256Bytes(bytes);
  } else if (callId.length === 32) {
    hash = callId;
  } else {
    if (callId.length > MAX_CALL_ID_LEN) {
      throw new Error(
        `call_id too long: ${callId.length} bytes (max ${MAX_CALL_ID_LEN})`
      );
    }
    hash = sha256Bytes(callId);
  }
  return PublicKey.findProgramAddressSync(
    [SEED_CLAIM, policy.toBuffer(), hash],
    programId
  );
}

/**
 * Public SHA-256 helper. Exported so callers can derive Claim PDAs from a
 * known raw string AND reconcile that hash against the on-chain `Claim.call_id`
 * field (which stores the 32-byte digest, not the raw string). Sync,
 * isomorphic. See pda.ts header for the sync-vs-async tradeoff.
 *
 * Re-exported by `helpers.ts` for discoverability.
 */
export function hashCallId(callId: string | Uint8Array): Uint8Array {
  const bytes =
    typeof callId === "string" ? new TextEncoder().encode(callId) : callId;
  if (bytes.length > MAX_CALL_ID_LEN) {
    throw new Error(
      `call_id too long: ${bytes.length} bytes (max ${MAX_CALL_ID_LEN})`
    );
  }
  return sha256Bytes(bytes);
}

/**
 * Public agent_id length validator. Surfaced because `enable_insurance`
 * accepts `agent_id` as a Borsh `String` capped at `MAX_AGENT_ID_LEN` on the
 * wire; callers that hash or persist the value outside the builder benefit
 * from sharing one validator. Throws on overflow.
 */
export function assertAgentIdLength(agentId: string | Uint8Array): void {
  const len =
    typeof agentId === "string"
      ? new TextEncoder().encode(agentId).length
      : agentId.length;
  if (len > MAX_AGENT_ID_LEN) {
    throw new Error(`agent_id too long: ${len} bytes (max ${MAX_AGENT_ID_LEN})`);
  }
}
