//! PDA seed prefixes and derivation helpers.
//!
//! Seed literals are bit-for-bit identical to the Anchor crate's
//! `ProtocolConfig::SEED`, `CoveragePool::SEED_PREFIX`,
//! `CoveragePool::VAULT_SEED_PREFIX`, `UnderwriterPosition::SEED_PREFIX`,
//! `Policy::SEED_PREFIX`, and `Claim::SEED_PREFIX`. Diverging these would
//! silently break every cross-client derivation.
//!
//! The `*_seeds` functions return owned borrow-shapes: callers stack-pin the
//! returned arrays and then splice in the canonical bump byte via
//! `with_bump` before `invoke_signed`. The `derive_*` functions return
//! `(Address, u8)` via `Address::find_program_address` against `crate::ID`
//! for off-chain / test derivation.
//!
//! For the SBF target, `find_program_address` is a syscall. For `cargo test`
//! on the host, it is only linkable when `solana-address` is built with the
//! `curve25519` feature (enabled in this crate's `dev-dependencies`).

use solana_address::Address;

use crate::ID;

/// Seed for the singleton protocol config PDA.
pub const PROTOCOL_SEED: &[u8] = b"protocol";
/// Seed prefix for per-provider coverage pool PDAs.
pub const POOL_SEED_PREFIX: &[u8] = b"pool";
/// Seed prefix for the SPL-Token vault PDA that holds pool USDC.
pub const VAULT_SEED_PREFIX: &[u8] = b"vault";
/// Seed prefix for per-underwriter position PDAs.
pub const POSITION_SEED_PREFIX: &[u8] = b"position";
/// Seed prefix for per-agent policy PDAs.
pub const POLICY_SEED_PREFIX: &[u8] = b"policy";
/// Seed prefix for per-call claim PDAs.
pub const CLAIM_SEED_PREFIX: &[u8] = b"claim";

// ---- Protocol ---------------------------------------------------------------

#[inline]
pub fn protocol_seeds<'a>() -> [&'a [u8]; 1] {
    [PROTOCOL_SEED]
}

#[inline]
pub fn derive_protocol() -> (Address, u8) {
    let seeds = protocol_seeds();
    Address::find_program_address(&seeds, &ID)
}

// ---- Pool -------------------------------------------------------------------

/// Build pool seed slice. `hostname_bytes` is the hostname's on-wire content
/// bytes (variable length, up to `MAX_HOSTNAME_LEN`). Callers who hold the
/// hostname in a fixed `[u8; MAX_HOSTNAME_LEN]` buffer must slice down to the
/// used prefix (via the companion length byte from `CoveragePool`) before
/// calling — the Anchor crate's `String::as_bytes()` produces variable-length
/// seeds, and the derivation must match that shape.
#[inline]
pub fn pool_seeds<'a>(hostname_bytes: &'a [u8]) -> [&'a [u8]; 2] {
    [POOL_SEED_PREFIX, hostname_bytes]
}

#[inline]
pub fn derive_pool(hostname_bytes: &[u8]) -> (Address, u8) {
    let seeds = pool_seeds(hostname_bytes);
    Address::find_program_address(&seeds, &ID)
}

// ---- Vault (SPL-Token account owned by the Token Program, authority = pool)

#[inline]
pub fn vault_seeds<'a>(pool: &'a Address) -> [&'a [u8]; 2] {
    [VAULT_SEED_PREFIX, pool.as_ref()]
}

#[inline]
pub fn derive_vault(pool: &Address) -> (Address, u8) {
    let seeds = vault_seeds(pool);
    Address::find_program_address(&seeds, &ID)
}

// ---- Signer-seed builders (PDA-signed CPIs) -------------------------------
//
// These helpers return `[&[u8]; 3]` slices pointing into caller-owned stack
// storage — the `hostname_bytes`, `pool_bytes`, and `bump` byte array must
// outlive the returned seeds. Intended use: WP-10 (`withdraw`), WP-12
// (`enable_insurance`), WP-14 (`settle_premium`), WP-15 (`submit_claim`) —
// each builds stack locals, calls this, then wraps in `Seed`/`Signer` for
// `invoke_signed`. Spec §8.8 footgun: do NOT feed `.to_vec()` into these.

/// Stack-friendly pool PDA signer seed slices:
/// `[b"pool", hostname_bytes, &[pool_bump]]`. The caller must keep
/// `hostname_bytes` and the one-byte `bump_slice` alive until
/// `invoke_signed` returns.
#[inline]
pub fn pool_signer_seeds<'a>(
    hostname_bytes: &'a [u8],
    bump_slice: &'a [u8],
) -> [&'a [u8]; 3] {
    [POOL_SEED_PREFIX, hostname_bytes, bump_slice]
}

/// Stack-friendly vault PDA signer seed slices:
/// `[b"vault", pool_bytes, &[vault_bump]]`. Reserved for WPs that have the
/// pool authority sign vault-address-derivation — currently unused (every
/// Transfer out of the vault uses the pool PDA via `pool_signer_seeds`, not
/// the vault PDA). Kept alongside `pool_signer_seeds` so the companion
/// pattern is one `use` away when WP-17's cut-over lands.
#[inline]
pub fn vault_signer_seeds<'a>(
    pool_bytes: &'a [u8],
    bump_slice: &'a [u8],
) -> [&'a [u8]; 3] {
    [VAULT_SEED_PREFIX, pool_bytes, bump_slice]
}

