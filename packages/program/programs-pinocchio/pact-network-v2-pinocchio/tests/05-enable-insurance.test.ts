/**
 * `enable_insurance` (disc 5) — agent creates per-pool Policy with Phase 5 F1
 * referrer snapshot. Critique CRIT-1: the 35-byte referrer tail is fixed-
 * width regardless of presence.
 *
 * Covered:
 *   - happy without referrer (35-byte zero tail)
 *   - happy with referrer (full tail; share_bps + present byte)
 *   - referrer.shareBps > 3000 client-side reject (on-chain 6027)
 *   - mutual exclusion: present=1 + share=0 OR present=0 + share>0 → 6014
 *     (client API enforces both via the `referrer?: { ..., shareBps }` shape;
 *     on-chain test deferred to a raw-bytes shim)
 *   - delegation missing reject (6003 DelegationMissing)
 *   - expires_at in the past reject
 *   - duplicate policy reject (PolicyAlreadyExists 6002 or
 *     AccountAlreadyInitialized — depends on order of guards)
 */
import { describe, expect, it } from "vitest";
import { LiteSVM } from "litesvm";
import { Keypair, Transaction } from "@solana/web3.js";
import {
  PROGRAM_ID,
  buildEnableInsuranceIx,
  decodePolicy,
  getPolicyPda,
} from "@q3labs/pact-protocol-v2-client";
import {
  clearTokenDelegate,
  createTokenAccount,
  generateKeypair,
  getAccountData,
  loadProgram,
  sendAndExtractCode,
  setTokenDelegate,
} from "./helpers.js";
import { setupPolicy, setupPool, setupProtocol } from "./fixtures.js";

describe("enable_insurance — happy without referrer", () => {
  it("creates Policy with referrer_present=0 and 32 zero bytes in referrer slot", () => {
    const svm = new LiteSVM();
    loadProgram(svm, { bypass: true });
    const proto = setupProtocol(svm);
    const pool = setupPool(svm, proto, "api.openai.com");
    const policy = setupPolicy(svm, proto, pool, { agentId: "agent-alpha" });

    const decoded = decodePolicy(getAccountData(svm, policy.policyPda)!);
    expect(decoded.agentId).toBe("agent-alpha");
    expect(decoded.active).toBe(1);
    expect(decoded.referrerPresent).toBe(0);
    expect(decoded.referrer).toBeNull();
    expect(decoded.referrerShareBps).toBe(0);
  });
});

describe("enable_insurance — happy with referrer (Phase 5 F1)", () => {
  it("snapshots referrer destination + share_bps + present=1", () => {
    const svm = new LiteSVM();
    loadProgram(svm, { bypass: true });
    const proto = setupProtocol(svm);
    const pool = setupPool(svm, proto, "api.openai.com");
    const referrer = Keypair.generate().publicKey;

    const policy = setupPolicy(svm, proto, pool, {
      agentId: "agent-beta",
      referrer: { destination: referrer, shareBps: 1500 },
    });

    const decoded = decodePolicy(getAccountData(svm, policy.policyPda)!);
    expect(decoded.referrerPresent).toBe(1);
    expect(decoded.referrer).toBe(referrer.toBase58());
    expect(decoded.referrerShareBps).toBe(1500);
  });
});

