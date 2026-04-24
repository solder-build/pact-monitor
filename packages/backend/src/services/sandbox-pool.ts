// Devnet sandbox keypair pool (F3).
//
// A small, fixed pool of pre-funded devnet keypairs that the sandbox endpoint
// rotates through. Each POST /api/v1/devnet/sandbox/inject-failure checks one
// out, fires a claim on its behalf, and releases it. When all keypairs are
// in-flight concurrently, the route returns 503 with Retry-After.
//
// Why fixed-size instead of lazy generation:
//   - pre-funding with SOL + USDC is manual ops via topup-sandbox-pool.sh.
//     Generating ad-hoc keypairs would push that cost to request time and
//     require the backend to hold a mint authority, which it doesn't.
//   - A fixed pool makes exhaustion observable (503 is better than silent
//     queueing). Ops can scale N via env + topup-sandbox-pool.sh.
//
// Loading priority (per-slot, parallel to oracle/faucet keypair loading in
// utils/solana.ts):
//   1. SANDBOX_KEYPAIRS_BASE58 — comma-separated base58 secret keys
//   2. SANDBOX_KEYPAIRS_DIR    — directory of JSON keypair files (lexical order)

import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import * as fs from "fs";
import * as path from "path";

export interface SandboxKeypairLease {
  keypair: Keypair;
  slot: number;
  release(): void;
}

export interface SandboxPoolStats {
  total: number;
  inUse: number;
  available: number;
}

export class SandboxKeypairPool {
  private readonly keypairs: Keypair[];
  private readonly inUse: boolean[];
  private nextIndex = 0;

  constructor(keypairs: Keypair[]) {
    if (keypairs.length === 0) {
      throw new Error("SandboxKeypairPool: at least one keypair required");
    }
    this.keypairs = keypairs;
    this.inUse = keypairs.map(() => false);
  }

  /**
   * Round-robin checkout. Returns null if all keypairs are currently leased
   * (route should translate to 503 + Retry-After).
   */
  checkout(): SandboxKeypairLease | null {
    for (let offset = 0; offset < this.keypairs.length; offset++) {
      const idx = (this.nextIndex + offset) % this.keypairs.length;
      if (!this.inUse[idx]) {
        this.inUse[idx] = true;
        this.nextIndex = (idx + 1) % this.keypairs.length;
        return {
          keypair: this.keypairs[idx],
          slot: idx,
          release: () => {
            // Idempotent release — calling twice is not an error (finally
            // blocks in async code sometimes run the release path twice after
            // a throw).
            this.inUse[idx] = false;
          },
        };
      }
    }
    return null;
  }

  stats(): SandboxPoolStats {
    const inUse = this.inUse.filter(Boolean).length;
    return {
      total: this.keypairs.length,
      inUse,
      available: this.keypairs.length - inUse,
    };
  }

  /** Exposed for tests. */
  pubkeys(): string[] {
    return this.keypairs.map((k) => k.publicKey.toBase58());
  }
}

function parseKeypairFile(filePath: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  if (
    !Array.isArray(raw) ||
    raw.length !== 64 ||
    !raw.every((b) => typeof b === "number" && b >= 0 && b <= 255)
  ) {
    throw new Error(
      `SandboxKeypairPool: invalid keypair file at ${filePath} (expected 64-byte JSON array)`,
    );
  }
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

export function loadSandboxKeypairsFromEnv(): Keypair[] {
  const base58List = process.env.SANDBOX_KEYPAIRS_BASE58;
  if (base58List && base58List.trim().length > 0) {
    return base58List
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => Keypair.fromSecretKey(bs58.decode(s)));
  }

  const dir = process.env.SANDBOX_KEYPAIRS_DIR;
  if (dir && dir.trim().length > 0) {
    const resolved = dir.startsWith("~")
      ? dir.replace(/^~/, process.env.HOME ?? "")
      : dir;
    const entries = fs
      .readdirSync(resolved)
      .filter((name) => name.endsWith(".json"))
      .sort();
    if (entries.length === 0) {
      throw new Error(
        `SandboxKeypairPool: no .json keypair files found in ${resolved}`,
      );
    }
    return entries.map((name) => parseKeypairFile(path.join(resolved, name)));
  }

  throw new Error(
    "SandboxKeypairPool: no keypairs configured. Set SANDBOX_KEYPAIRS_BASE58 (comma-separated) or SANDBOX_KEYPAIRS_DIR.",
  );
}

// Process-wide singleton so the in-flight set is shared across requests.
let singleton: SandboxKeypairPool | null = null;

export function getSandboxPool(): SandboxKeypairPool {
  if (!singleton) {
    singleton = new SandboxKeypairPool(loadSandboxKeypairsFromEnv());
  }
  return singleton;
}

export function __resetSandboxPoolForTests(): void {
  singleton = null;
}

export function __setSandboxPoolForTests(pool: SandboxKeypairPool): void {
  singleton = pool;
}
