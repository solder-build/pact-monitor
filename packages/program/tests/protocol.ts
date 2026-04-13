import * as anchor from "@anchor-lang/core";
import { Program, BN } from "@anchor-lang/core";
import { PactInsurance } from "../target/types/pact_insurance";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";
import { getOrInitProtocol } from "../test-utils/setup";

describe("pact-insurance: protocol", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.PactInsurance as Program<PactInsurance>;

  let protocolPda: PublicKey;
  let authority: Keypair;
  let treasury: PublicKey;
  let usdcMint: PublicKey;

  before(async () => {
    const handles = await getOrInitProtocol(program, provider);
    protocolPda = handles.protocolPda;
    authority = handles.authority;
    treasury = handles.treasury;
    usdcMint = handles.usdcMint;
  });

  it("initializes the protocol config with a separate authority", async () => {
    const config = await program.account.protocolConfig.fetch(protocolPda);
    expect(config.authority.toString()).to.equal(authority.publicKey.toString());
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
          authority: authority.publicKey,
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

  it("updates protocol_fee_bps when authority calls update_config", async () => {
    await program.methods
      .updateConfig({
        protocolFeeBps: 2000,
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
        usdcMint: null,
      })
      .accounts({
        config: protocolPda,
        authority: authority.publicKey,
      })
      .signers([authority])
      .rpc();

    const config = await program.account.protocolConfig.fetch(protocolPda);
    expect(config.protocolFeeBps).to.equal(2000);
  });

  it("rejects protocol_fee_bps above ABSOLUTE_MAX (3000)", async () => {
    try {
      await program.methods
        .updateConfig({
          protocolFeeBps: 3500,
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
          usdcMint: null,
        })
        .accounts({ config: protocolPda, authority: authority.publicKey })
        .signers([authority])
        .rpc();
      expect.fail("Should have rejected");
    } catch (err: any) {
      expect(String(err)).to.match(/ConfigSafetyFloorViolation/);
    }
  });

  it("rejects withdrawal_cooldown below ABSOLUTE_MIN (3600)", async () => {
    try {
      await program.methods
        .updateConfig({
          protocolFeeBps: null,
          minPoolDeposit: null,
          defaultInsuranceRateBps: null,
          defaultMaxCoveragePerCall: null,
          minPremiumBps: null,
          withdrawalCooldownSeconds: new BN(1000),
          aggregateCapBps: null,
          aggregateCapWindowSeconds: null,
          claimWindowSeconds: null,
          maxClaimsPerBatch: null,
          paused: null,
          treasury: null,
          usdcMint: null,
        })
        .accounts({ config: protocolPda, authority: authority.publicKey })
        .signers([authority])
        .rpc();
      expect.fail("Should have rejected");
    } catch (err: any) {
      expect(String(err)).to.match(/ConfigSafetyFloorViolation/);
    }
  });

  it("rejects aggregate_cap_bps above ABSOLUTE_MAX (8000)", async () => {
    try {
      await program.methods
        .updateConfig({
          protocolFeeBps: null,
          minPoolDeposit: null,
          defaultInsuranceRateBps: null,
          defaultMaxCoveragePerCall: null,
          minPremiumBps: null,
          withdrawalCooldownSeconds: null,
          aggregateCapBps: 9000,
          aggregateCapWindowSeconds: null,
          claimWindowSeconds: null,
          maxClaimsPerBatch: null,
          paused: null,
          treasury: null,
          usdcMint: null,
        })
        .accounts({ config: protocolPda, authority: authority.publicKey })
        .signers([authority])
        .rpc();
      expect.fail("Should have rejected");
    } catch (err: any) {
      expect(String(err)).to.match(/ConfigSafetyFloorViolation/);
    }
  });

  it("rejects update_config from non-authority", async () => {
    const rando = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(rando.publicKey, 1_000_000_000);
    await provider.connection.confirmTransaction(sig);

    try {
      await program.methods
        .updateConfig({
          protocolFeeBps: 500,
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
          usdcMint: null,
        })
        .accounts({ config: protocolPda, authority: rando.publicKey })
        .signers([rando])
        .rpc();
      expect.fail("Should have rejected");
    } catch (err: any) {
      expect(String(err)).to.match(/Unauthorized|ConstraintHasOne|has_one/i);
    }
  });

  it("rejects min_pool_deposit below ABSOLUTE_MIN (1_000_000)", async () => {
    try {
      await program.methods
        .updateConfig({
          protocolFeeBps: null,
          minPoolDeposit: new BN(500_000),
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
          usdcMint: null,
        })
        .accounts({ config: protocolPda, authority: authority.publicKey })
        .signers([authority])
        .rpc();
      expect.fail("Should have rejected");
    } catch (err: any) {
      expect(String(err)).to.match(/ConfigSafetyFloorViolation/);
    }
  });

  it("rejects claim_window_seconds below ABSOLUTE_MIN (60)", async () => {
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
          claimWindowSeconds: new BN(10),
          maxClaimsPerBatch: null,
          paused: null,
          treasury: null,
          usdcMint: null,
        })
        .accounts({ config: protocolPda, authority: authority.publicKey })
        .signers([authority])
        .rpc();
      expect.fail("Should have rejected");
    } catch (err: any) {
      expect(String(err)).to.match(/ConfigSafetyFloorViolation/);
    }
  });
});
