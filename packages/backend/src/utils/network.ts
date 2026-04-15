import { Connection } from "@solana/web3.js";

// Genesis hashes are the canonical way to identify which Solana cluster an RPC
// endpoint is pointing at. Much safer than trusting SOLANA_RPC_URL env strings,
// which a misconfigured deploy could easily point at mainnet while env vars
// still say "devnet". See https://docs.solana.com/clusters for the authoritative
// list.
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const TESTNET_GENESIS = "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY";

export type SolanaNetwork =
  | "mainnet-beta"
  | "devnet"
  | "testnet"
  | "localnet"
  | "unknown";

let cachedNetwork: SolanaNetwork | null = null;

// Call once at server boot. Caches the result for the lifetime of the process
// so downstream checks (e.g. the faucet mainnet gate) are a synchronous lookup.
// On RPC failure we cache "unknown" and let callers fail closed — better to
// disable the faucet than to guess.
export async function detectAndCacheNetwork(
  connection: Connection,
): Promise<SolanaNetwork> {
  try {
    const genesis = await connection.getGenesisHash();
    if (genesis === MAINNET_GENESIS) cachedNetwork = "mainnet-beta";
    else if (genesis === DEVNET_GENESIS) cachedNetwork = "devnet";
    else if (genesis === TESTNET_GENESIS) cachedNetwork = "testnet";
    else cachedNetwork = "localnet"; // solana-test-validator etc.
  } catch {
    cachedNetwork = "unknown";
  }
  return cachedNetwork;
}

export function getCachedNetwork(): SolanaNetwork {
  // Default to "unknown" if detectAndCacheNetwork was never awaited. This
  // makes every "is this mainnet?" check on the hot path fail closed — the
  // faucet stays disabled until boot explicitly says otherwise.
  return cachedNetwork ?? "unknown";
}

export function isMainnet(): boolean {
  return getCachedNetwork() === "mainnet-beta";
}

// Exposed for tests only.
export function __resetNetworkCacheForTests(): void {
  cachedNetwork = null;
}

// Exposed for tests only — lets a test fast-path "we're on devnet" without
// spinning up a real RPC.
export function __setNetworkCacheForTests(value: SolanaNetwork): void {
  cachedNetwork = value;
}
