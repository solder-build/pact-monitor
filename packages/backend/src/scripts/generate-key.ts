import "dotenv/config";
import { randomBytes } from "crypto";
import { initDb, query, pool } from "../db.js";
import { hashKey } from "../middleware/auth.js";

const args = process.argv.slice(2);
const label = args[0] || "default";
const pkIdx = args.indexOf("--agent-pubkey");
const agentPubkey = pkIdx >= 0 ? args[pkIdx + 1] : null;

const key = `pact_${randomBytes(24).toString("hex")}`;
const hash = hashKey(key);

await initDb();
await query(
  "INSERT INTO api_keys (key_hash, label, agent_pubkey) VALUES ($1, $2, $3)",
  [hash, label, agentPubkey],
);
await pool.end();

console.log(`API key generated for "${label}":`);
console.log(key);
if (agentPubkey) {
  console.log(`Bound to agent pubkey: ${agentPubkey}`);
} else {
  console.log("WARNING: no --agent-pubkey given. On-chain claim submission will be skipped for this key.");
}
console.log("\nStore this key securely — it cannot be retrieved later.");
