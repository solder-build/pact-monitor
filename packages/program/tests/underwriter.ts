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
} from "@solana/spl-token";
import BN from "bn.js";
import { expect } from "chai";
import { getOrInitProtocol } from "../test-utils/setup";

describe("pact-insurance: underwriter deposit", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.PactInsurance as Program<PactInsurance>;

  let protocolPda: PublicKey;
  let authority: Keypair;
  let usdcMint: PublicKey;

  const hostname = "underwriter-test.example.com";
  let poolPda: PublicKey;
  let vaultPda: PublicKey;

  const underwriter: Keypair = Keypair.generate();
  let underwriterAta: PublicKey;
  let positionPda: PublicKey;

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

    // Create pool (signed by the shared authority from the helper).
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

    // Fund the underwriter with SOL so it can pay for init_if_needed.
    const airdropSig = await provider.connection.requestAirdrop(
      underwriter.publicKey,
      10 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropSig);

    // Create underwriter's USDC ATA and mint 1000 USDC to it.
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
  });

  it("allows underwriter to deposit above minimum", async () => {
    const amount = new BN(100_000_000); // 100 USDC

    await program.methods
      .deposit(amount)
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

    const pool = await program.account.coveragePool.fetch(poolPda);
    expect(pool.totalDeposited.toNumber()).to.equal(100_000_000);
    expect(pool.totalAvailable.toNumber()).to.equal(100_000_000);

    const position = await program.account.underwriterPosition.fetch(
      positionPda
    );
    expect(position.deposited.toNumber()).to.equal(100_000_000);
    expect(position.depositTimestamp.toNumber()).to.be.greaterThan(0);
    expect(position.pool.toString()).to.equal(poolPda.toString());
    expect(position.underwriter.toString()).to.equal(
      underwriter.publicKey.toString()
    );

    const vaultAccount = await getAccount(provider.connection, vaultPda);
    expect(Number(vaultAccount.amount)).to.equal(100_000_000);
  });

  it("rejects withdraw before cooldown elapsed", async () => {
    try {
      await program.methods
        .withdraw(new BN(10_000_000))
        .accounts({
          config: protocolPda,
          pool: poolPda,
          vault: vaultPda,
          position: positionPda,
          underwriterTokenAccount: underwriterAta,
          underwriter: underwriter.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([underwriter])
        .rpc();
      expect.fail("should have rejected");
    } catch (err: any) {
      expect(String(err)).to.match(/WithdrawalUnderCooldown/);
    }
  });

  it("rejects deposit below min_pool_deposit", async () => {
    try {
      await program.methods
        .deposit(new BN(500_000)) // 0.5 USDC, below 100 USDC minimum
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
      expect.fail("Should have rejected below-minimum deposit");
    } catch (err: any) {
      expect(String(err)).to.match(/BelowMinimumDeposit/);
    }
  });

  it("rejects zero-amount deposit", async () => {
    try {
      await program.methods
        .deposit(new BN(0))
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
      expect.fail("Should have rejected zero-amount deposit");
    } catch (err: any) {
      expect(String(err)).to.match(/ZeroAmount/);
    }
  });
});
