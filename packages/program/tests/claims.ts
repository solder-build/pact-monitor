import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
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
  mintTo,
  getAccount,
  approve,
} from "@solana/spl-token";
import BN from "bn.js";
import { expect } from "chai";
import { getOrInitProtocol } from "../test-utils/setup";

describe("pact-insurance: claims", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.PactInsurance as Program<PactInsurance>;

  let protocolPda: PublicKey;
  let authority: Keypair;
  let usdcMint: PublicKey;

  const hostname = "claim-test.example.com";
  let poolPda: PublicKey;
  let vaultPda: PublicKey;

  const underwriter: Keypair = Keypair.generate();
  let underwriterAta: PublicKey;
  let positionPda: PublicKey;

  const agent: Keypair = Keypair.generate();
  let agentAta: PublicKey;
  let policyPda: PublicKey;

  const callId = "call-abc-123";
  let claimPda: PublicKey;

  before(async () => {
    const handles = await getOrInitProtocol(program, provider);
    protocolPda = handles.protocolPda;
    authority = handles.authority;
    usdcMint = handles.usdcMint;

    [poolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), Buffer.from(hostname)],
      program.programId
    );
    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), poolPda.toBuffer()],
      program.programId
    );
    [positionPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("position"),
        poolPda.toBuffer(),
        underwriter.publicKey.toBuffer(),
      ],
      program.programId
    );
    [policyPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("policy"),
        poolPda.toBuffer(),
        agent.publicKey.toBuffer(),
      ],
      program.programId
    );
    [claimPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("claim"),
        policyPda.toBuffer(),
        Buffer.from(callId),
      ],
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

    // Fund underwriter with SOL.
    const udSig = await provider.connection.requestAirdrop(
      underwriter.publicKey,
      10 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(udSig);

    // Create underwriter ATA, mint USDC, and deposit 100 USDC into the pool.
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
      1_000_000_000 // 1000 USDC
    );

    await program.methods
      .deposit(new BN(100_000_000)) // 100 USDC
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

    // Fund agent with SOL.
    const agSig = await provider.connection.requestAirdrop(
      agent.publicKey,
      10 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(agSig);

    // Create agent ATA and mint 10 USDC (starting balance).
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
      10_000_000 // 10 USDC
    );

    // Agent approves pool PDA as delegate for 100 USDC of premiums.
    await approve(
      provider.connection,
      agent,
      agentAta,
      poolPda,
      agent,
      100_000_000 // 100 USDC delegated
    );

    // Enable insurance for the agent.
    const expiresAt = new BN(Math.floor(Date.now() / 1000) + 86400);
    await program.methods
      .enableInsurance({
        agentId: "agent-claim-test",
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

  it("submits a claim and transfers refund", async () => {
    const before = await getAccount(provider.connection, agentAta);
    const beforeAmount = Number(before.amount);

    const now = Math.floor(Date.now() / 1000);
    const paymentAmount = new BN(500_000); // 0.5 USDC

    await program.methods
      .submitClaim({
        callId,
        triggerType: { error: {} } as any,
        evidenceHash: Array(32).fill(0),
        callTimestamp: new BN(now - 30),
        latencyMs: 1234,
        statusCode: 500,
        paymentAmount,
      })
      .accounts({
        config: protocolPda,
        pool: poolPda,
        vault: vaultPda,
        policy: policyPda,
        claim: claimPda,
        agentTokenAccount: agentAta,
        authority: authority.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([authority])
      .rpc();

    const after = await getAccount(provider.connection, agentAta);
    const afterAmount = Number(after.amount);
    expect(afterAmount - beforeAmount).to.equal(500_000);

    const claim = await program.account.claim.fetch(claimPda);
    expect(claim.refundAmount.toNumber()).to.equal(500_000);
    expect(claim.paymentAmount.toNumber()).to.equal(500_000);
    expect(claim.policy.toString()).to.equal(policyPda.toString());
    expect(claim.pool.toString()).to.equal(poolPda.toString());
    expect(claim.agent.toString()).to.equal(agent.publicKey.toString());
    expect(claim.callId).to.equal(callId);

    const pool = await program.account.coveragePool.fetch(poolPda);
    expect(pool.totalClaimsPaid.toNumber()).to.equal(500_000);
    expect(pool.payoutsThisWindow.toNumber()).to.equal(500_000);

    const policy = await program.account.policy.fetch(policyPda);
    expect(policy.totalClaimsReceived.toNumber()).to.equal(500_000);
    expect(policy.callsCovered.toNumber()).to.equal(1);
  });

  it("rejects duplicate claim (same call_id)", async () => {
    try {
      const now = Math.floor(Date.now() / 1000);
      await program.methods
        .submitClaim({
          callId,
          triggerType: { error: {} } as any,
          evidenceHash: Array(32).fill(0),
          callTimestamp: new BN(now - 30),
          latencyMs: 1234,
          statusCode: 500,
          paymentAmount: new BN(500_000),
        })
        .accounts({
          config: protocolPda,
          pool: poolPda,
          vault: vaultPda,
          policy: policyPda,
          claim: claimPda,
          agentTokenAccount: agentAta,
          authority: authority.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([authority])
        .rpc();
      expect.fail("Should have rejected duplicate claim");
    } catch (err: any) {
      expect(String(err)).to.match(/already in use|DuplicateClaim/i);
    }
  });

  it("rejects claim outside window (old timestamp)", async () => {
    const oldCallId = "call-too-old-1";
    const [oldClaimPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("claim"),
        policyPda.toBuffer(),
        Buffer.from(oldCallId),
      ],
      program.programId
    );

    try {
      const now = Math.floor(Date.now() / 1000);
      await program.methods
        .submitClaim({
          callId: oldCallId,
          triggerType: { error: {} } as any,
          evidenceHash: Array(32).fill(0),
          callTimestamp: new BN(now - 7200), // 2 hours ago, past 1h window
          latencyMs: 1234,
          statusCode: 500,
          paymentAmount: new BN(500_000),
        })
        .accounts({
          config: protocolPda,
          pool: poolPda,
          vault: vaultPda,
          policy: policyPda,
          claim: oldClaimPda,
          agentTokenAccount: agentAta,
          authority: authority.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([authority])
        .rpc();
      expect.fail("Should have rejected stale claim");
    } catch (err: any) {
      expect(String(err)).to.match(/ClaimWindowExpired/);
    }
  });
});
