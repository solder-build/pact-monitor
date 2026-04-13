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

describe("pact-insurance: settle_premium (delegate transfer)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.PactInsurance as Program<PactInsurance>;

  let protocolPda: PublicKey;
  let authority: Keypair;
  let treasury: PublicKey;
  let usdcMint: PublicKey;

  const hostname = "settle-deleg-test.example.com";
  let poolPda: PublicKey;
  let vaultPda: PublicKey;
  let policyPda: PublicKey;
  let treasuryAta: PublicKey;

  const agent = Keypair.generate();
  let agentAta: PublicKey;

  before(async () => {
    const handles = await getOrInitProtocol(program, provider);
    protocolPda = handles.protocolPda;
    authority = handles.authority;
    treasury = handles.treasury;
    usdcMint = handles.usdcMint;

    // Treasury token account (owned by treasury pubkey, payer is local wallet)
    treasuryAta = await createAccount(
      provider.connection,
      (provider.wallet as anchor.Wallet).payer,
      usdcMint,
      treasury
    );

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

    const sig = await provider.connection.requestAirdrop(agent.publicKey, 2_000_000_000);
    await provider.connection.confirmTransaction(sig);

    agentAta = await createAccount(provider.connection, agent, usdcMint, agent.publicKey);
    await mintTo(
      provider.connection,
      (provider.wallet as anchor.Wallet).payer,
      usdcMint,
      agentAta,
      provider.wallet.publicKey,
      50_000_000 // 50 USDC
    );

    // Approve + enable_insurance in one tx
    const approveIx = createApproveInstruction(
      agentAta,
      poolPda,
      agent.publicKey,
      10_000_000
    );
    const enableIx = await program.methods
      .enableInsurance({
        agentId: "settle-agent",
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
    await provider.sendAndConfirm(new Transaction().add(approveIx).add(enableIx), [agent]);
  });

  it("settles premium by pulling from agent ATA (not from a vault balance)", async () => {
    // Read the live protocol fee — earlier test files (e.g. protocol.ts) may
    // have mutated it via update_config, so hardcoding the default is fragile.
    const config = await program.account.protocolConfig.fetch(protocolPda);
    const protocolFeeBps = config.protocolFeeBps;

    // call_value = 4 USDC, rate = 25 bps => gross = 10_000
    // protocol_fee = 10_000 * protocolFeeBps / 10_000
    // pool_premium = 10_000 - protocol_fee
    const expectedGross = 10_000;
    const expectedProtocolFee = Math.floor((expectedGross * protocolFeeBps) / 10_000);
    const expectedPoolPremium = expectedGross - expectedProtocolFee;

    const beforeAgent = await getAccount(provider.connection, agentAta);
    const beforeVault = await getAccount(provider.connection, vaultPda);
    const beforeTreasury = await getAccount(provider.connection, treasuryAta);

    await program.methods
      .settlePremium(new BN(4_000_000))
      .accounts({
        config: protocolPda,
        pool: poolPda,
        vault: vaultPda,
        policy: policyPda,
        agentTokenAccount: agentAta,
        treasuryTokenAccount: treasuryAta,
        authority: authority.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([authority])
      .rpc();

    const afterAgent = await getAccount(provider.connection, agentAta);
    const afterVault = await getAccount(provider.connection, vaultPda);
    const afterTreasury = await getAccount(provider.connection, treasuryAta);

    expect(Number(beforeAgent.amount) - Number(afterAgent.amount)).to.equal(expectedGross);
    expect(Number(afterVault.amount) - Number(beforeVault.amount)).to.equal(expectedPoolPremium);
    expect(Number(afterTreasury.amount) - Number(beforeTreasury.amount)).to.equal(expectedProtocolFee);
    expect(Number(beforeAgent.delegatedAmount) - Number(afterAgent.delegatedAmount)).to.equal(expectedGross);

    const policy = await program.account.policy.fetch(policyPda);
    expect(policy.totalPremiumsPaid.toNumber()).to.equal(expectedGross);

    const pool = await program.account.coveragePool.fetch(poolPda);
    expect(pool.totalPremiumsEarned.toNumber()).to.equal(expectedPoolPremium);
    expect(pool.totalAvailable.toNumber()).to.equal(expectedPoolPremium);
  });

  it("rejects settle_premium when authority is wrong", async () => {
    const rando = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(rando.publicKey, 1_000_000_000);
    await provider.connection.confirmTransaction(sig);

    try {
      await program.methods
        .settlePremium(new BN(1_000_000))
        .accounts({
          config: protocolPda,
          pool: poolPda,
          vault: vaultPda,
          policy: policyPda,
          agentTokenAccount: agentAta,
          treasuryTokenAccount: treasuryAta,
          authority: rando.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([rando])
        .rpc();
      expect.fail("should have rejected");
    } catch (err: any) {
      expect(String(err)).to.match(/Unauthorized|has_one/i);
    }
  });
});