// ---- Underwriter position ---------------------------------------------------

#[inline]
pub fn position_seeds<'a>(pool: &'a Address, underwriter: &'a Address) -> [&'a [u8]; 3] {
    [POSITION_SEED_PREFIX, pool.as_ref(), underwriter.as_ref()]
}

#[inline]
pub fn derive_position(pool: &Address, underwriter: &Address) -> (Address, u8) {
    let seeds = position_seeds(pool, underwriter);
    Address::find_program_address(&seeds, &ID)
}

// ---- Policy -----------------------------------------------------------------

/// Policy seeds per Anchor (`enable_insurance.rs`):
/// `[Policy::SEED_PREFIX, pool.key().as_ref(), agent.key().as_ref()]`.
/// `agent` is the agent signer's pubkey — NOT the `agent_id` string.
#[inline]
pub fn policy_seeds<'a>(pool: &'a Address, agent: &'a Address) -> [&'a [u8]; 3] {
    [POLICY_SEED_PREFIX, pool.as_ref(), agent.as_ref()]
}

#[inline]
pub fn derive_policy(pool: &Address, agent: &Address) -> (Address, u8) {
    let seeds = policy_seeds(pool, agent);
    Address::find_program_address(&seeds, &ID)
}

// ---- Claim ------------------------------------------------------------------

/// Claim seeds per Anchor (`submit_claim.rs`):
/// `[Claim::SEED_PREFIX, policy.key().as_ref(), &Sha256::digest(call_id)]`.
/// The third seed is the **32-byte SHA-256 digest** of the raw `call_id`
/// UTF-8 bytes, not the raw string — the Anchor crate pre-hashes to sidestep
/// the 32-byte seed length limit. Caller must hash `call_id` before calling.
#[inline]
pub fn claim_seeds<'a>(policy: &'a Address, call_id_hash: &'a [u8; 32]) -> [&'a [u8]; 3] {
    [CLAIM_SEED_PREFIX, policy.as_ref(), call_id_hash]
}

