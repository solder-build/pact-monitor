import { createHash } from "node:crypto";
import type { FastifyRequest, FastifyReply } from "fastify";
import nacl from "tweetnacl";
import bs58 from "bs58";
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

  const row = await getOne<{ id: string; label: string; agent_pubkey: string | null; status: string }>(
    "SELECT id, label, agent_pubkey, status FROM api_keys WHERE key_hash = $1",
    [hash],
  );

  if (!row || row.status !== "active") {
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

const REQUIRE_SIGNATURES = process.env.REQUIRE_RECORD_SIGNATURES === "true";

export async function verifyRecordSignature(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const signature = request.headers["x-pact-signature"] as string | undefined;
  const pubkeyHeader = request.headers["x-pact-pubkey"] as string | undefined;

  if (!signature || !pubkeyHeader) {
    if (REQUIRE_SIGNATURES) {
      reply.code(401).send({ error: "Record signature required" });
      return;
    }
    // Grace period: accept unsigned
    return;
  }

  if (!/^[A-Za-z0-9+/]+=*$/.test(signature)) {
    reply.code(400).send({ error: "Malformed X-Pact-Signature (invalid base64)" });
    return;
  }

  const authed = request as FastifyRequest & { agentPubkey?: string };
  if (authed.agentPubkey && pubkeyHeader !== authed.agentPubkey) {
    reply.code(401).send({ error: "Signature pubkey does not match API key binding" });
    return;
  }

  try {
    const body = request.body as { records: unknown[] };
    if (!body.records || body.records.length === 0) return;
    const serialized = JSON.stringify(body.records, Object.keys(body.records[0] as object).sort());
    const hash = createHash("sha256").update(serialized).digest();
    const sigBytes = Buffer.from(signature, "base64");
    const pubkeyBytes = bs58.decode(pubkeyHeader);

    const valid = nacl.sign.detached.verify(hash, sigBytes, pubkeyBytes);
    if (!valid) {
      reply.code(401).send({ error: "Invalid record signature" });
      return;
    }
  } catch (err) {
    request.log.error({ err }, "Signature verification error");
    reply.code(401).send({ error: "Signature verification failed" });
    return;
  }
}

export { hashKey };
