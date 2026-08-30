/**
 * Composable test fixtures: bootstrap protocol + pool + policy + position
 * in one call so individual test files don't re-author the same setup
 * sequence.
 *
 * All ix-building goes through `@q3labs/pact-protocol-v2-client` builders
 * (locked decision — no hand-rolled payloads in tests; see plan).
 */
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { LiteSVM } from "litesvm";
import {
  PROGRAM_ID,
  buildCreatePoolIx,
  buildDepositIx,
  buildEnableInsuranceIx,
  buildInitializeProtocolIx,
  getCoveragePoolPda,
  getPolicyPda,
  getProtocolConfigPda,
  getUnderwriterPositionPda,
  getVaultPda,
} from "@q3labs/pact-protocol-v2-client";
import {
  airdrop,
  createTokenAccount,
  generateKeypair,
  mintTokensToAccount,
  sendAndExtractCode,
  setTokenDelegate,
  setupUsdcMint,
} from "./helpers.js";

export interface ProtocolSetup {
  authority: Keypair;
  oracle: Keypair;
  /** Owner of the treasury USDC ATA. */
  treasury: Keypair;
  /** Funded treasury ATA — receives the protocol fee cut on settle_premium. */
  treasuryAta: PublicKey;
  /** Mint authority for the test USDC token. */
  mintAuthority: Keypair;
  /** USDC mint pubkey (= `USDC_MINT_DEVNET`). */
  mint: PublicKey;
  configPda: PublicKey;
}

/**
 * Initialize ProtocolConfig + the canonical USDC mint + a Token-owned
 * treasury ATA. Returns the authority/oracle/treasury keypairs so callers
 * can sign downstream operations.
 *
 * Caller must have already invoked `loadProgram(svm, { bypass: true })`
 * — `initialize_protocol` rejects non-DEPLOYER signers without the
 * `unsafe-bypass-deployer` feature.
 */
export function setupProtocol(svm: LiteSVM): ProtocolSetup {
  const authority = generateKeypair(svm);
  const oracle = generateKeypair(svm);
  const treasury = generateKeypair(svm);
  const mintAuthority = generateKeypair(svm);
  const mint = setupUsdcMint(svm, mintAuthority);
  const treasuryAta = createTokenAccount(svm, mint, treasury.publicKey);

  const [configPda] = getProtocolConfigPda(PROGRAM_ID);

  const ix = buildInitializeProtocolIx({
    programId: PROGRAM_ID,
    configPda,
    deployer: authority.publicKey,
    authority: authority.publicKey,
    oracle: oracle.publicKey,
    treasury: treasury.publicKey,
    usdcMint: mint,
  });

  const code = sendAndExtractCode(svm, new Transaction().add(ix), authority);
  if (code !== undefined) {
    throw new Error(
      `setupProtocol: initialize_protocol failed with Custom(${code}). ` +
        `Did you call loadProgram(svm, { bypass: true }) first?`
    );
  }

  return { authority, oracle, treasury, treasuryAta, mintAuthority, mint, configPda };
}

export interface PoolSetup {
  hostname: string;
  poolPda: PublicKey;
  vaultPda: PublicKey;
}

/**
 * Create a pool for a given hostname. Triggers the on-chain
 * `InitializeAccount3` CPI (SPL Token Program is built into LiteSVM).
 */
export function setupPool(
  svm: LiteSVM,
  protocol: ProtocolSetup,
  hostname: string,
  opts: { insuranceRateBps?: number; maxCoveragePerCall?: bigint } = {}
): PoolSetup {
  const [poolPda] = getCoveragePoolPda(PROGRAM_ID, hostname);
  const [vaultPda] = getVaultPda(PROGRAM_ID, poolPda);

  const ix = buildCreatePoolIx({
    programId: PROGRAM_ID,
    configPda: protocol.configPda,
    poolPda,
    vaultPda,
    poolUsdcMint: protocol.mint,
    authority: protocol.authority.publicKey,
    hostname,
    insuranceRateBps: opts.insuranceRateBps,
    maxCoveragePerCall: opts.maxCoveragePerCall,
  });

  const code = sendAndExtractCode(svm, new Transaction().add(ix), protocol.authority);
  if (code !== undefined) {
    throw new Error(`setupPool(${hostname}): create_pool failed with Custom(${code})`);
  }

  return { hostname, poolPda, vaultPda };
}

