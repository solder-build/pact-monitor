// Canonical hostname derivation. Strips protocol, path, query, and port when
// no alternate port is in use, lowercases, and returns the bare host.
//
// Motivation (Phase 5 / PRD F2): ingest previously called derivePoolPda with
// the raw base_url string, so api.helius.xyz and API.Helius.XYZ and
// https://api.helius.xyz/v0/webhooks all resolved to distinct pool PDAs. That
// fragmented the scoreboard, double-charged premium, and split referrer
// attribution. Every hostname-shaped input must be run through this function
// before it touches the DB or the PDA seed.
export function canonicalHostname(input: string): string {
  if (typeof input !== "string") {
    throw new TypeError("canonicalHostname: input must be a string");
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new Error("canonicalHostname: input must not be empty");
  }

  // URL parsing handles: scheme stripping, path stripping, userinfo stripping,
  // port normalization, and IDN punycode (via WHATWG URL).
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`canonicalHostname: invalid hostname '${input}'`);
  }

  const host = url.hostname.toLowerCase();
  if (host.length === 0) {
    throw new Error(`canonicalHostname: invalid hostname '${input}'`);
  }
  return host;
}
