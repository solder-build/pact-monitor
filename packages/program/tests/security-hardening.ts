import * as anchor from "@anchor-lang/core";
import { Program, BN } from "@anchor-lang/core";
import { PactInsurance } from "../target/types/pact_insurance";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccount,
  createAccount,
  mintTo,
  approve,
  getAccount,
} from "@solana/spl-token";
import { expect } from "chai";
import { createHash } from "crypto";
import { getOrInitProtocol } from "../test-utils/setup";

function deriveClaimPda(programId: PublicKey, policyKey: PublicKey, callId: string): PublicKey {
  const hashed = createHash("sha256").update(callId).digest();
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("claim"), policyKey.toBuffer(), hashed],
    programId,
  );
  return pda;
}

describe("pact-insurance: security hardening", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.PactInsurance as Program<PactInsurance>;

  let authority: Keypair;
  let oracle: Keypair;
  let protocolPda: PublicKey;
  let usdcMint: PublicKey;

  // Self-contained pool/policy/agent setup — keeps the C-02 wrong-oracle test
  // independent of any other test file's state. Hostname is unique to avoid
  // collision with claims.ts/pool.ts.
  const hostname = "security-test.example";
  let poolPda: PublicKey;
  let vaultPda: PublicKey;

  const underwriter: Keypair = Keypair.generate();
  let underwriterAta: PublicKey;
  let positionPda: PublicKey;

  const agent: Keypair = Keypair.generate();
  let agentAta: PublicKey;
  let policyPda: PublicKey;

  const wrongOracleCallId = "wrong-oracle-test";
  let wrongOracleClaimPda: PublicKey;

  before(async () => {
    const h = await getOrInitProtocol(program, provider);
    authority = h.authority;
    oracle = h.oracle;
    protocolPda = h.protocolPda;
    usdcMint = h.usdcMint;

    [poolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), Buffer.from(hostname)],
      program.programId
    );
    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), poolPda.toBuffer()],
      program.programId
    );
    [positionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("position"), poolPda.toBuffer(), underwriter.publicKey.toBuffer()],
      program.programId
    );
    [policyPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("policy"), poolPda.toBuffer(), agent.publicKey.toBuffer()],
      program.programId
    );
    [wrongOracleClaimPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("claim"), policyPda.toBuffer(), createHash("sha256").update(wrongOracleCallId).digest()],
      program.programId
    );

    // Create pool.
    await program.methods
      .createPool({
        providerHostname: hostname,
        insuranceRateBps: null,
        maxCoveragePerCall: null,
      })
      .accounts({
        config: protocolPda,
        pool: poolPda,
        vault: vaultPda,
        usdcMint,
        authority: authority.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([authority])
      .rpc();

    // Fund underwriter, mint USDC, deposit so the pool has funds available.
    const udSig = await provider.connection.requestAirdrop(
      underwriter.publicKey,
      10 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(udSig);

    const payer = (provider.wallet as anchor.Wallet).payer;
    underwriterAta = await createAssociatedTokenAccount(
      provider.connection,
      payer,
      usdcMint,
      underwriter.publicKey
    );
    await mintTo(
      provider.connection,
      payer,
      usdcMint,
      underwriterAta,
      provider.wallet.publicKey,
      1_000_000_000
    );

    await program.methods
      .deposit(new BN(100_000_000))
      .accounts({
        config: protocolPda,
        pool: poolPda,
        vault: vaultPda,
        position: positionPda,
        underwriterTokenAccount: underwriterAta,
        underwriter: underwriter.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([underwriter])
      .rpc();

    // Fund agent, create ATA, mint USDC, approve pool delegate, enable insurance.
    const agSig = await provider.connection.requestAirdrop(
      agent.publicKey,
      10 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(agSig);

    agentAta = await createAssociatedTokenAccount(
      provider.connection,
      payer,
      usdcMint,
      agent.publicKey
    );
    await mintTo(
      provider.connection,
      payer,
      usdcMint,
      agentAta,
      provider.wallet.publicKey,
      10_000_000
    );

    await approve(
      provider.connection,
      agent,
      agentAta,
      poolPda,
      agent,
      100_000_000
    );

    const expiresAt = new BN(Math.floor(Date.now() / 1000) + 86400);
    await program.methods
      .enableInsurance({
        agentId: "agent-security-test",
        expiresAt,
      })
      .accounts({
        config: protocolPda,
        pool: poolPda,
        policy: policyPda,
        agentTokenAccount: agentAta,
        agent: agent.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([agent])
      .rpc();
  });

  it("C-02: submit_claim rejects signer that is not config.oracle", async () => {
    const impostor = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(impostor.publicKey, 2_000_000_000);
    await provider.connection.confirmTransaction(sig);

    // Every account is valid except the oracle signer — only the
    // UnauthorizedOracle constraint should fire. A narrow regex ensures this
    // test breaks loudly if the oracle constraint is ever removed.
    try {
      await program.methods
        .submitClaim({
          callId: wrongOracleCallId,
          triggerType: { error: {} },
          evidenceHash: Array(32).fill(0),
          callTimestamp: new BN(Math.floor(Date.now() / 1000)),
          latencyMs: 100,
          statusCode: 500,
          paymentAmount: new BN(1000),
        })
        .accounts({
          config: protocolPda,
          pool: poolPda,
          vault: vaultPda,
          policy: policyPda,
          claim: wrongOracleClaimPda,
          agentTokenAccount: agentAta,
          oracle: impostor.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([impostor])
        .rpc();
      expect.fail("Should have rejected");
    } catch (err: any) {
      expect(String(err)).to.match(/UnauthorizedOracle/);
    }
  });

  it("C-02: update_oracle rotates the oracle pubkey", async () => {
    const newOracle = Keypair.generate();
    await program.methods
      .updateOracle(newOracle.publicKey)
      .accounts({ config: protocolPda, authority: authority.publicKey })
      .signers([authority])
      .rpc();
    const config = await program.account.protocolConfig.fetch(protocolPda);
    expect(config.oracle.toString()).to.equal(newOracle.publicKey.toString());

    // Restore original oracle so downstream tests still have a working signer.
    await program.methods
      .updateOracle(oracle.publicKey)
      .accounts({ config: protocolPda, authority: authority.publicKey })
      .signers([authority])
      .rpc();
  });

  it("C-02: update_oracle rejects non-authority signer", async () => {
    const rando = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(rando.publicKey, 1_000_000_000);
    await provider.connection.confirmTransaction(sig);
    try {
      await program.methods
        .updateOracle(rando.publicKey)
        .accounts({ config: protocolPda, authority: rando.publicKey })
        .signers([rando])
        .rpc();
      expect.fail("Should have rejected");
    } catch (err: any) {
      // Negative lookahead so this doesn't accidentally match
      // UnauthorizedOracle or UnauthorizedDeployer — we specifically want the
      // generic `has_one = authority` rejection (PactError::Unauthorized).
      expect(String(err)).to.match(/Unauthorized(?!Oracle|Deployer)/);
    }
  });

  it("C-02: update_oracle rejects zero pubkey as new oracle", async () => {
    try {
      await program.methods
        .updateOracle(PublicKey.default)
        .accounts({ config: protocolPda, authority: authority.publicKey })
        .signers([authority])
        .rpc();
      expect.fail("Should have rejected");
    } catch (err: any) {
      expect(String(err)).to.match(/InvalidOracleKey/);
    }
  });

  it("C-02: update_oracle rejects new oracle equal to authority (undoes split)", async () => {
    try {
      await program.methods
        .updateOracle(authority.publicKey)
        .accounts({ config: protocolPda, authority: authority.publicKey })
        .signers([authority])
        .rpc();
      expect.fail("Should have rejected");
    } catch (err: any) {
      expect(String(err)).to.match(/InvalidOracleKey/);
    }
  });

  it("C-02: submit_claim rejects authority keypair as oracle signer", async () => {
    // Covers the review gap: existing test only rejects an impostor.
    // The authority keypair passing as oracle must ALSO fail, otherwise
    // the oracle/authority split is nominal rather than enforced.
    const callId = "c02-authority-cannot-submit";
    const claimPda = deriveClaimPda(program.programId, policyPda, callId);
    try {
      await program.methods
        .submitClaim({
          callId,
          triggerType: { error: {} },
          evidenceHash: Array(32).fill(0),
          callTimestamp: new BN(Math.floor(Date.now() / 1000)),
          latencyMs: 100,
          statusCode: 500,
          paymentAmount: new BN(1000),
        })
        .accounts({
          config: protocolPda,
          pool: poolPda,
          vault: vaultPda,
          policy: policyPda,
          claim: claimPda,
          agentTokenAccount: agentAta,
          oracle: authority.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([authority])
        .rpc();
      expect.fail("Should have rejected");
    } catch (err: any) {
      expect(String(err)).to.match(/UnauthorizedOracle/);
    }
  });

  function deriveH02ClaimPda(policyKey: PublicKey, callId: string): PublicKey {
    const hashed = createHash("sha256").update(callId).digest();
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("claim"), policyKey.toBuffer(), hashed],
      program.programId,
    );
    return pda;
  }

  it("H-02: submit_claim succeeds with 36-char UUID-with-hyphens call_id", async () => {
    const callId = "11111111-2222-3333-4444-555555555555"; // 36 chars > 32-byte raw seed limit
    const claimPda = deriveH02ClaimPda(policyPda, callId);

    const sig = await program.methods
      .submitClaim({
        callId,
        triggerType: { error: {} },
        evidenceHash: Array(32).fill(0),
        callTimestamp: new BN(Math.floor(Date.now() / 1000)),
        latencyMs: 100,
        statusCode: 500,
        paymentAmount: new BN(1000),
      })
      .accounts({
        config: protocolPda,
        pool: poolPda,
        vault: vaultPda,
        policy: policyPda,
        claim: claimPda,
        agentTokenAccount: agentAta,
        oracle: oracle.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([oracle])
      .rpc();
    expect(sig).to.be.a("string");

    // Verify the claim was stored with the FULL call_id (not hyphen-stripped)
    const claim = await program.account.claim.fetch(claimPda);
    expect(claim.callId).to.equal(callId);
  });

  it("H-02: submit_claim succeeds with 64-char call_id (MAX_CALL_ID_LEN)", async () => {
    const callId = "a".repeat(64); // exactly at the cap
    const claimPda = deriveH02ClaimPda(policyPda, callId);

    const sig = await program.methods
      .submitClaim({
        callId,
        triggerType: { error: {} },
        evidenceHash: Array(32).fill(0),
        callTimestamp: new BN(Math.floor(Date.now() / 1000)),
        latencyMs: 100,
        statusCode: 500,
        paymentAmount: new BN(1000),
      })
      .accounts({
        config: protocolPda,
        pool: poolPda,
        vault: vaultPda,
        policy: policyPda,
        claim: claimPda,
        agentTokenAccount: agentAta,
        oracle: oracle.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([oracle])
      .rpc();
    expect(sig).to.be.a("string");

    const claim = await program.account.claim.fetch(claimPda);
    expect(claim.callId).to.equal(callId);
  });

  it("C-03: submit_claim rejects agent_token_account that is not policy.agent_token_account", async () => {
    // Create a second token account for the SAME agent on the SAME mint but at
    // a different address. mint + owner constraints will pass; the new
    // key-equality constraint must reject it with TokenAccountMismatch.
    const wrongAta = await createAccount(
      provider.connection,
      (provider.wallet as anchor.Wallet).payer,
      usdcMint,
      agent.publicKey,
      Keypair.generate(),
    );

    const callId = "c03-wrong-ata";
    const [c03ClaimPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("claim"), policyPda.toBuffer(), createHash("sha256").update(callId).digest()],
      program.programId,
    );

    try {
      await program.methods
        .submitClaim({
          callId,
          triggerType: { error: {} },
          evidenceHash: Array(32).fill(0),
          callTimestamp: new BN(Math.floor(Date.now() / 1000)),
          latencyMs: 100,
          statusCode: 500,
          paymentAmount: new BN(1000),
        })
        .accounts({
          config: protocolPda,
          pool: poolPda,
          vault: vaultPda,
          policy: policyPda,
          claim: c03ClaimPda,
          agentTokenAccount: wrongAta,
          oracle: oracle.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([oracle])
        .rpc();
      expect.fail("Should have rejected");
    } catch (err: any) {
      expect(String(err)).to.match(/TokenAccountMismatch/);
    }
  });

  it("H-03: update_config rejects treasury mutation", async () => {
    try {
      await program.methods
        .updateConfig({
          protocolFeeBps: null,
          minPoolDeposit: null,
          defaultInsuranceRateBps: null,
          defaultMaxCoveragePerCall: null,
          minPremiumBps: null,
          withdrawalCooldownSeconds: null,
          aggregateCapBps: null,
          aggregateCapWindowSeconds: null,
          claimWindowSeconds: null,
          maxClaimsPerBatch: null,
          paused: null,
          treasury: Keypair.generate().publicKey,
          usdcMint: null,
        })
        .accounts({ config: protocolPda, authority: authority.publicKey })
        .signers([authority])
        .rpc();
      expect.fail("Should have rejected");
    } catch (err: any) {
      expect(String(err)).to.match(/FrozenConfigField/);
    }
  });

  it("H-03: update_config rejects usdc_mint mutation", async () => {
    try {
      await program.methods
        .updateConfig({
          protocolFeeBps: null,
          minPoolDeposit: null,
          defaultInsuranceRateBps: null,
          defaultMaxCoveragePerCall: null,
          minPremiumBps: null,
          withdrawalCooldownSeconds: null,
          aggregateCapBps: null,
          aggregateCapWindowSeconds: null,
          claimWindowSeconds: null,
          maxClaimsPerBatch: null,
          paused: null,
          treasury: null,
          usdcMint: Keypair.generate().publicKey,
        })
        .accounts({ config: protocolPda, authority: authority.publicKey })
        .signers([authority])
        .rpc();
      expect.fail("Should have rejected");
    } catch (err: any) {
      expect(String(err)).to.match(/FrozenConfigField/);
    }
  });

  it("H-04: update_rates rejects rate > 10_000 bps", async () => {
    try {
      await program.methods
        .updateRates(10_001)
        .accounts({
          config: protocolPda,
          pool: poolPda,
          oracle: oracle.publicKey,
        })
        .signers([oracle])
        .rpc();
      expect.fail("Should have rejected");
    } catch (err: any) {
      expect(String(err)).to.match(/RateOutOfBounds/);
    }
  });

  it("H-04: update_rates rejects rate below pool.min_premium_bps", async () => {
    // Fetch the current pool state to know what its min_premium_bps is.
    const pool = await program.account.coveragePool.fetch(poolPda);
    const minPremium = pool.minPremiumBps;
    if (minPremium === 0) {
      // If min_premium_bps is 0, no value is below it. Skip with a note.
      // The security-hardening pool inherits the protocol default which should
      // be > 0 (DEFAULT_MIN_PREMIUM_BPS = 5), so this branch is defensive.
      return;
    }
    const belowFloor = minPremium - 1;
    try {
      await program.methods
        .updateRates(belowFloor)
        .accounts({
          config: protocolPda,
          pool: poolPda,
          oracle: oracle.publicKey,
        })
        .signers([oracle])
        .rpc();
      expect.fail("Should have rejected");
    } catch (err: any) {
      expect(String(err)).to.match(/RateBelowFloor/);
    }
  });

  // ─── H-05: policy expiry + disable_policy ────────────────────────────────

  // Agents created for H-05 tests. Declared at describe scope so they are
  // accessible across all four it() blocks.
  const disableAgent: Keypair = Keypair.generate();
  let disableAgentAta: PublicKey;
  let disablePolicyPda: PublicKey;

  const expiredAgent: Keypair = Keypair.generate();
  let expiredAgentAta: PublicKey;
  let expiredPolicyPda: PublicKey;
  let h05TreasuryAta: PublicKey;

  before(async () => {
    const payer = (provider.wallet as anchor.Wallet).payer;

    // ── disableAgent: fresh policy, expires far in the future ──────────────
    const daSig = await provider.connection.requestAirdrop(
      disableAgent.publicKey,
      5 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(daSig);

    disableAgentAta = await createAssociatedTokenAccount(
      provider.connection,
      payer,
      usdcMint,
      disableAgent.publicKey
    );
    await mintTo(
      provider.connection,
      payer,
      usdcMint,
      disableAgentAta,
      provider.wallet.publicKey,
      10_000_000
    );
    await approve(
      provider.connection,
      disableAgent,
      disableAgentAta,
      poolPda,
      disableAgent,
      100_000_000
    );

    [disablePolicyPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("policy"), poolPda.toBuffer(), disableAgent.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .enableInsurance({
        agentId: "disable-test-agent",
        expiresAt: new BN(Math.floor(Date.now() / 1000) + 86400),
      })
      .accounts({
        config: protocolPda,
        pool: poolPda,
        policy: disablePolicyPda,
        agentTokenAccount: disableAgentAta,
        agent: disableAgent.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([disableAgent])
      .rpc();

    // ── expiredAgent: policy that will expire ~2 seconds after creation ─────
    const eaSig = await provider.connection.requestAirdrop(
      expiredAgent.publicKey,
      5 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(eaSig);

    expiredAgentAta = await createAssociatedTokenAccount(
      provider.connection,
      payer,
      usdcMint,
      expiredAgent.publicKey
    );
    await mintTo(
      provider.connection,
      payer,
      usdcMint,
      expiredAgentAta,
      provider.wallet.publicKey,
      10_000_000
    );
    await approve(
      provider.connection,
      expiredAgent,
      expiredAgentAta,
      poolPda,
      expiredAgent,
      100_000_000
    );

    [expiredPolicyPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("policy"), poolPda.toBuffer(), expiredAgent.publicKey.toBuffer()],
      program.programId
    );

    // expires_at = now + 2 seconds; we sleep 3s before testing it
    const shortExpiresAt = new BN(Math.floor(Date.now() / 1000) + 2);
    await program.methods
      .enableInsurance({
        agentId: "expired-test-agent",
        expiresAt: shortExpiresAt,
      })
      .accounts({
        config: protocolPda,
        pool: poolPda,
        policy: expiredPolicyPda,
        agentTokenAccount: expiredAgentAta,
        agent: expiredAgent.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([expiredAgent])
      .rpc();

    // Treasury token account for settle_premium expired test.
    // Use an explicit keypair so we don't collide with settlement.ts which
    // also creates a treasury ATA using the same (usdcMint, treasury) pair.
    const { treasury } = await getOrInitProtocol(program, provider);
    h05TreasuryAta = await createAccount(
      provider.connection,
      payer,
      usdcMint,
      treasury,
      Keypair.generate()
    );

    // Wait for the expiredAgent's policy to expire
    await new Promise((r) => setTimeout(r, 2500));
  });

  it("H-05: disable_policy sets active=false and decrements pool.active_policies", async () => {
    const poolBefore = await program.account.coveragePool.fetch(poolPda);

    await program.methods
      .disablePolicy()
      .accounts({
        pool: poolPda,
        policy: disablePolicyPda,
        agent: disableAgent.publicKey,
      })
      .signers([disableAgent])
      .rpc();

    const poolAfter = await program.account.coveragePool.fetch(poolPda);
    const policyAfter = await program.account.policy.fetch(disablePolicyPda);

    expect(policyAfter.active).to.equal(false);
    expect(poolAfter.activePolicies).to.equal(poolBefore.activePolicies - 1);
  });

  it("H-05: submit_claim against a disabled policy rejects with PolicyInactive", async () => {
    const callId = "h05-disabled-claim";
    const claimPda = deriveClaimPda(program.programId, disablePolicyPda, callId);

    try {
      await program.methods
        .submitClaim({
          callId,
          triggerType: { error: {} },
          evidenceHash: Array(32).fill(0),
          callTimestamp: new BN(Math.floor(Date.now() / 1000)),
          latencyMs: 100,
          statusCode: 500,
          paymentAmount: new BN(1000),
        })
        .accounts({
          config: protocolPda,
          pool: poolPda,
          vault: vaultPda,
          policy: disablePolicyPda,
          claim: claimPda,
          agentTokenAccount: disableAgentAta,
          oracle: oracle.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([oracle])
        .rpc();
      expect.fail("Should have rejected");
    } catch (err: any) {
      expect(String(err)).to.match(/PolicyInactive/);
    }
  });

  it("H-05: submit_claim against an expired policy rejects with PolicyExpired", async () => {
    const callId = "h05-expired-claim";
    const claimPda = deriveClaimPda(program.programId, expiredPolicyPda, callId);

    try {
      await program.methods
        .submitClaim({
          callId,
          triggerType: { error: {} },
          evidenceHash: Array(32).fill(0),
          callTimestamp: new BN(Math.floor(Date.now() / 1000)),
          latencyMs: 100,
          statusCode: 500,
          paymentAmount: new BN(1000),
        })
        .accounts({
          config: protocolPda,
          pool: poolPda,
          vault: vaultPda,
          policy: expiredPolicyPda,
          claim: claimPda,
          agentTokenAccount: expiredAgentAta,
          oracle: oracle.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([oracle])
        .rpc();
      expect.fail("Should have rejected");
    } catch (err: any) {
      expect(String(err)).to.match(/PolicyExpired/);
    }
  });

  it("H-05: settle_premium against an expired policy rejects with PolicyExpired", async () => {
    try {
      await program.methods
        .settlePremium(new BN(1000))
        .accounts({
          config: protocolPda,
          pool: poolPda,
          vault: vaultPda,
          policy: expiredPolicyPda,
          agentTokenAccount: expiredAgentAta,
          treasuryTokenAccount: h05TreasuryAta,
          oracle: oracle.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([oracle])
        .rpc();
      expect.fail("Should have rejected");
    } catch (err: any) {
      expect(String(err)).to.match(/PolicyExpired/);
    }
  });

  it("H-05 + premium-evasion fix: settle_premium STILL collects on disabled policy", async () => {
    // Regression for the premium-evasion vector called out in PR #20 review:
    // an agent could `disable_policy` in the same window they racked up
    // billable calls, then the crank's `settle_premium` would revert with
    // `PolicyInactive` and the protocol would eat the cost. Fix (option b):
    // settle_premium only enforces `expires_at`, not `active`. Revocation
    // still blocks NEW claims via submit_claim.
    //
    // disablePolicyPda was deactivated in the earlier disable_policy test but
    // its expires_at is still ~1 day in the future, so settlement should
    // succeed and the premium should actually move tokens.
    //
    // Math: call_value * pool.insurance_rate_bps / 10_000
    const pool = await program.account.coveragePool.fetch(poolPda);
    const rateBps = pool.insuranceRateBps;
    const callValue = 1_000_000;
    const expectedGross = Math.floor((callValue * rateBps) / 10_000);
    expect(expectedGross).to.be.greaterThan(0);

    const beforeAgent = await getAccount(provider.connection, disableAgentAta);

    await program.methods
      .settlePremium(new BN(callValue))
      .accounts({
        config: protocolPda,
        pool: poolPda,
        vault: vaultPda,
        policy: disablePolicyPda,
        agentTokenAccount: disableAgentAta,
        treasuryTokenAccount: h05TreasuryAta,
        oracle: oracle.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([oracle])
      .rpc();

    const afterAgent = await getAccount(provider.connection, disableAgentAta);
    const spent = Number(beforeAgent.amount) - Number(afterAgent.amount);
    expect(spent).to.equal(expectedGross);

    // Sanity: policy is still marked inactive — settle_premium did NOT flip it.
    const policyAfter = await program.account.policy.fetch(disablePolicyPda);
    expect(policyAfter.active).to.equal(false);
  });

  it("H-05: enable_insurance rejects expires_at in the past", async () => {
    const pastAgent = Keypair.generate();
    const payer = (provider.wallet as anchor.Wallet).payer;

    const sig = await provider.connection.requestAirdrop(
      pastAgent.publicKey,
      5 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig);

    const pastAgentAta = await createAssociatedTokenAccount(
      provider.connection,
      payer,
      usdcMint,
      pastAgent.publicKey
    );
    await mintTo(
      provider.connection,
      payer,
      usdcMint,
      pastAgentAta,
      provider.wallet.publicKey,
      10_000_000
    );
    await approve(
      provider.connection,
      pastAgent,
      pastAgentAta,
      poolPda,
      pastAgent,
      100_000_000
    );

    const [pastPolicyPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("policy"), poolPda.toBuffer(), pastAgent.publicKey.toBuffer()],
      program.programId
    );

    try {
      await program.methods
        .enableInsurance({
          agentId: "past-test-agent",
          expiresAt: new BN(0), // permanently expired (Unix epoch)
        })
        .accounts({
          config: protocolPda,
          pool: poolPda,
          policy: pastPolicyPda,
          agentTokenAccount: pastAgentAta,
          agent: pastAgent.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([pastAgent])
        .rpc();
      expect.fail("Should have rejected");
    } catch (err: any) {
      expect(String(err)).to.match(/PolicyExpired/);
    }
  });
});
