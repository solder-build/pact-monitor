import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

// These tests deliberately skip the live-validator `mint_to` path. Unit scope
// here is:
//   - FAUCET_KEYPAIR_BASE58 / _PATH loader (mirror of the oracle loader tests)
//   - pubkey / amount validation rules
//   - network gate (mainnet + unknown must refuse)
//   - /api/v1/faucet/status payload shape under different network states
// The actual mint_to call is covered by manual testing against devnet on the
// hackathon timeline; a solana-test-validator integration harness is a
// follow-up if the faucet stays in the codebase.

describe("faucet keypair loader", () => {
  afterEach(async () => {
    const { __resetFaucetKeypairCacheForTests } = await import("../utils/solana.js");
    __resetFaucetKeypairCacheForTests();
  });

  test("loads from base58 (Cloud Run form)", async () => {
    const kp = Keypair.generate();
    const base58Secret = bs58.encode(kp.secretKey);

    const { loadFaucetKeypair } = await import("../utils/solana.js");
    const loaded = loadFaucetKeypair({
      rpcUrl: "http://127.0.0.1:8899",
      programId: "11111111111111111111111111111111",
      usdcMint: "11111111111111111111111111111111",
      faucetKeypairBase58: base58Secret,
    });
    assert.equal(loaded.publicKey.toBase58(), kp.publicKey.toBase58());
  });

  test("returns cached instance on subsequent calls", async () => {
    const kp = Keypair.generate();
    const base58Secret = bs58.encode(kp.secretKey);

    const { loadFaucetKeypair, __resetFaucetKeypairCacheForTests } = await import("../utils/solana.js");
    __resetFaucetKeypairCacheForTests();

    const cfg = {
      rpcUrl: "http://127.0.0.1:8899",
      programId: "11111111111111111111111111111111",
      usdcMint: "11111111111111111111111111111111",
      faucetKeypairBase58: base58Secret,
    };

    const a = loadFaucetKeypair(cfg);
    const b = loadFaucetKeypair(cfg);
    assert.strictEqual(a, b, "second call must return the cached keypair instance");
  });

  test("throws when neither base58 nor path is set", async () => {
    const { loadFaucetKeypair, __resetFaucetKeypairCacheForTests } = await import("../utils/solana.js");
    __resetFaucetKeypairCacheForTests();

    assert.throws(
      () =>
        loadFaucetKeypair({
          rpcUrl: "http://127.0.0.1:8899",
          programId: "11111111111111111111111111111111",
          usdcMint: "11111111111111111111111111111111",
        }),
      /FAUCET_KEYPAIR_BASE58.*FAUCET_KEYPAIR_PATH/,
    );
  });
});

describe("faucet validation", () => {
  test("validateRecipient accepts an ed25519 wallet pubkey", async () => {
    const { validateRecipient } = await import("../services/faucet.js");
    const kp = Keypair.generate();
    const pk = validateRecipient(kp.publicKey.toBase58());
    assert.equal(pk.toBase58(), kp.publicKey.toBase58());
  });

  test("validateRecipient rejects empty input", async () => {
    const { validateRecipient, InvalidRecipientError } = await import("../services/faucet.js");
    assert.throws(() => validateRecipient(""), InvalidRecipientError);
  });

  test("validateRecipient rejects gibberish", async () => {
    const { validateRecipient, InvalidRecipientError } = await import("../services/faucet.js");
    assert.throws(() => validateRecipient("not-a-pubkey"), InvalidRecipientError);
  });

  test("validateAmount accepts a whole-USDC integer in range", async () => {
    const { validateAmount } = await import("../services/faucet.js");
    assert.equal(validateAmount(1), 1);
    assert.equal(validateAmount(1_000), 1_000);
    assert.equal(validateAmount(10_000), 10_000);
  });

  test("validateAmount rejects zero, negatives, fractions, oversize", async () => {
    const { validateAmount, AmountOutOfRangeError } = await import("../services/faucet.js");
    assert.throws(() => validateAmount(0), AmountOutOfRangeError);
    assert.throws(() => validateAmount(-5), AmountOutOfRangeError);
    assert.throws(() => validateAmount(1.5), AmountOutOfRangeError);
    assert.throws(() => validateAmount(10_001), AmountOutOfRangeError);
  });

  test("validateAmount rejects non-number input", async () => {
    const { validateAmount, AmountOutOfRangeError } = await import("../services/faucet.js");
    assert.throws(() => validateAmount("1000" as unknown as number), AmountOutOfRangeError);
    assert.throws(() => validateAmount(null as unknown as number), AmountOutOfRangeError);
    assert.throws(() => validateAmount(undefined), AmountOutOfRangeError);
  });
});

