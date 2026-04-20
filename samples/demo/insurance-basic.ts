// Pact Insurance — Minimal On-Chain Integration
// Enable a parametric insurance policy, estimate per-call premium, read
// policy state. Pairs with @q3labs/pact-monitor but stands alone here.
//
// Run: pnpm --filter @pact-network/sample-demo exec tsx insurance-basic.ts <provider-hostname>
//
// Pre-reqs:
//   - A funded Solana keypair at $PACT_AGENT_KEYPAIR_PATH
//     (default ~/.config/solana/id.json) with SOL for fees and USDC in its ATA
//   - An existing pool on-chain for the target hostname (run seed-devnet-pools.ts)
//   - $SOLANA_RPC_URL and $SOLANA_PROGRAM_ID set, or use defaults below

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Keypair } from "@solana/web3.js";
import { PactInsurance } from "@q3labs/pact-insurance";

const HOSTNAME = process.argv[2] || "api.coingecko.com";
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const PROGRAM_ID =
  process.env.SOLANA_PROGRAM_ID || "2Go74eCvY8vCco3WPuteGzrhKz8v3R7Pcp5tjuFpcmN3";
const KEYPAIR_PATH =
  process.env.PACT_AGENT_KEYPAIR_PATH ||
  path.join(os.homedir(), ".config/solana/id.json");

const agent = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf-8"))),
);

const insurance = new PactInsurance({ rpcUrl: RPC_URL, programId: PROGRAM_ID }, agent);

// Enable a policy: delegate 10 USDC of premium budget for 30 days.
const sig = await insurance.enableInsurance({
  providerHostname: HOSTNAME,
  allowanceUsdc: 10_000_000n, // 10 USDC (6 decimals)
  expiresAt: BigInt(Math.floor(Date.now() / 1000) + 30 * 86400),
});
console.log(`[enable] policy active: ${sig.slice(0, 16)}...`);

// Estimate premium for a single $0.01 call against current insurance rate.
const estimate = await insurance.estimateCoverage(HOSTNAME, 10_000n);
console.log(
  `[estimate] rate=${estimate.rateBps}bps per-call=${estimate.perCallPremium} lamports`,
);

// Read policy state back from the chain.
const policy = await insurance.getPolicy(HOSTNAME);
console.log(
  `[policy] delegated=${policy?.delegatedAmount} calls_covered=${policy?.callsCovered}`,
);
