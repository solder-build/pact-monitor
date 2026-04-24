#!/usr/bin/env node
// scripts/register-referrer.ts
//
// Admin CLI for the F1 manual-only referrer registration flow (PRD line
// 170-184). Calls the backend's admin-token-gated PATCH endpoint, which
// writes referrer_pubkey + referrer_share_bps atomically on an existing
// api_keys row. Two-step so all validation (share-bps range, pubkey shape)
// and the atomic write live in one place — the CLI is a thin wrapper.
//
// Usage
//   pnpm exec tsx scripts/register-referrer.ts \
//     --api-key-label=<label> \
//     --referrer-pubkey=<pubkey> \
//     --share-bps=<0..3000>
//
// Or clear:
//   pnpm exec tsx scripts/register-referrer.ts --api-key-label=<label> --clear
//
// Env
//   BACKEND_URL  default http://localhost:3001
//   ADMIN_TOKEN  required — must match the backend's ADMIN_TOKEN
//
// Exit codes
//   0  — registered (or cleared) successfully
//   1  — bad CLI args / local validation failed
//   2  — backend rejected the request (see stderr for details)

interface ParsedArgs {
  apiKeyLabel?: string;
  referrerPubkey?: string;
  shareBps?: number;
  clear: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { clear: false, help: false };
  // Accept --foo=bar and --foo bar forms; both `--api-key-label` and the PRD
  // spelling `--api-key-id` route to the same field.
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    const eq = raw.indexOf("=");
    const [key, valueInline] =
      eq >= 0 ? [raw.slice(0, eq), raw.slice(eq + 1)] : [raw, null];
    const value = valueInline ?? argv[++i];
    switch (key) {
      case "--api-key-label":
      case "--api-key-id":
      case "--label":
        out.apiKeyLabel = value;
        break;
      case "--referrer-pubkey":
        out.referrerPubkey = value;
        break;
      case "--share-bps":
      case "--referrer-share-bps":
        out.shareBps = parseInt(value, 10);
        break;
      case "--clear":
        out.clear = true;
        // --clear is a bare flag; step back so we don't consume the next arg.
        if (valueInline === null) i--;
        break;
      case "--help":
      case "-h":
        out.help = true;
        if (valueInline === null) i--;
        break;
      default:
        if (key.startsWith("--")) {
          console.error(`unknown flag: ${key}`);
        }
    }
  }
  return out;
}

function usage(): void {
  console.log(
    [
      "register-referrer.ts — attach a referrer to an api_keys row",
      "",
      "Register:",
      "  --api-key-label=<label>      api_keys.label of the key being updated",
      "  --referrer-pubkey=<pubkey>   Solana pubkey (base58)",
      "  --share-bps=<0..3000>        referrer cut in basis points (30% cap)",
      "",
      "Clear:",
      "  --api-key-label=<label> --clear",
      "",
      "Env:",
      "  BACKEND_URL  default http://localhost:3001",
      "  ADMIN_TOKEN  required",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    usage();
    process.exit(0);
  }
  if (!parsed.apiKeyLabel) {
    console.error("error: --api-key-label is required");
    usage();
    process.exit(1);
  }

  const backendUrl = process.env.BACKEND_URL ?? "http://localhost:3001";
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) {
    console.error("error: ADMIN_TOKEN env var is required");
    process.exit(1);
  }

  let body: {
    referrer_pubkey: string | null;
    referrer_share_bps: number | null;
  };

  if (parsed.clear) {
    if (parsed.referrerPubkey || parsed.shareBps !== undefined) {
      console.error("error: --clear is exclusive with --referrer-pubkey / --share-bps");
      process.exit(1);
    }
    body = { referrer_pubkey: null, referrer_share_bps: null };
  } else {
    if (!parsed.referrerPubkey) {
      console.error("error: --referrer-pubkey is required when registering");
      process.exit(1);
    }
    if (parsed.shareBps === undefined || Number.isNaN(parsed.shareBps)) {
      console.error("error: --share-bps is required when registering");
      process.exit(1);
    }
    // Local bounds check so we fail fast without a round-trip. Backend
    // enforces the same bounds in the UPDATE CHECK + explicit validation.
    if (
      !Number.isInteger(parsed.shareBps) ||
      parsed.shareBps < 0 ||
      parsed.shareBps > 3000
    ) {
      console.error(
        `error: --share-bps must be an integer in [0, 3000] (got ${parsed.shareBps})`,
      );
      process.exit(1);
    }
    if (
      parsed.referrerPubkey.length < 32 ||
      parsed.referrerPubkey.length > 48
    ) {
      console.error(
        `error: --referrer-pubkey length ${parsed.referrerPubkey.length} is not in the plausible Solana pubkey range (32..48)`,
      );
      process.exit(1);
    }
    body = {
      referrer_pubkey: parsed.referrerPubkey,
      referrer_share_bps: parsed.shareBps,
    };
  }

  const url = `${backendUrl}/api/v1/admin/api-keys/${encodeURIComponent(parsed.apiKeyLabel)}/referrer`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${adminToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    console.error(`backend rejected (${res.status}): ${text}`);
    process.exit(2);
  }

  console.log(text);
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(2);
});