describe("faucet network gate", () => {
  afterEach(async () => {
    const { __resetNetworkCacheForTests } = await import("../utils/network.js");
    __resetNetworkCacheForTests();
  });

  test("getFaucetStatus returns enabled:false on mainnet-beta", async () => {
    const { __setNetworkCacheForTests } = await import("../utils/network.js");
    __setNetworkCacheForTests("mainnet-beta");

    // getFaucetStatus reads getSolanaConfig() which requires program id + mint
    // envs; set minimal valid values so the test doesn't explode on missing
    // config before reaching the network check.
    process.env.SOLANA_PROGRAM_ID = "11111111111111111111111111111111";
    process.env.USDC_MINT = "11111111111111111111111111111111";

    const { getFaucetStatus } = await import("../services/faucet.js");
    const status = getFaucetStatus();
    assert.equal(status.enabled, false);
    assert.equal(status.network, "mainnet-beta");
    assert.match(status.reason ?? "", /devnet-only/i);
  });

  test("getFaucetStatus returns enabled:false on unknown network", async () => {
    const { __setNetworkCacheForTests } = await import("../utils/network.js");
    __setNetworkCacheForTests("unknown");

    process.env.SOLANA_PROGRAM_ID = "11111111111111111111111111111111";
    process.env.USDC_MINT = "11111111111111111111111111111111";

    const { getFaucetStatus } = await import("../services/faucet.js");
    const status = getFaucetStatus();
    assert.equal(status.enabled, false);
    assert.equal(status.network, "unknown");
    assert.match(status.reason ?? "", /safety default/i);
  });

  test("getFaucetStatus returns enabled:false on devnet when keypair env is missing", async () => {
    const { __setNetworkCacheForTests } = await import("../utils/network.js");
    __setNetworkCacheForTests("devnet");

    process.env.SOLANA_PROGRAM_ID = "11111111111111111111111111111111";
    process.env.USDC_MINT = "11111111111111111111111111111111";
    delete process.env.FAUCET_KEYPAIR_BASE58;
    delete process.env.FAUCET_KEYPAIR_PATH;

    const { getFaucetStatus } = await import("../services/faucet.js");
    const status = getFaucetStatus();
    assert.equal(status.enabled, false);
    assert.match(status.reason ?? "", /FAUCET_KEYPAIR/);
  });

  test("getFaucetStatus returns enabled:true on devnet with keypair set", async () => {
    const { __setNetworkCacheForTests } = await import("../utils/network.js");
    __setNetworkCacheForTests("devnet");

    process.env.SOLANA_PROGRAM_ID = "11111111111111111111111111111111";
    process.env.USDC_MINT = "11111111111111111111111111111111";
    process.env.FAUCET_KEYPAIR_BASE58 = bs58.encode(Keypair.generate().secretKey);

    const { getFaucetStatus } = await import("../services/faucet.js");
    const status = getFaucetStatus();
    assert.equal(status.enabled, true);
    assert.equal(status.network, "devnet");
    assert.equal(status.maxPerDrip, 10_000);
    assert.equal(status.minPerDrip, 1);

    delete process.env.FAUCET_KEYPAIR_BASE58;
  });

  test("dripUsdc throws FaucetDisabledError on mainnet without touching RPC", async () => {
    const { __setNetworkCacheForTests } = await import("../utils/network.js");
    __setNetworkCacheForTests("mainnet-beta");

    process.env.SOLANA_PROGRAM_ID = "11111111111111111111111111111111";
    process.env.USDC_MINT = "11111111111111111111111111111111";

    const { dripUsdc, FaucetDisabledError } = await import("../services/faucet.js");
    await assert.rejects(
      () =>
        dripUsdc({
          recipient: Keypair.generate().publicKey.toBase58(),
          amount: 100,
        }),
      FaucetDisabledError,
    );
  });

  test("dripUsdc throws FaucetDisabledError when network is unknown", async () => {
    const { __setNetworkCacheForTests } = await import("../utils/network.js");
    __setNetworkCacheForTests("unknown");

    process.env.SOLANA_PROGRAM_ID = "11111111111111111111111111111111";
    process.env.USDC_MINT = "11111111111111111111111111111111";

    const { dripUsdc, FaucetDisabledError } = await import("../services/faucet.js");
    await assert.rejects(
      () =>
        dripUsdc({
          recipient: Keypair.generate().publicKey.toBase58(),
          amount: 100,
        }),
      FaucetDisabledError,
    );
  });
});
