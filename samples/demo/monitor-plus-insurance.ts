// Pact Monitor + Insurance — Composed Integration
// Wire both SDKs together: monitor.fetch() records call reliability,
// PactInsurance owns the on-chain policy, and monitor.on("failure") lets
// the agent observe failures locally. Claims are submitted automatically
// by the backend when it sees a failed record — see below for manual
// submission.
//
// Run: pnpm --filter @pact-network/sample-demo exec tsx monitor-plus-insurance.ts <provider-hostname>
//
// Pre-reqs: see insurance-basic.ts, plus a running backend at $PACT_BACKEND_URL
// and $PACT_API_KEY bound to this agent's pubkey.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Keypair } from "@solana/web3.js";
import { pactMonitor } from "@q3labs/pact-monitor";
import { PactInsurance } from "@q3labs/pact-insurance";

const HOSTNAME = process.argv[2] || "api.coingecko.com";
const URL = `https://${HOSTNAME}/api/v3/simple/price?ids=solana&vs_currencies=usd`;
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const PROGRAM_ID =
  process.env.SOLANA_PROGRAM_ID || "2Go74eCvY8vCco3WPuteGzrhKz8v3R7Pcp5tjuFpcmN3";
const BACKEND_URL = process.env.PACT_BACKEND_URL || "http://localhost:3001";
const KEYPAIR_PATH =
  process.env.PACT_AGENT_KEYPAIR_PATH ||
  path.join(os.homedir(), ".config/solana/id.json");

const agent = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf-8"))),
);

// Insurance: on-chain policy and claim submission.
const insurance = new PactInsurance(
  { rpcUrl: RPC_URL, programId: PROGRAM_ID, backendUrl: BACKEND_URL, apiKey: process.env.PACT_API_KEY },
  agent,
);

// Monitor: wraps fetch(), syncs records to the backend. The keypair lets
// the SDK sign batches (anti-fraud). agentPubkey tags records for on-chain
// claim attribution.
const monitor = pactMonitor({
  apiKey: process.env.PACT_API_KEY,
  backendUrl: BACKEND_URL,
  syncEnabled: true,
  agentPubkey: agent.publicKey.toBase58(),
  keypair: { publicKey: agent.publicKey.toBytes(), secretKey: agent.secretKey },
});

// Observer: log failures locally. The backend auto-creates claims on failed
// records — this hook is for agent-side alerting/metrics, not for triggering
// claim submission.
monitor.on("failure", (record) => {
  console.warn(
    `[failure] ${record.classification} ${record.statusCode} @ ${record.hostname}`,
  );
});

const res = await monitor.fetch(URL, {}, { usdcAmount: 0.01 });
console.log(`[call] ${res.status} -> ${await res.text().then((t) => t.slice(0, 60))}...`);

// Optional: manually submit a claim for a specific record (e.g. retry path).
// await insurance.submitClaim(HOSTNAME, "<callRecordId-from-backend>");

const policy = await insurance.getPolicy(HOSTNAME);
console.log(
  `[policy] delegated=${policy?.delegatedAmount} claims_received=${policy?.totalClaimsReceived}`,
);

monitor.shutdown();
