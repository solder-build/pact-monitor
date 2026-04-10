import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { PactInsurance } from "../target/types/pact_insurance";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";

describe("pact-insurance: protocol", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.PactInsurance as Program<PactInsurance>;

  const authority = Keypair.generate().publicKey;
  const treasury = Keypair.generate().publicKey;
  const usdcMint = Keypair.generate().publicKey;

  let protocolPda: PublicKey;

  before(() => {
    [protocolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("protocol")],
      program.programId
    );
  });

  it("initializes the protocol config with a separate authority", async () => {
    await program.methods
      .initializeProtocol({
        authority,
        treasury,
        usdcMint,
      })
      .accounts({
        config: protocolPda,
        deployer: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const config = await program.account.protocolConfig.fetch(protocolPda);
    expect(config.authority.toString()).to.equal(authority.toString());
    expect(config.authority.toString()).to.not.equal(provider.wallet.publicKey.toString());
    expect(config.treasury.toString()).to.equal(treasury.toString());
    expect(config.usdcMint.toString()).to.equal(usdcMint.toString());
    expect(config.protocolFeeBps).to.equal(1500);
    expect(config.minPoolDeposit.toNumber()).to.equal(100_000_000);
    expect(config.withdrawalCooldownSeconds.toNumber()).to.equal(604_800);
    expect(config.aggregateCapBps).to.equal(3000);
    expect(config.aggregateCapWindowSeconds.toNumber()).to.equal(86_400);
    expect(config.paused).to.equal(false);
  });

  it("rejects second initialization (PDA already exists)", async () => {
    try {
      await program.methods
        .initializeProtocol({
          authority,
          treasury,
          usdcMint,
        })
        .accounts({
          config: protocolPda,
          deployer: provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(String(err)).to.match(/already in use|already initialized/i);
    }
  });
});
