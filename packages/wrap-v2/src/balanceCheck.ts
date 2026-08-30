// @pact-network/wrap-v2 — agent balance & allowance check.
//
// V2 uses the same SPL Token Approve delegation model as V1 — the policy
// records `agent_token_account` and the pool's `vault` is the delegate.
// This module is functionally identical to V1's balanceCheck.ts; copied
// here so wrap-v2 has zero runtime dependency on @pact-network/wrap.
//
// (Post-stabilization: extract to @pact-network/wrap-core; see plan Risk 6.)

export type BalanceCheckRejectionReason =
  | "insufficient_balance"
  | "insufficient_allowance"
  | "no_ata";

export type BalanceCheckResult =
  | { eligible: true; ataBalance: bigint; allowance: bigint }
  | {
      eligible: false;
      reason: BalanceCheckRejectionReason;
      ataBalance?: bigint;
      allowance?: bigint;
    };

export interface BalanceCheck {
  check(walletPubkey: string, requiredLamports: bigint): Promise<BalanceCheckResult>;
}

export interface DefaultBalanceCheckOptions {
  rpcUrl: string;
  resolveAta: (walletPubkey: string) => string | Promise<string>;
  /** TTL for the in-memory result cache, in milliseconds. Default 3_000. */
  cacheTtlMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface CacheEntry {
  expiresAt: number;
  ataBalance: bigint;
  allowance: bigint;
  noAta: boolean;
}

const DEFAULT_CACHE_TTL_MS = 3_000;

export function createDefaultBalanceCheck(
  opts: DefaultBalanceCheckOptions
): BalanceCheck {
  const cache = new Map<string, CacheEntry>();
  const ttl = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;

  async function load(walletPubkey: string): Promise<CacheEntry> {
    const ata = await opts.resolveAta(walletPubkey);

    const balanceResp = await rpc(fetchImpl, opts.rpcUrl, "getTokenAccountBalance", [
      ata,
      { commitment: "confirmed" },
    ]);
    if (balanceResp.error) {
      const msg = (balanceResp.error.message ?? "").toLowerCase();
      if (
        balanceResp.error.code === -32602 ||
        msg.includes("could not find") ||
        msg.includes("not found") ||
        msg.includes("invalid")
      ) {
        return {
          expiresAt: now() + ttl,
          ataBalance: 0n,
          allowance: 0n,
          noAta: true,
        };
      }
      throw new Error(
        `wrap-v2.balanceCheck: getTokenAccountBalance failed: ${balanceResp.error.message}`
      );
    }
    const ataBalance = BigInt(balanceResp.result?.value?.amount ?? "0");

    const accountResp = await rpc(fetchImpl, opts.rpcUrl, "getAccountInfo", [
      ata,
      { encoding: "jsonParsed", commitment: "confirmed" },
    ]);
    if (accountResp.error) {
      throw new Error(
        `wrap-v2.balanceCheck: getAccountInfo failed: ${accountResp.error.message}`
      );
    }
    const value = accountResp.result?.value;
    if (!value) {
      return {
        expiresAt: now() + ttl,
        ataBalance: 0n,
        allowance: 0n,
        noAta: true,
      };
    }
    const delegatedAmountStr =
      value?.data?.parsed?.info?.delegatedAmount?.amount ?? "0";
    const allowance = BigInt(delegatedAmountStr);

    return {
      expiresAt: now() + ttl,
      ataBalance,
      allowance,
      noAta: false,
    };
  }

  return {
    async check(
      walletPubkey: string,
      requiredLamports: bigint
    ): Promise<BalanceCheckResult> {
      const cached = cache.get(walletPubkey);
      let entry: CacheEntry;
      if (cached && cached.expiresAt > now()) {
        entry = cached;
      } else {
        entry = await load(walletPubkey);
        cache.set(walletPubkey, entry);
      }

      if (entry.noAta) {
        return { eligible: false, reason: "no_ata" };
      }
      if (entry.ataBalance < requiredLamports) {
        return {
          eligible: false,
          reason: "insufficient_balance",
          ataBalance: entry.ataBalance,
          allowance: entry.allowance,
        };
      }
      if (entry.allowance < requiredLamports) {
        return {
          eligible: false,
          reason: "insufficient_allowance",
          ataBalance: entry.ataBalance,
          allowance: entry.allowance,
        };
      }
      const debited: CacheEntry = {
        ...entry,
        ataBalance: entry.ataBalance - requiredLamports,
        allowance: entry.allowance - requiredLamports,
      };
      cache.set(walletPubkey, debited);
      return {
        eligible: true,
        ataBalance: entry.ataBalance,
        allowance: entry.allowance,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Minimal JSON-RPC client.
// ---------------------------------------------------------------------------

interface RpcResponse {
  result?: any;
  error?: { code: number; message: string };
}

async function rpc(
  fetchImpl: typeof fetch,
  url: string,
  method: string,
  params: unknown[]
): Promise<RpcResponse> {
  const resp = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!resp.ok) {
    throw new Error(`wrap-v2.balanceCheck: RPC ${method} returned ${resp.status}`);
  }
  return (await resp.json()) as RpcResponse;
}
