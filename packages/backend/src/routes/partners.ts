// GET /api/v1/partners/:referrer_pubkey/policies (F1 read endpoint).
//
// Auth: either (a) the admin token, or (b) an API key whose referrer_pubkey
// column equals the path parameter — that is, the referrer looking at their
// own book. The PRD phrasing "auth via API key matching the referrer" is
// interpreted as: the caller's api_keys row has been registered as that
// referrer via the /api/v1/admin/api-keys/:label/referrer admin endpoint.
//
// Until the captain's Pinocchio port (WP-11.1/WP-12/WP-14) lands the
// on-chain referrer fields on Policy, policies-level data isn't available
// on the backend. We expose the documented schema now so integrators can
// start building against it; the `policies` array stays empty and the
// premium-side totals stay zero until the mirror arrives. `claims_paid_usdc`
// is populated from the already-landed `claims.referrer_pubkey` denormalized
// column, which is the only referrer signal currently on-chain-free.

import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { getOne, getMany } from "../db.js";

const SCHEMA_VERSION = 1;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const WINDOW_DAYS = 30;

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

async function authorize(
  request: FastifyRequest,
  reply: FastifyReply,
  referrerPubkey: string,
): Promise<boolean> {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    reply.code(401).send({ schema_version: SCHEMA_VERSION, error: "missing_auth" });
    return false;
  }
  const token = header.slice(7);

  // Admin token fast path.
  const adminToken = process.env.ADMIN_TOKEN ?? "";
  if (adminToken && token === adminToken) {
    return true;
  }

  // Otherwise the caller must hold an API key registered as this referrer.
  const row = await getOne<{ label: string; status: string }>(
    `SELECT label, status
       FROM api_keys
       WHERE key_hash = $1
         AND referrer_pubkey = $2
         AND status = 'active'`,
    [hashKey(token), referrerPubkey],
  );
  if (!row) {
    reply.code(401).send({
      schema_version: SCHEMA_VERSION,
      error: "invalid_auth",
      message: "Bearer token must be the admin token or an API key registered as this referrer",
    });
    return false;
  }
  return true;
}

interface ClaimRow {
  id: string;
  refund_amount: string | null;
  created_at: Date;
}

export async function partnersRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Params: { referrer_pubkey: string };
    Querystring: { cursor?: string; limit?: string };
  }>(
    "/api/v1/partners/:referrer_pubkey/policies",
    async (request, reply) => {
      const { referrer_pubkey } = request.params;

      // Basic pubkey shape guard — cheap, rejects obvious junk before any DB
      // work. Matches the length bounds used in admin/keys.
      if (
        typeof referrer_pubkey !== "string" ||
        referrer_pubkey.length < 32 ||
        referrer_pubkey.length > 48
      ) {
        return reply.code(400).send({
          schema_version: SCHEMA_VERSION,
          error: "invalid_referrer_pubkey",
        });
      }

      const ok = await authorize(request, reply, referrer_pubkey);
      if (!ok) return;

      // Pagination: ?cursor=<iso timestamp>&limit=N. cursor is opaque today
      // (isoformat of the oldest returned item's created_at) and will remain
      // opaque when the on-chain fields land — consumers must treat it as a
      // black box.
      const rawLimit = request.query.limit ? parseInt(request.query.limit, 10) : DEFAULT_LIMIT;
      const limit = Number.isFinite(rawLimit)
        ? Math.min(MAX_LIMIT, Math.max(1, rawLimit))
        : DEFAULT_LIMIT;
      const cursor = request.query.cursor;
      const cursorDate = cursor ? new Date(cursor) : null;
      if (cursor && cursorDate && Number.isNaN(cursorDate.getTime())) {
        return reply.code(400).send({
          schema_version: SCHEMA_VERSION,
          error: "invalid_cursor",
        });
      }

      const windowFrom = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
      const windowTo = new Date();

      // Policies listing: on-chain fields aren't backfilled yet, so this is
      // deliberately empty. Wiring the shape up now so the endpoint
      // contract is live.
      //
      // TODO(F1/WP-11.1): once the Policy account carries referrer +
      // referrer_share_bps, populate from a JOIN of claims ← policies (a
      // dedicated policies table will be introduced at that point).
      const policies: Array<{
        policy_pda: string;
        agent_pubkey: string;
        hostname: string;
        premium_usdc: string;
        referrer_cut_usdc: string;
        tx_hash: string;
        created_at: string;
      }> = [];

      // Claims paid: the only referrer-tagged totals available today.
      const claimRows = await getMany<ClaimRow>(
        `SELECT id, refund_amount, created_at
           FROM claims
           WHERE referrer_pubkey = $1
             AND created_at >= $2
             AND ($3::timestamptz IS NULL OR created_at < $3)
           ORDER BY created_at DESC
           LIMIT $4`,
        [referrer_pubkey, windowFrom.toISOString(), cursorDate, limit + 1],
      );

      const hasMore = claimRows.length > limit;
      const trimmed = hasMore ? claimRows.slice(0, limit) : claimRows;
      const nextCursor = hasMore
        ? trimmed[trimmed.length - 1].created_at.toISOString()
        : null;

      const claimsPaidRaw = trimmed.reduce(
        (acc, r) => acc + (r.refund_amount ? BigInt(r.refund_amount) : 0n),
        0n,
      );
      // 6-decimal USDC, rendered as a fixed decimal string for consistency
      // with the F2 premium endpoint + rest of the public API.
      const claimsPaidUsdc = formatUsdc(claimsPaidRaw);

      return reply.send({
        schema_version: SCHEMA_VERSION,
        referrer: referrer_pubkey,
        window: {
          from: windowFrom.toISOString(),
          to: windowTo.toISOString(),
        },
        totals: {
          policies_referred: 0,
          premium_usdc_total: "0.00",
          referrer_cut_usdc_total: "0.00",
          claims_paid_usdc: claimsPaidUsdc,
        },
        settlement: "on_chain",
        policies,
        pagination: {
          limit,
          next_cursor: nextCursor,
        },
      });
    },
  );
}

function formatUsdc(raw: bigint): string {
  // 6-decimal fixed-point. For a full product surface we'd use a real
  // decimal library; here a small helper keeps the dependency surface
  // tight. Negative values shouldn't occur (refund_amount is always ≥ 0).
  const abs = raw < 0n ? -raw : raw;
  const whole = abs / 1_000_000n;
  const frac = abs % 1_000_000n;
  const fracStr = frac.toString().padStart(6, "0");
  // Trim trailing zeros but keep at least 2 decimals for USD convention.
  const trimmed = fracStr.replace(/0+$/, "");
  const padded = trimmed.length < 2 ? trimmed.padEnd(2, "0") : trimmed;
  return `${raw < 0n ? "-" : ""}${whole.toString()}.${padded}`;
}
