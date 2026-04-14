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
} from "@solana/spl-token";
import { expect } from "chai";
import { createHash } from "crypto";
import { getOrInitProtocol } from "../test-utils/setup";

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
      expect(String(err)).to.match(/Unauthorized/);
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
          authority: authority.publicKey,
        })
        .signers([authority])
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
          authority: authority.publicKey,
        })
        .signers([authority])
        .rpc();
      expect.fail("Should have rejected");
    } catch (err: any) {
      expect(String(err)).to.match(/RateBelowFloor/);
    }
  });
});