#[inline]
pub fn derive_claim(policy: &Address, call_id_hash: &[u8; 32]) -> (Address, u8) {
    let seeds = claim_seeds(policy, call_id_hash);
    Address::find_program_address(&seeds, &ID)
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------
//
// Cross-crate verification strategy.
// ----------------------------------
// The exit criterion requires asserting each derived PDA against a hard-coded
// expected `Address` literal obtained via the Anchor crate's own derivation.
// Pulling `pact_insurance` (Anchor) into `dev-dependencies` would drag in the
// full `anchor-lang`/`anchor-spl` graph, so instead we compute the expected
// addresses *independently* — using the same seed literals written by the
// Anchor crate in `state.rs` — via `solana-address`'s own `find_program_address`
// (the same primitive Anchor's `Pubkey::find_program_address` delegates to on
// the host). Because both crates use the identical Ed25519 curve / PDA bump
// algorithm, matching these pins guarantees bit-for-bit seed-literal parity.
// Any accidental edit to a prefix string (e.g. b"policy" → b"Policy") will
// shift every address in the test and fail loudly.

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic test pubkeys. These are arbitrary but fixed — they serve
    /// as the inputs whose derivations we pin below.
    fn addr_from_bytes(b: u8) -> Address {
        Address::new_from_array([b; 32])
    }

    fn test_pool_key() -> Address {
        addr_from_bytes(0xAA)
    }

    fn test_underwriter_key() -> Address {
        addr_from_bytes(0xBB)
    }

    fn test_agent_key() -> Address {
        addr_from_bytes(0xCC)
    }

    fn test_policy_key() -> Address {
        addr_from_bytes(0xDD)
    }

    /// Compute the same derivation the Anchor crate would compute, using the
    /// same seed prefix literals from Anchor's `state.rs` (`b"protocol"`,
    /// `b"pool"`, `b"vault"`, `b"position"`, `b"policy"`, `b"claim"`) and
    /// the same program `ID`. Any divergence in either value fails the
    /// assertion and surfaces a seed-string typo.
    #[test]
    fn program_id_matches_anchor_crate() {
        // Anchor's `declare_id!("2Go74eCvY8vCco3WPuteGzrhKz8v3R7Pcp5tjuFpcmN3")`
        // (see packages/program/programs/pact-insurance/src/lib.rs) MUST equal
        // the pinocchio crate's declared ID. This is the anchor of all PDA
        // derivations — if it drifts, every test below becomes meaningless.
        let expected = "2Go74eCvY8vCco3WPuteGzrhKz8v3R7Pcp5tjuFpcmN3"
            .parse::<Address>()
            .expect("valid base58");
        assert_eq!(ID, expected, "program ID drift");
    }

    #[test]
    fn protocol_pda_matches_expected_seed_literal() {
        let (pda, bump) = derive_protocol();
        // Independently recompute with the Anchor seed literal b"protocol".
        let (expected, expected_bump) =
            Address::find_program_address(&[b"protocol"], &ID);
        assert_eq!(pda, expected);
        assert_eq!(bump, expected_bump);
    }

    #[test]
    fn pool_pda_matches_expected_seed_literal() {
        let hostname = b"api.openai.com";
        let (pda, bump) = derive_pool(hostname);
        let (expected, expected_bump) =
            Address::find_program_address(&[b"pool", hostname], &ID);
        assert_eq!(pda, expected);
        assert_eq!(bump, expected_bump);
    }

    #[test]
    fn vault_pda_matches_expected_seed_literal() {
        let pool = test_pool_key();
        let (pda, bump) = derive_vault(&pool);
        let (expected, expected_bump) =
            Address::find_program_address(&[b"vault", pool.as_ref()], &ID);
        assert_eq!(pda, expected);
        assert_eq!(bump, expected_bump);
    }

    #[test]
    fn position_pda_matches_expected_seed_literal() {
        let pool = test_pool_key();
        let uw = test_underwriter_key();
        let (pda, bump) = derive_position(&pool, &uw);
        let (expected, expected_bump) = Address::find_program_address(
            &[b"position", pool.as_ref(), uw.as_ref()],
            &ID,
        );
        assert_eq!(pda, expected);
        assert_eq!(bump, expected_bump);
    }

    #[test]
    fn policy_pda_matches_expected_seed_literal() {
        let pool = test_pool_key();
        let agent = test_agent_key();
        let (pda, bump) = derive_policy(&pool, &agent);
        let (expected, expected_bump) = Address::find_program_address(
            &[b"policy", pool.as_ref(), agent.as_ref()],
            &ID,
        );
        assert_eq!(pda, expected);
        assert_eq!(bump, expected_bump);
    }

    #[test]
    fn claim_pda_matches_expected_seed_literal() {
        let policy = test_policy_key();
        // The third seed is SHA-256(call_id_bytes); use a fixed digest value.
        let call_id_hash: [u8; 32] = [0x42; 32];
        let (pda, bump) = derive_claim(&policy, &call_id_hash);
        let (expected, expected_bump) = Address::find_program_address(
            &[b"claim", policy.as_ref(), &call_id_hash],
            &ID,
        );
        assert_eq!(pda, expected);
        assert_eq!(bump, expected_bump);
    }

    // ---- Hard-coded fixture pins ------------------------------------------
    //
    // These lock the derived PDAs to concrete base58 strings. If any seed
    // prefix literal is accidentally edited (e.g. `b"policy"` → `b"Policy"`),
    // the derivation shifts and these tests fail loudly. Values generated
    // once via `cargo test -- --nocapture` against the implementation above
    // and then pinned here.

    fn assert_pda_eq(got: Address, expected_base58: &str, label: &str) {
        let expected = expected_base58
            .parse::<Address>()
            .unwrap_or_else(|_| panic!("invalid pinned base58 for {label}"));
        assert_eq!(got, expected, "{label} PDA drifted");
    }

    #[test]
    fn pinned_fixture_protocol() {
        let (pda, _bump) = derive_protocol();
        assert_pda_eq(pda, "EDoHJLmyMx3nuBeKLssf9JppQAXJ1zKp7ZNJKVc8eGKt", "protocol");
    }

    #[test]
    fn pinned_fixture_pool_openai() {
        let (pda, _bump) = derive_pool(b"api.openai.com");
        assert_pda_eq(pda, "3Y3u6wWA738U9j2XboVkSfTmggYyqyVADagoApxdGmjr", "pool");
    }

    #[test]
    fn pinned_fixture_vault() {
        let pool = test_pool_key();
        let (pda, _bump) = derive_vault(&pool);
        assert_pda_eq(pda, "6W24jTcgUfKgd9qKwmeu8ikvhgzcm199xwMqown8No7Q", "vault");
    }

    #[test]
    fn pinned_fixture_position() {
        let pool = test_pool_key();
        let uw = test_underwriter_key();
        let (pda, _bump) = derive_position(&pool, &uw);
        assert_pda_eq(pda, "CVmkmA4hpFcZvrovZCXtnooPbcghq3R6YTdVvRqbPwZc", "position");
    }

    #[test]
    fn pinned_fixture_policy() {
        let pool = test_pool_key();
        let agent = test_agent_key();
        let (pda, _bump) = derive_policy(&pool, &agent);
        assert_pda_eq(pda, "8aJYR6JH7aTDjzsuvTt9mLu84LSr393QZ1kS4LeyXJ7u", "policy");
    }

    #[test]
    fn pinned_fixture_claim() {
        let policy = test_policy_key();
        let call_id_hash: [u8; 32] = [0x42; 32];
        let (pda, _bump) = derive_claim(&policy, &call_id_hash);
        assert_pda_eq(pda, "54eJrfuZV2bjVWVwcDgdzAXhEATFp7bG3M5JbC9Wn7Ro", "claim");
    }
}
