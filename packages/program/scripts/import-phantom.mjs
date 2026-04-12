import bs58 from "bs58";
import fs from "fs";
import path from "path";
import os from "os";

const base58Key = process.argv[2];
if (!base58Key) {
  console.error("Usage: node import-phantom.mjs <base58-private-key>");
  process.exit(1);
}

const secret = bs58.decode(base58Key);
const outPath = path.join(os.homedir(), ".config/solana/phantom-devnet.json");
fs.writeFileSync(outPath, JSON.stringify(Array.from(secret)));
console.log("Saved to:", outPath);
