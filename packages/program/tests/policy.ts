import * as anchor from "@anchor-lang/core";
import { Program, BN } from "@anchor-lang/core";
import { PactInsurance } from "../target/types/pact_insurance";
import { PublicKey, Keypair, SystemProgram, Transaction, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAccount,
  mintTo,
  createApproveInstruction,
  getAccount,
} from "@solana/spl-token";
import { expect } from "chai";
import { getOrInitProtocol } from "../test-utils/setup";

describe("pact-insurance: enable_insurance (delegation)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.PactInsurance as Program<PactInsurance>;

  let protocolPda: PublicKey;
  let authority: Keypair;
  let usdcMint: PublicKey;

  const hostname = "policy-deleg-test.example.com";
  let poolPda: PublicKey;
  let vaultPda: PublicKey;
  let policyPda: PublicKey;

  const agent = Keypair.generate();
  let agentAta: PublicKey;

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
    [policyPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("policy"), poolPda.toBuffer(), agent.publicKey.toBuffer()],
      program.programId
    );

    // Authority creates the pool
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

    // Fund agent with SOL + create ATA + mint USDC
    const sig = await provider.connection.requestAirdrop(agent.publicKey, 2_000_000_000);
    await provider.connection.confirmTransaction(sig);

    agentAta = await createAccount(
      provider.connection,
      agent,
      usdcMint,
      agent.publicKey
    );
    await mintTo(
      provider.connection,
      (provider.wallet as anchor.Wallet).payer,
      usdcMint,
      agentAta,
      provider.wallet.publicKey,
      50_000_000 // 50 USDC
    );
  });

  it("rejects enable_insurance without prior SPL approve", async () => {
    try {
      await program.methods
        .enableInsurance({
          agentId: "agent-no-approve",
          expiresAt: new BN(0),
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
      expect.fail("should have rejected without delegation");
    } catch (err: any) {
      expect(String(err)).to.match(/DelegationMissing/);
    }
  });

  it("enables insurance after SPL approve to pool PDA", async () => {
    const approveIx = createApproveInstruction(
      agentAta,
      poolPda,
      agent.publicKey,
      10_000_000 // 10 USDC delegated
    );

    const enableIx = await program.methods
      .enableInsurance({
        agentId: "agent-with-approve",
        expiresAt: new BN(0),
      })
      .accounts({
        config: protocolPda,
        pool: poolPda,
        policy: policyPda,
        agentTokenAccount: agentAta,
        agent: agent.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx = new Transaction().add(approveIx).add(enableIx);
    await provider.sendAndConfirm(tx, [agent]);

    const policy = await program.account.policy.fetch(policyPda);
    expect(policy.agent.toString()).to.equal(agent.publicKey.toString());
    expect(policy.agentId).to.equal("agent-with-approve");
    expect(policy.agentTokenAccount.toString()).to.equal(agentAta.toString());
    expect(policy.active).to.equal(true);
    expect(policy.totalPremiumsPaid.toNumber()).to.equal(0);

    // Agent's USDC balance unchanged (delegation, not transfer)
    const agentAcc = await getAccount(provider.connection, agentAta);
    expect(Number(agentAcc.amount)).to.equal(50_000_000);
    expect(agentAcc.delegate?.toString()).to.equal(poolPda.toString());
    expect(Number(agentAcc.delegatedAmount)).to.equal(10_000_000);
  });
});
