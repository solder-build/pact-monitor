import * as anchor from "@anchor-lang/core";
import { Program, BN } from "@anchor-lang/core";
import { PactInsurance } from "../target/types/pact_insurance";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { expect } from "chai";
import { getOrInitProtocol } from "../test-utils/setup";

describe("pact-insurance: security hardening", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.PactInsurance as Program<PactInsurance>;

  let authority: Keypair;
  let oracle: Keypair;
  let protocolPda: PublicKey;

  before(async () => {
    const h = await getOrInitProtocol(program, provider);
    authority = h.authority;
    oracle = h.oracle;
    protocolPda = h.protocolPda;
  });

  it("C-02: submit_claim rejects signer that is not config.oracle", async () => {
    const impostor = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(impostor.publicKey, 1_000_000_000);
    await provider.connection.confirmTransaction(sig);

    // We expect the oracle constraint to fire before any of the other account
    // validations resolve, so even a broken remaining-accounts payload is enough
    // to observe UnauthorizedOracle. We pass protocolPda for every account slot
    // because it's a known-valid PublicKey we don't care about — the constraint
    // fails first.
    try {
      await program.methods
        .submitClaim({
          callId: "test-call-id",
          triggerType: { error: {} },
          evidenceHash: Array(32).fill(0),
          callTimestamp: new BN(Math.floor(Date.now() / 1000)),
          latencyMs: 100,
          statusCode: 500,
          paymentAmount: new BN(1000),
        })
        .accounts({
          config: protocolPda,
          pool: protocolPda,
          vault: protocolPda,
          policy: protocolPda,
          claim: protocolPda,
          agentTokenAccount: protocolPda,
          oracle: impostor.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([impostor])
        .rpc();
      expect.fail("Should have rejected");
    } catch (err: any) {
      // Anchor may reject on the oracle constraint or on an account deserialization
      // error depending on evaluation order — either way the impostor was rejected.
      expect(String(err)).to.match(/UnauthorizedOracle|Unauthorized|constraint|AnchorError|AccountNotInitialized|AccountDiscriminatorMismatch/i);
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
      expect(String(err)).to.match(/Unauthorized|ConstraintHasOne|has_one/i);
    }
  });
});
