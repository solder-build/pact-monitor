/**
 * `disable_policy` (disc 6) — agent flips `policy.active = 0`.
 *
 * Covered:
 *   - happy: active → 0; pool.active_policies decremented (saturating_sub)
 *   - cross-pool reject (6018 Unauthorized — policy.pool != supplied pool)
 *   - non-agent signer reject (6018 — has_one agent semantics)
 *   - already-inactive reject (6006 PolicyInactive — idempotent disable
 *     is an explicit error)
 */
import { describe, expect, it } from "vitest";
import { LiteSVM } from "litesvm";
import { Transaction } from "@solana/web3.js";
import {
  PROGRAM_ID,
  buildDisablePolicyIx,
  decodeCoveragePool,
  decodePolicy,
} from "@q3labs/pact-protocol-v2-client";
import {
  airdrop,
  generateKeypair,
  getAccountData,
  loadProgram,
  sendAndExtractCode,
} from "./helpers.js";
import { setupPolicy, setupPool, setupProtocol } from "./fixtures.js";

describe("disable_policy — happy path", () => {
  it("sets policy.active = 0 and decrements pool.active_policies", () => {
    const svm = new LiteSVM();
    loadProgram(svm, { bypass: true });
    const proto = setupProtocol(svm);
    const pool = setupPool(svm, proto, "api.openai.com");
    const policy = setupPolicy(svm, proto, pool);

    const poolBefore = decodeCoveragePool(getAccountData(svm, pool.poolPda)!);
    expect(poolBefore.activePolicies).toBe(1);

    const ix = buildDisablePolicyIx({
      programId: PROGRAM_ID,
      poolPda: pool.poolPda,
      policyPda: policy.policyPda,
      agent: policy.agent.publicKey,
    });
    expect(
      sendAndExtractCode(svm, new Transaction().add(ix), policy.agent)
    ).toBeUndefined();

    const decoded = decodePolicy(getAccountData(svm, policy.policyPda)!);
    expect(decoded.active).toBe(0);

    const poolAfter = decodeCoveragePool(getAccountData(svm, pool.poolPda)!);
    expect(poolAfter.activePolicies).toBe(0);
  });
});

describe("disable_policy — failure modes", () => {
  it("rejects when a different pool is supplied (cross-pool swap)", () => {
    const svm = new LiteSVM();
    loadProgram(svm, { bypass: true });
    const proto = setupProtocol(svm);
    const poolA = setupPool(svm, proto, "api.openai.com");
    const poolB = setupPool(svm, proto, "api.anthropic.com");
    const policy = setupPolicy(svm, proto, poolA);

    const ix = buildDisablePolicyIx({
      programId: PROGRAM_ID,
      poolPda: poolB.poolPda, // wrong pool
      policyPda: policy.policyPda,
      agent: policy.agent.publicKey,
    });
    expect(sendAndExtractCode(svm, new Transaction().add(ix), policy.agent)).toBe(6018);
  });

  it("rejects when a non-agent signs (has_one agent rule)", () => {
    const svm = new LiteSVM();
    loadProgram(svm, { bypass: true });
    const proto = setupProtocol(svm);
    const pool = setupPool(svm, proto, "api.openai.com");
    const policy = setupPolicy(svm, proto, pool);

    const stranger = generateKeypair(svm);
    airdrop(svm, stranger.publicKey);

    const ix = buildDisablePolicyIx({
      programId: PROGRAM_ID,
      poolPda: pool.poolPda,
      policyPda: policy.policyPda,
      agent: stranger.publicKey, // not policy.agent
    });
    expect(sendAndExtractCode(svm, new Transaction().add(ix), stranger)).toBe(6018);
  });

  it("rejects double-disable with 6006 PolicyInactive", () => {
    const svm = new LiteSVM();
    loadProgram(svm, { bypass: true });
    const proto = setupProtocol(svm);
    const pool = setupPool(svm, proto, "api.openai.com");
    const policy = setupPolicy(svm, proto, pool);

    const ix = buildDisablePolicyIx({
      programId: PROGRAM_ID,
      poolPda: pool.poolPda,
      policyPda: policy.policyPda,
      agent: policy.agent.publicKey,
    });
    // First disable succeeds.
    expect(
      sendAndExtractCode(svm, new Transaction().add(ix), policy.agent)
    ).toBeUndefined();
    // Second disable: PolicyInactive (6006).
    expect(sendAndExtractCode(svm, new Transaction().add(ix), policy.agent)).toBe(6006);
  });
});
