// Export a Solana CLI JSON keypair as a base58 private key string.
//
// Use this to get the value to paste into a GitHub secret / GCP Secret
// Manager / Cloud Run env var when the consumer expects a base58 private
// key (e.g. ORACLE_KEYPAIR_BASE58 for the backend).
//
// Usage:
//   node packages/program/scripts/export-keypair-base58.mjs <path-to-keypair.json>
//
// Examples:
//   node packages/program/scripts/export-keypair-base58.mjs packages/backend/.secrets/oracle-keypair.json
//   node packages/program/scripts/export-keypair-base58.mjs ~/.config/solana/phantom-devnet.json
//
// SECURITY:
//   - Output contains the FULL PRIVATE KEY of the keypair.
//   - Anyone with this string can sign as that keypair.
//   - Do NOT paste it in chat, commit it, or store it anywhere except
//     the secret manager you intend to use.
//   - Clear your terminal scrollback after copying.

import bs58 from "bs58";
import fs from "fs";
import path from "path";
import os from "os";

const arg = process.argv[2];
if (!arg) {
  console.error("Usage: node export-keypair-base58.mjs <path-to-keypair.json>");
  process.exit(1);
}

const expanded = arg.startsWith("~")
  ? path.join(os.homedir(), arg.slice(1))
  : arg;

if (!fs.existsSync(expanded)) {
  console.error(`File not found: ${expanded}`);
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(expanded, "utf-8"));
if (!Array.isArray(raw) || raw.length !== 64) {
  console.error(
    `Expected a Solana CLI JSON keypair (64-byte secret key array), got ${raw.length}-element ${typeof raw}`,
  );
  process.exit(1);
}

const secret = Uint8Array.from(raw);
const base58 = bs58.encode(secret);

// Print to stdout only — no file write, no log
process.stdout.write(base58 + "\n");
