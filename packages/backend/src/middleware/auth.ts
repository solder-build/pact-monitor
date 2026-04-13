import { createHash } from "crypto";
import type { FastifyRequest, FastifyReply } from "fastify";
import { getOne } from "../db.js";

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export async function requireApiKey(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    reply.code(401).send({ error: "Missing API key" });
    return;
  }

  const key = header.slice(7);
  const hash = hashKey(key);

  const row = await getOne<{ id: string; label: string; agent_pubkey: string | null }>(
    "SELECT id, label, agent_pubkey FROM api_keys WHERE key_hash = $1",
    [hash],
  );

  if (!row) {
    reply.code(401).send({ error: "Invalid API key" });
    return;
  }

  const r = request as FastifyRequest & {
    agentId: string;
    agentPubkey: string | null;
  };
  r.agentId = row.label;
  r.agentPubkey = row.agent_pubkey;
}

export { hashKey };
