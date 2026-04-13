import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { PactInsurance } from "../target/types/pact_insurance";
import { PublicKey, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { expect } from "chai";
import { getOrInitProtocol } from "../test-utils/setup";

describe("pact-insurance: pool", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.PactInsurance as Program<PactInsurance>;

  let protocolPda: PublicKey;
  let authority: Keypair;
  let usdcMint: PublicKey;

  const hostname = "api.helius.xyz";
  let poolPda: PublicKey;
  let vaultPda: PublicKey;

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
  });

  it("creates a pool for a provider hostname", async () => {
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

    const pool = await program.account.coveragePool.fetch(poolPda);
    expect(pool.providerHostname).to.equal(hostname);
    expect(pool.insuranceRateBps).to.equal(25);
    expect(pool.maxCoveragePerCall.toNumber()).to.equal(1_000_000);
    expect(pool.totalDeposited.toNumber()).to.equal(0);
    expect(pool.totalAvailable.toNumber()).to.equal(0);
    expect(pool.totalPremiumsEarned.toNumber()).to.equal(0);
    expect(pool.totalClaimsPaid.toNumber()).to.equal(0);
    expect(pool.payoutsThisWindow.toNumber()).to.equal(0);
    expect(pool.activePolicies).to.equal(0);
    expect(pool.authority.toString()).to.equal(authority.publicKey.toString());
    expect(pool.usdcMint.toString()).to.equal(usdcMint.toString());
    expect(pool.vault.toString()).to.equal(vaultPda.toString());
  });

  it("updates pool insurance_rate_bps via update_rates", async () => {
    await program.methods
      .updateRates(50)
      .accounts({
        config: protocolPda,
        pool: poolPda,
        authority: authority.publicKey,
      })
      .signers([authority])
      .rpc();

    const pool = await program.account.coveragePool.fetch(poolPda);
    expect(pool.insuranceRateBps).to.equal(50);
  });

  it("rejects update_rates from non-authority", async () => {
    const rando = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(rando.publicKey, 1_000_000_000);
    await provider.connection.confirmTransaction(sig);

    try {
      await program.methods
        .updateRates(75)
        .accounts({
          config: protocolPda,
          pool: poolPda,
          authority: rando.publicKey,
        })
        .signers([rando])
        .rpc();
      expect.fail("should have rejected");
    } catch (err: any) {
      expect(String(err)).to.match(/Unauthorized|ConstraintHasOne|has_one/i);
    }
  });

  it("rejects duplicate pool creation", async () => {
    try {
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
      expect.fail("Should have rejected duplicate pool creation");
    } catch (err: any) {
      expect(String(err)).to.match(/already in use|PoolAlreadyExists/i);
    }
  });
});
