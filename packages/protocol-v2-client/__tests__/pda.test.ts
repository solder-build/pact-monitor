/**
 * Cross-language PDA verification.
 *
 * Each test pins a derived address against the same fixture pubkey used by
 * the Rust `pda.rs::tests::pinned_fixture_*` cases. If a seed literal here
 * (or in the constants module) drifts, these will fail loudly with a
 * base58 mismatch.
 */
import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import {
  getClaimPda,
  getCoveragePoolPda,
  getPolicyPda,
  getProtocolConfigPda,
  getUnderwriterPositionPda,
  getVaultPda,
  hashCallId,
  assertAgentIdLength,
} from "../src/pda.js";
import { PROGRAM_ID, MAX_AGENT_ID_LEN, MAX_HOSTNAME_LEN } from "../src/constants.js";

// Match the Rust fixture inputs: addr_from_bytes(0xAA), 0xBB, 0xCC, 0xDD.
function fillKey(byte: number): PublicKey {
  return new PublicKey(new Uint8Array(32).fill(byte));
}
const POOL_FIXTURE = fillKey(0xaa);
const UNDERWRITER_FIXTURE = fillKey(0xbb);
const AGENT_FIXTURE = fillKey(0xcc);
const POLICY_FIXTURE = fillKey(0xdd);

describe("PROGRAM_ID", () => {
  it("matches the V2 Pinocchio declare_id", () => {
    expect(PROGRAM_ID.toBase58()).toBe(
      "7i9zJMwaTRw4Tdy7SAfXJdDkYQD39xyKmkBhWuUSgDJU"
    );
  });
});

describe("getProtocolConfigPda", () => {
  it("matches Rust pinned_fixture_protocol", () => {
    const [pda] = getProtocolConfigPda(PROGRAM_ID);
    expect(pda.toBase58()).toBe(
      "HLU6tUmmJtBYwjzCenvNeEEcwSezzkE7cTTsW18uK5MK"
    );
  });
});

describe("getCoveragePoolPda", () => {
  it("matches Rust pinned_fixture_pool_openai (string input)", () => {
    const [pda] = getCoveragePoolPda(PROGRAM_ID, "api.openai.com");
    expect(pda.toBase58()).toBe(
      "7VSVcQMfqTdsiSGmjrg3ceQJDso7aeBuh6iaTAX7ux8c"
    );
  });

  it("derives identically from a pre-encoded Uint8Array", () => {
    const bytes = new TextEncoder().encode("api.openai.com");
    const [pda] = getCoveragePoolPda(PROGRAM_ID, bytes);
    expect(pda.toBase58()).toBe(
      "7VSVcQMfqTdsiSGmjrg3ceQJDso7aeBuh6iaTAX7ux8c"
    );
  });

  it("throws on hostname > MAX_HOSTNAME_LEN", () => {
    const tooLong = "a".repeat(MAX_HOSTNAME_LEN + 1);
    expect(() => getCoveragePoolPda(PROGRAM_ID, tooLong)).toThrow(
      /hostname seed too long/
    );
  });
});

describe("getVaultPda", () => {
  it("matches Rust pinned_fixture_vault", () => {
    const [pda] = getVaultPda(PROGRAM_ID, POOL_FIXTURE);
    expect(pda.toBase58()).toBe(
      "C9pRQChsRsJ914CVGarSkTBPmjw9rZy9QrHcV6HSo7an"
    );
  });
});

describe("getUnderwriterPositionPda", () => {
  it("matches Rust pinned_fixture_position", () => {
    const [pda] = getUnderwriterPositionPda(
      PROGRAM_ID,
      POOL_FIXTURE,
      UNDERWRITER_FIXTURE
    );
    expect(pda.toBase58()).toBe(
      "81dqp356ja99aaQ9LiQugmyjWzTA7JxbpY494C5hPLBL"
    );
  });
});

describe("getPolicyPda", () => {
  it("matches Rust pinned_fixture_policy", () => {
    const [pda] = getPolicyPda(PROGRAM_ID, POOL_FIXTURE, AGENT_FIXTURE);
    expect(pda.toBase58()).toBe(
      "6sjLrUhd9fDEqtg2GTtVS19iXrauP8W1nkzGgfX7ezSe"
    );
  });
});

describe("getClaimPda", () => {
  it("matches Rust pinned_fixture_claim from a pre-hashed 32-byte digest", () => {
    const hash = new Uint8Array(32).fill(0x42);
    const [pda] = getClaimPda(PROGRAM_ID, POLICY_FIXTURE, hash);
    expect(pda.toBase58()).toBe(
      "9vaDmGjEtX1koXgb8w2gQGsaGNhk8rNBtDUt7MzExHbE"
    );
  });

  it("hashes a string call_id and matches the same PDA when the hash matches", () => {
    // Pick a known call_id and verify both string and pre-hashed paths agree.
    const callId = "call-12345";
    const expectedHash = hashCallId(callId);
    const [fromString] = getClaimPda(PROGRAM_ID, POLICY_FIXTURE, callId);
    const [fromHash] = getClaimPda(PROGRAM_ID, POLICY_FIXTURE, expectedHash);
    expect(fromString.toBase58()).toBe(fromHash.toBase58());
  });

  it("throws on string call_id > MAX_CALL_ID_LEN", () => {
    const tooLong = "x".repeat(65);
    expect(() => getClaimPda(PROGRAM_ID, POLICY_FIXTURE, tooLong)).toThrow(
      /call_id too long/
    );
  });
});

describe("hashCallId", () => {
  it("returns a 32-byte digest", () => {
    const h = hashCallId("anything");
    expect(h.length).toBe(32);
  });

  it("matches SHA-256 of the UTF-8 bytes", () => {
    // sha256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
    const h = hashCallId("abc");
    const hex = Buffer.from(h).toString("hex");
    expect(hex).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  it("throws on overflow", () => {
    expect(() => hashCallId("x".repeat(65))).toThrow(/call_id too long/);
  });
});

describe("assertAgentIdLength", () => {
  it("accepts within cap", () => {
    expect(() => assertAgentIdLength("agent-1")).not.toThrow();
    expect(() => assertAgentIdLength("x".repeat(MAX_AGENT_ID_LEN))).not.toThrow();
  });

  it("rejects over cap", () => {
    expect(() => assertAgentIdLength("x".repeat(MAX_AGENT_ID_LEN + 1))).toThrow(
      /agent_id too long/
    );
  });
});