describe("enable_insurance — failure modes", () => {
  it("client rejects referrer.shareBps > MAX_REFERRER_SHARE_BPS", () => {
    const svm = new LiteSVM();
    loadProgram(svm, { bypass: true });
    const proto = setupProtocol(svm);
    const pool = setupPool(svm, proto, "api.openai.com");
    const agent = generateKeypair(svm);
    const ta = createTokenAccount(svm, proto.mint, agent.publicKey);
    const [policyPda] = getPolicyPda(PROGRAM_ID, pool.poolPda, agent.publicKey);

    expect(() =>
      buildEnableInsuranceIx({
        programId: PROGRAM_ID,
        configPda: proto.configPda,
        poolPda: pool.poolPda,
        policyPda,
        agentTokenAccount: ta,
        agent: agent.publicKey,
        agentId: "x",
        expiresAt: 9_999_999_999n,
        referrer: { destination: Keypair.generate().publicKey, shareBps: 3001 },
      })
    ).toThrow(/out of range/);
  });

  it("rejects with 6003 DelegationMissing when the agent ATA has no delegate", () => {
    const svm = new LiteSVM();
    loadProgram(svm, { bypass: true });
    const proto = setupProtocol(svm);
    const pool = setupPool(svm, proto, "api.openai.com");
    const agent = generateKeypair(svm);
    const ta = createTokenAccount(svm, proto.mint, agent.publicKey, 100_000_000n);
    // Intentionally do NOT set the delegate.
    clearTokenDelegate(svm, ta);

    const [policyPda] = getPolicyPda(PROGRAM_ID, pool.poolPda, agent.publicKey);
    const now = svm.getClock().unixTimestamp;
    const ix = buildEnableInsuranceIx({
      programId: PROGRAM_ID,
      configPda: proto.configPda,
      poolPda: pool.poolPda,
      policyPda,
      agentTokenAccount: ta,
      agent: agent.publicKey,
      agentId: "agent-no-delegate",
      expiresAt: now + 86_400n,
    });
    expect(sendAndExtractCode(svm, new Transaction().add(ix), agent)).toBe(6003);
  });

  it("rejects expires_at in the past", () => {
    const svm = new LiteSVM();
    loadProgram(svm, { bypass: true });
    const proto = setupProtocol(svm);
    const pool = setupPool(svm, proto, "api.openai.com");
    const agent = generateKeypair(svm);
    const ta = createTokenAccount(svm, proto.mint, agent.publicKey, 100_000_000n);
    setTokenDelegate(svm, ta, pool.poolPda, 100_000_000n);

    const [policyPda] = getPolicyPda(PROGRAM_ID, pool.poolPda, agent.publicKey);
    const now = svm.getClock().unixTimestamp;
    const ix = buildEnableInsuranceIx({
      programId: PROGRAM_ID,
      configPda: proto.configPda,
      poolPda: pool.poolPda,
      policyPda,
      agentTokenAccount: ta,
      agent: agent.publicKey,
      agentId: "agent-expired",
      expiresAt: now - 1n, // past
    });
    // Past expires_at: handler rejects. Exact code is implementation-
    // defined (likely a custom 6029 or a generic ProgramError). Assert
    // failure occurred.
    const code = sendAndExtractCode(svm, new Transaction().add(ix), agent);
    expect(code === undefined ? "ok" : "fail").toBe("fail");
  });

  it("rejects a duplicate policy for the same (pool, agent)", () => {
    const svm = new LiteSVM();
    loadProgram(svm, { bypass: true });
    const proto = setupProtocol(svm);
    const pool = setupPool(svm, proto, "api.openai.com");
    const policy = setupPolicy(svm, proto, pool, { agentId: "agent-dup" });

    // Build a second enable_insurance ix targeting the same PDAs.
    const now = svm.getClock().unixTimestamp;
    const ix = buildEnableInsuranceIx({
      programId: PROGRAM_ID,
      configPda: proto.configPda,
      poolPda: pool.poolPda,
      policyPda: policy.policyPda,
      agentTokenAccount: policy.agentTokenAccount,
      agent: policy.agent.publicKey,
      agentId: "agent-dup-2",
      expiresAt: now + 86_400n,
    });
    const code = sendAndExtractCode(svm, new Transaction().add(ix), policy.agent);
    // AccountAlreadyInitialized OR 6002 PolicyAlreadyExists — both are
    // valid duplicate-rejection paths. Either is a "non-undefined" outcome.
    expect(code).not.toBeUndefined();
  });
});
