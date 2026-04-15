// One-off: create a Phantom-owned test USDC mint on devnet.
// Run from packages/program/: node scripts/create-test-mint.mjs
//
// Outputs PACT_TEST_USDC_MINT=<pubkey>. Save it — it'll be baked into init-devnet.ts.
import { Connection, Keypair } from "@solana/web3.js";
import { createMint } from "@solana/spl-token";
import { readFileSync } from "fs";
import { homedir } from "os";

const phantom = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/solana/phantom-devnet.json`, "utf8")))
);
const conn = new Connection("https://api.devnet.solana.com", "confirmed");
console.log("Phantom:", phantom.publicKey.toBase58());
const mint = await createMint(conn, phantom, phantom.publicKey, null, 6);
console.log(`PACT_TEST_USDC_MINT=${mint.toBase58()}`);