export interface UnderwriterSetup {
  underwriter: Keypair;
  underwriterTokenAccount: PublicKey;
  positionPda: PublicKey;
  depositedLamports: bigint;
}

/**
 * Create an underwriter, fund their ATA with USDC, and deposit into the
 * pool. The deposit creates the UnderwriterPosition PDA.
 */
export function setupUnderwriter(
  svm: LiteSVM,
  protocol: ProtocolSetup,
  pool: PoolSetup,
  depositAmount: bigint
): UnderwriterSetup {
  const underwriter = generateKeypair(svm);
  const underwriterTokenAccount = createTokenAccount(
    svm,
    protocol.mint,
    underwriter.publicKey
  );
  mintTokensToAccount(svm, underwriterTokenAccount, depositAmount * 10n);

  const [positionPda] = getUnderwriterPositionPda(
    PROGRAM_ID,
    pool.poolPda,
    underwriter.publicKey
  );

  const ix = buildDepositIx({
    programId: PROGRAM_ID,
    configPda: protocol.configPda,
    poolPda: pool.poolPda,
    vault: pool.vaultPda,
    positionPda,
    underwriterTokenAccount,
    underwriter: underwriter.publicKey,
    amount: depositAmount,
  });

  const code = sendAndExtractCode(svm, new Transaction().add(ix), underwriter);
  if (code !== undefined) {
    throw new Error(`setupUnderwriter: deposit failed with Custom(${code})`);
  }

  return { underwriter, underwriterTokenAccount, positionPda, depositedLamports: depositAmount };
}

export interface PolicySetup {
  agent: Keypair;
  agentTokenAccount: PublicKey;
  policyPda: PublicKey;
  /** Delegated amount baked into the agent ATA (mimics SPL Approve). */
  delegatedAmount: bigint;
}

/**
 * Create an agent, fund their ATA, bake an `Approve` delegation to the
 * pool PDA (V2 reads delegate fields at fixed offsets — no real SPL
 * Approve CPI needed), and enable an insurance policy.
 *
 * `expiresAt` defaults to clock + 1 day so tests that don't care about
 * expiration get a sane fresh policy.
 */
export function setupPolicy(
  svm: LiteSVM,
  protocol: ProtocolSetup,
  pool: PoolSetup,
  opts: {
    agentId?: string;
    expiresAt?: bigint;
    delegatedAmount?: bigint;
    initialAtaBalance?: bigint;
    referrer?: { destination: PublicKey; shareBps: number };
  } = {}
): PolicySetup {
  const agent = generateKeypair(svm);
  const initialAta = opts.initialAtaBalance ?? 100_000_000n;
  const agentTokenAccount = createTokenAccount(
    svm,
    protocol.mint,
    agent.publicKey,
    initialAta
  );
  const delegatedAmount = opts.delegatedAmount ?? initialAta;
  setTokenDelegate(svm, agentTokenAccount, pool.poolPda, delegatedAmount);

  const [policyPda] = getPolicyPda(PROGRAM_ID, pool.poolPda, agent.publicKey);

  const now = svm.getClock().unixTimestamp;
  const expiresAt = opts.expiresAt ?? now + 86_400n;

  const ix = buildEnableInsuranceIx({
    programId: PROGRAM_ID,
    configPda: protocol.configPda,
    poolPda: pool.poolPda,
    policyPda,
    agentTokenAccount,
    agent: agent.publicKey,
    agentId: opts.agentId ?? "agent-test",
    expiresAt,
    referrer: opts.referrer,
  });

  const code = sendAndExtractCode(svm, new Transaction().add(ix), agent);
  if (code !== undefined) {
    throw new Error(`setupPolicy: enable_insurance failed with Custom(${code})`);
  }

  return { agent, agentTokenAccount, policyPda, delegatedAmount };
}
